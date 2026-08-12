# Norma — Follow-Ups After the Initial Build

All 17 planned tasks are complete and the final whole-branch review is clean. This file records what was deliberately left for later, so the decisions are not lost when the build's scratch workspace is deleted.

Nothing here blocks merge. Items are grouped by theme, in rough priority order.

## A. Selector calibration against real footage

The frame selector works — verified end-to-end on an adversarial synthetic fixture, where a slide's text change was picked first (importance 0.594 versus ~0.28 for noise frames) while caption churn and a moving distractor produced no false picks. What has never been tested is real, compressed, noisy video. Do not tune these blind; gate on the first real acceptance-matrix run.

- **Quality weight is likely too high at 0.25.** After the quality filter rejects bad frames, surviving scores have a floor around 0.32, so the usable spread is worth up to 0.17 of a frame's score — roughly half the influence of text novelty. Worse, the metric is Laplacian variance, which measures *edge density* rather than focus: dense-text frames saturate at 1.0 while a perfectly focused face or sky sits near 0.4–0.6. That is a systematic bias toward busy frames, double-counting what text novelty already captures. Suggested: `0.45 / 0.40 / 0.15`, which lands close to the design spec's implied ratios and stays strictly distinct so the weight-ordering test survives. Bump `SELECTOR_VERSION` if changed — every emitted `importance` shifts.
- **Semantic novelty was folded entirely into the dynamic similarity penalty.** The spec listed it as the largest single term. The consequence: a within-shot change with no cut and no text — an object simply appearing — scores almost nothing intrinsically, because heartbeat frames carry zero scene significance. A small static term using cosine distance to the previous candidate's embedding would close this, and the embedding is already computed.
- The greedy loop is O(n·k²·d) rather than O(n·k·d); it recomputes similarity against all picked frames each round. Measured 329 ms at spec scale (600 candidates, 50 picks). Not harmful now; both max and min are monotone, so caching per-candidate values updated only against the newly-picked frame would fix it.
- `semantic_change` is emitted as a reason for embedding-less frames and for every first pick, since max-similarity is 0 against an empty set. Misleading when there is no embedding to judge by.
- `new_scene`'s 0.3 threshold rarely fires for real cuts, which land near 0.15–0.2 normalized, so reasons under-report scene-driven picks.

## B. Candidate generation and end-of-file edges

One small pull request covers all of these.

- A scene boundary within ~100 ms of the video's end can produce a sample at or *before* the boundary itself, violating the design rule that samples must come after a cut. The frame then shows the old scene while carrying the new scene's id and significance — trading a silently dropped frame for a silently mislabeled one.
- The end-of-video margin is a constant 0.1 s, empirically tuned at 25 fps and **proven insufficient at low frame rates**: on a 1 fps fixture, seeks at the duration, at the margin, and well inside all fail; only the last frame's actual presentation time succeeds. The margin should scale with frame duration (1/fps).
- The dedup window is a fixed 0.5 s and is not scaled to the heartbeat interval, so sub-second heartbeats collapse non-uniformly.
- `sceneIdAt` is used only for heartbeat items and no test asserts a heartbeat candidate's scene id, so an off-by-one there would ship undetected.

## C. Temporary-artifact lifetime

Decide one policy and document it, rather than fixing piecemeal.

`Manifest.source.filePath` and `frames[].image` both point into a working directory that nothing cleans up. That is deliberate — those paths are the coarse-to-fine handoff and must outlive the call — so "delete eagerly" is the wrong answer. What is missing is a documented lifetime contract: a caller currently cannot tell that these paths are temp-scoped and could be reaped by the OS between an analysis and a later `get_clip`. One clause in the type's doc comment would fix it. Related loose ends: default-`outDir` work files are never cleaned, and `get_frame`/`get_clip` never pass `outDir` through from MCP, so each call creates its own directory.

## D. Degradation visibility

`processing.warnings` now exists and records dead OCR, dead embeddings, and ASR failure. Two gaps remain: the ASR-failure line has no test, and a partial-embedding drop (where some frames embedded and others did not) removes candidates with no warning recorded.

## E. Architecture promised but not delivered

State these explicitly rather than leaving them implicit:

- The spec described `transcribe_video` and `extract_keyframes` as agent-facing primitives. Four MCP tools shipped and these two were dropped without being recorded as deferred.
- The spec's WeChat activation experience — Keychain persistence, assisted login, an expiry probe — is currently an environment variable discoverable only by reading source. The headless resolution protocol itself is validated and working.
- **The acceptance matrix is a smoke matrix, not an acceptance judge.** It compares returned status against an expected status and nothing more. A passing row proves the URL was reachable and ended in the expected state; it does not prove the claim named in its "proves" column. Rows asserting that subtitle-aware selection avoids over-selecting, or that WeChat routes to the Chinese speech model, would pass without ever inspecting frames or the transcript's language. Strengthening the assertions is worth doing before treating a green matrix as evidence.

## F. Known residual risks

- **Real-platform behavior is unproven.** The caption-acquisition rewrite was verified against the installed yt-dlp's own source and a faithful fake, but never against a live platform. Running the matrix with real URLs is the necessary next step.
- When yt-dlp performs a sectioned download, it snaps to keyframes and may start slightly before the requested point, so caption re-basing can be off by up to ~1.5 s. This is a small constant offset, not the range-sized misalignment that was fixed.
- Automatic-caption track ordering can prefer a machine-translated English track over the original language when no preference and no platform hint are available.
- There is no CI, and no CI would fetch the roughly 1.5 GB of models, so the model-backed integration tests will skip in any automated run. The real speech and embedding integration currently rests on local execution.

## G. Range parameters require both bounds

`resolve_video` and `analyze_video` both gate range extraction on `start` **and** `end` being supplied together (`src/resolve/ytdlp.ts`, `src/analyze.ts`, `src/agent/resolveTool.ts`). Passing just one is silently treated as no range at all — the whole video is fetched/analyzed rather than "from here to the end" or "from the start to here." Treating a lone `start` as "to the end of the video" (or a lone `end` as "from the start") is a reasonable alternative and was considered; requiring both is a deliberate current limitation, not an oversight, and the tool descriptions now say so explicitly rather than leaving it for a caller to discover by surprise.
