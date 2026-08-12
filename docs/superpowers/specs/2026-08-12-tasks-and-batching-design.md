# Background Tasks and Multi-Video Batching — Design

**Date:** 2026-08-12
**Status:** Approved, pending implementation
**Ships as:** 0.2.0
**Amends:** the MCP surface described in `2026-08-11-norma-agent-surface-v2-design.md`. Everything below the agent layer — pipeline, resolvers, transcript tiers, selector — is unchanged except where §8 names it.

---

## 1. Why

Both problems are agent-workflow problems, not engine problems.

**A long analysis blocks the whole agent.** `analyze_video` on a real video runs for minutes — download, transcription, vision. A plain MCP call pins the agent for that whole time. MCP now has an (experimental) tasks capability built for exactly this: the call returns a handle immediately, the server pushes `notifications/tasks/status`, and the result is fetched when ready. The agent does other work in between — the same shape as a harness-level background subagent, but at the protocol level.

**One video per call forces artificial call fan-out.** An agent wanting two videos — or two sections of two different videos — must issue two calls with no shared handle. Batching folds them into one call: one `destinationPath`, one background decision, per-video parameters.

These compose: a batched call marked as a task is **one task, one handle, one notification stream** covering all its videos. "Run in background" is not a schema parameter — the *client* marks the call as task-augmented — so the whole batch is inherently backgrounded or not as a unit.

## 2. What ships

1. Both tools become **task-capable** with `taskSupport: 'optional'` — a plain call behaves exactly as today; a task-augmented call returns a handle.
2. Both tools accept a **`videos` array** (min 1) of per-video parameter objects, replacing the single top-level `url`/`pathOrUrl`. This is a breaking schema change; 0.2.0 covers it, and MCP clients read schemas fresh per session, so nothing is compiled against the old shape.

## 3. The schemas

```ts
resolve_video({
  destinationPath: string,          // top-level, shared
  videos: [{                        // min 1 item
    url: string,                    // required per item
    returnVideo?: boolean,          // default false
    start?: number, end?: number,   // only with returnVideo
    comments?: boolean,             // default false
  }],
})

analyze_video({
  destinationPath: string,          // top-level, shared
  videos: [{                        // min 1 item
    pathOrUrl: string,              // required per item
    start?: number, end?: number,
    frames?: 'key' | 'even' | 'none',
    maxFrames?: number,
    transcript?: boolean,
    language?: string,
  }],
})
```

A single video is a one-element array. There is deliberately **no union** of "either `url` or `videos`" — mutually exclusive parameter pairs are the trap the v2 redesign removed, so there is exactly one way to express a request. An empty array is a schema rejection, not a handled case.

`maxFrames: 0` keeps its v2 meaning per item (alias for `frames: 'none'` when `frames` is omitted; an explicit `frames` wins).

## 4. Output layout

- **One video:** written flat into `destinationPath`, byte-for-byte today's layout. Existing single-video behavior, artifact naming, idempotency rules, and tests are untouched.
- **Multiple videos:** each item writes into `destinationPath/video-1/`, `video-2/`, … (1-based, array order), each subdirectory an exact copy of the single-video layout. This is what prevents two different URLs fighting over the single `metadata.json` the idempotency design mandates per directory.

Every path is returned explicitly per item, so no agent ever derives the layout. Re-running the same call overwrites the same subdirectories — the v2 idempotency rule, per item.

The conditional layout (flat at N=1, subdirs at N>1) is deliberate: the common case keeps today's documented shape, and replies always carry exact paths, so nothing guesses.

## 5. Results and partial failure

The reply is a **per-item array of exactly today's single-video result shape**, in array order. Video A can be `ok` while video B is `unsupported` — each item carries its own honest `status`, `warnings`, and paths. The call itself (and the task, in task mode) always completes; there is no batch-level failure status to interpret.

For tasks, the result is delivered once, complete, via `tasks/result` when the task reaches `completed`. Per-item progress during execution is visible through `statusMessage` (§7), not through partial results.

## 6. Concurrency and memory

**The slot pool.** `VIDEO_EXTRACT_MAX_CONCURRENCY` (default **4**) caps how many `analyze_video` *item executions* run at once, across all calls — plain and task calls both count, because a plain call burns the same CPU and RAM. Work beyond the cap queues (unbounded — a queued item is a closure plus arguments, kilobytes) in FIFO order. A queued task reports `working` with `statusMessage: "queued, N ahead"`. A plain call that queues simply blocks longer, exactly as it would under CPU contention today.

**`resolve_video` ignores the cap entirely.** It loads no models; it is network and ffmpeg. Throttling downloads behind transcriptions would help nothing.

**Batch items feed the same pool as separate calls.** A 3-video batch at cap 4 runs all three in parallel; at cap 1 they run sequentially. Batching changes the surface and gives one handle; it never changes resource behavior.

**The memory claim changes from a ceiling to a rate.** Nothing in the code enforces 2 GB and nothing ever did — the figure was a *measured property* of the staged-worker architecture, and it is already per-call: each analysis peaks at ~1.1 GB regardless of video length, because the number is model weights, not video data. What concurrency changes is the multiplier. The honest public claim, everywhere it appears (README, spec, CLAUDE.md, descriptions):

> ~1.1 GB peak per concurrent analysis; total footprint ≈ concurrency × 1.1 GB. Default cap 4 ⇒ plan for ~4.5 GB worst case. `VIDEO_EXTRACT_MAX_CONCURRENCY=1` restores the old flat under-2GB behavior.

More memory does **not** make a video process faster — the resident set is fixed-size model weights; speed is CPU- and network-bound. Concurrency buys throughput, not per-video latency. The within-call staging (ASR worker exits before the vision worker starts) is unchanged and still holds per item.

## 7. Progress

`AnalyzeOptions` gains an optional `onStage?: (stage: string) => void`. The pipeline invokes it at existing seams — `'resolving'` before the resolver runs, `'transcribing'` before the transcript stage when one will run, `'frames'` before the frame stage when one will run. Nothing else in the pipeline changes; plain callers and the CLI simply don't pass it.

The task wrapper maps stages to `updateTaskStatus(taskId, 'working', message)`, prefixing batch position: `"video 2/3: transcribing"`. `resolve_video` has no internal seams worth reporting and never queues (§6); its tasks simply report `working` until done.

## 8. Failure and cancellation semantics

**One error model, not two.** Tasks always reach `completed`, and the stored result carries the honest per-item `status` exactly as today — a DRM page is a *completed task* whose result says `unsupported`. Task-`failed` is reserved for the wrapper itself breaking (task store errors, a bug in the queue). Anything else would fork the no-throw contract the whole surface is built on.

**Cancellation is honest or absent.** `tasks/cancel` on a **queued** task works fully: removed from the queue, status `cancelled`, never executed. `tasks/cancel` on a **running** task is refused with a clear message — correctly killing a mid-flight yt-dlp/ffmpeg/worker process tree is real work, and a task that reports `cancelled` while quietly finishing its download is exactly the dishonesty class this project exists to kill. Real cancellation of running work is deferred and recorded in `docs/follow-ups.md`.

## 9. Artifact lifetime

**The tool never deletes anything under `destinationPath`.** The caller named the directory; the caller owns it. This is the common practice for file-producing MCP servers, and this project has specific history here: the v2 final review's Critical #1 was this tool destroying a caller's file, and the fix established a tested invariant — *every path returned in a reply or manifest still exists after the call completes*. A cleanup timer would reintroduce that class deliberately. Internal intermediates (`work.wav`, `work.mp4`) keep being cleaned as today; requested outputs are never touched.

An agent that wants ephemeral output picks a temp directory and lets the OS reap it. An agent that wants durable output picks a real path and can rely on it.

**The task TTL applies to the in-memory task handle only, never to files.** Handles expire `VIDEO_EXTRACT_TASK_TTL_MS` after completion (default 30 minutes) and die with the server process regardless; the artifacts at `destinationPath` are the durable result and survive both. The tool descriptions state both halves explicitly, so an agent can rely on it rather than infer it.

## 10. SDK pinning

The tasks API lives under `experimental/` and its own headers say "may change without notice." Experimental surfaces are not covered by semver, so `"^1.30.0"` would let a user's fresh install pull a breaking 1.31 while the local checkout still works. The dependency is pinned to exactly `"1.30.0"` **in the same commit** that first imports from `experimental/`. Upgrades become deliberate, tested events.

## 11. Verified API facts (so the plan does not re-derive them)

Verified against the installed SDK 1.30.0's `.d.ts`, not assumed:

- Registration: `server.experimental.tasks.registerToolTask(name, config, handler)` where `config.execution: { taskSupport }` and `handler` is `{ createTask, getTask, getTaskResult }`.
- `createTask` receives `extra.taskStore` (`RequestTaskStore`): `createTask({ttl})`, `getTask(taskId)`, `storeTaskResult(taskId, 'completed' | 'failed', result)`, `getTaskResult(taskId)`, `updateTaskStatus(taskId, status, statusMessage?)`.
- A ready-made `InMemoryTaskStore` exists at `experimental/tasks/stores/in-memory`.
- `TaskStatus` = `working | input_required | completed | failed | cancelled`.
- `notifications/tasks/status` is a genuine server push; `tasks/get`, `tasks/list`, `tasks/status`, `tasks/result`, `tasks/cancel` exist for polling and control.
- `CallToolResult` is a union with a task-handle branch (already noted in `tests/mcp.test.ts`'s comments).
- An experimental tasks **client** ships in the SDK (`experimental/tasks/client`), usable for tests.

## 12. The implementation risks worth naming

1. **The `taskSupport: 'optional'` linchpin.** `server/mcp.d.ts` says the server "handles automatic task polling for tools with taskSupport 'optional'" — implying a plain caller of a task-registered tool gets a normal synchronous result, and we implement only the task-handler triple. **If that reading is wrong, the design changes**, so the first implementation step is an empirical spike: register a task tool, call it with a vanilla `client.callTool()` over `InMemoryTransport`, observe the result shape. Nothing else builds until this is confirmed.
2. **The queue must gate plain calls too.** A plain `analyze_video` call arriving while 4 tasks run must wait for a slot, or the cap is fiction. One semaphore, both entry paths.
3. **Notification wiring is unverified.** Whether `updateTaskStatus` auto-emits `notifications/tasks/status` or the handler must send it is not determinable from the `.d.ts` alone — the spike answers this too.
4. **The tool descriptions are the contract.** Task behavior, queue semantics, the artifacts-never-deleted guarantee, batch usage, and the memory rate all need description text, reviewed as seriously as code.

## 13. Testing

- **The spike test (risk 1) first**, kept as a permanent regression test: plain call on a task-registered tool returns today's result shape.
- Full task lifecycle over the SDK's own client and `InMemoryTransport`: create → `working` → notification → `completed` → `tasks/result` matches the plain-call result for the same input.
- Queue: at cap, an (N+1)th analyze item holds in `working`/queued; slot frees → it runs. Cap 1 forces strictly sequential execution, observable via `onStage` ordering.
- Cancel: queued task cancels and never executes (throw-if-executed mock); running task's cancel is refused and the task still completes.
- Batch: partial failure (item 1 ok, item 2 unresolvable) yields per-item statuses in one completed result; `video-N/` layout appears exactly at N>1; single-video layout byte-identical to today's.
- Memory: with cap 1, the existing staged-memory measurement holds unchanged (regression guard on the §6 claim).
- Mutation duty per house rules: mutants must include queue-bypass (plain call skips the semaphore), cancel-running-pretends-to-cancel, batch-items-share-one-directory, and TTL-deletes-files.

## 14. Out of scope

Real cancellation of running work (process-tree kill); a durable task store surviving server restarts; batch support in the CLI (single-video flags stay; library callers loop); per-call RSS *enforcement* (monitor-and-kill) as opposed to the measured claim; partial result delivery for batches before completion.
