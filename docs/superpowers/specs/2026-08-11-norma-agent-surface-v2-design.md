# Norma Agent Surface v2 — Design

**Date:** 2026-08-11
**Status:** Approved, pending implementation
**Supersedes:** the MCP layer described in §18 of `2026-08-10-norma-video-extract-design.md`. Everything below that layer — resolvers, media pipeline, transcript tiers, selector, manifest — is unchanged.

---

## 1. Why change a working surface

The v1 surface shipped four tools: `analyze_video`, `resolve_video`, `get_frame`, `get_clip`. It works, but three problems showed up once it was written down and read as an agent would read it.

**The local-path/URL split is a trap.** `get_frame` and `get_clip` take a local filesystem path and fail on a URL. The shipped descriptions say so in capitals, three separate times, because it is the single most likely mistake — which is evidence the design is wrong, not that the warning needs to be louder.

**`fps` and `maxFrames` are the same knob.** Sampling a 60–90s window at 2fps and asking for 60 frames across that window are the same request. Two parameters expressing one idea invite contradictory combinations.

**Two tools were doing what one parameterization does.** A single frame is a range where start equals end with a budget of one. A dense clip is a range with an even-sampling strategy. Both are `analyze_video` with different arguments.

Against that, one thing v1 got right and v2 keeps: **`resolve_video` stays a separate tool.** Collapsing it in would give one tool a description advertising analysis, transcription, frame selection *and* video downloading. Strong models would cope; weaker open-weight models routing on tool descriptions would not. A narrow tool that only fetches a video is also independently useful — when the user simply asks for a download, or when an agent intends to process the media its own way.

## 2. The two tools

### 2.1 `resolve_video`

Fetches a video's metadata, and optionally the video itself, to a caller-chosen directory.

```
resolve_video(
  url:             string    // required
  destinationPath: string    // required
  returnVideo:     boolean   // default FALSE
  start:           number?   // seconds; only meaningful when returnVideo is true
  end:             number?   // seconds; only meaningful when returnVideo is true
  comments:        boolean   // default false
)
```

**`start`/`end` fetch only a section of the media.** This closes the loop opened by chapters: an agent reads the chapter list from a metadata-only call, sees the demonstration begins at 12:04, and fetches just that section rather than the whole video. The same source-dependent behaviour from §5 applies — genuinely partial for yt-dlp sources, full-download-then-trim for direct URLs and WeChat. Both are ignored when `returnVideo` is false, since there is no media to bound.

**`returnVideo` defaults to false.** The common first call is "tell me about this video" — cheap, fast, and often enough to decide what to do next. Downloading media is the opt-in.

**Inline result** (what the agent sees immediately):

- `title`
- `creator` (uploader/channel)
- `duration`
- `chapters` — start, end and title per chapter, when the platform provides them
- `descriptionPreview` — first ~125 characters of the description, the portion that behaves like a search snippet
- `platform`, `status`
- `metadataPath` — where the complete metadata JSON was written
- `videoPath` — only when `returnVideo` is true

The full description, formats, view counts, and everything else go to the metadata file rather than into the agent's context. Descriptions routinely run to hundreds of lines of links, timestamps, sponsor copy and hashtags; the opening sentence or two carries almost all the signal.

**When `returnVideo` is false, the result explicitly states the two ways forward:** call `resolve_video` again with `returnVideo: true` to fetch the media, or call `analyze_video` with the same URL to go straight to analysis. Without that, an agent holding only metadata has to infer its next move.

**`comments` defaults to false** and its cost is stated in the description. yt-dlp's own help warns comments are fetched even when that is not quick; on a popular video this can mean thousands of comments and a long wait. A parameter that can turn a two-second call into a two-minute one must say so, or it will be enabled by reflex. Comments go to the metadata file only — never inline, whatever the count — with the count surfaced in the result so an agent knows they are there and can read the file if it wants them.

**When `analyze_video` is given a local path**, no copy is made — `destinationPath` receives the manifest, transcript and frames, and the result points at the existing file rather than duplicating it. Copying would double disk use for clips that are already exactly where the agent put them.

### 2.2 `analyze_video`

The analysis tool. Subsumes v1's `get_frame` and `get_clip`.

```
analyze_video(
  pathOrUrl:       string                        // required — URL or local path
  destinationPath: string                        // required
  start:           number?                       // seconds
  end:             number?                       // seconds; end === start means one instant
  frames:          "key" | "even" | "none"       // default "key"
  maxFrames:       number                        // default 35
  transcript:      boolean                       // default true
  language:        string?                       // optional override
)
```

**`pathOrUrl` accepts either.** This removes the entire class of error v1 had to shout about.

**`frames` replaces the v1 boolean idea.** `"key"` runs the importance selector and returns the best frames, deduplicated, capped by `maxFrames`. `"even"` samples uniformly across the range — the dense-inspection case. `"none"` returns no frames, which is how an agent asks for a transcript alone. An enum reads correctly cold; a `keyFramesOnly: false` boolean does not obviously mean "sample evenly."

**`maxFrames` carries what `fps` used to.** In `"even"` mode, budget across the range determines density: 60–90s with `maxFrames: 60` is 2fps. A single precise frame is `start: 7, end: 7, frames: "even", maxFrames: 1`.

**Frame selection is bounded to the range, in both modes.** `"key"` selects the best frames *within* `start`–`end`, never outside it, and `maxFrames` is a hard cap on what comes back.

> **Verified already true — do not "fix" this.** An earlier draft of this spec claimed the selector's temporal-coverage term would wrongly span the original video when a range was set. That was checked against the code and is false. The media is trimmed (or fetched pre-trimmed) *before* normalization, so `probe()` reports the **clip's** duration, candidates are planned against it, and the selector receives it — every stage after the trim is already clip-relative, on both the `rangeApplied` and ffmpeg-fallback branches. The claim is recorded here only so a future reader does not re-derive it and change working code.

**`maxFrames: 0` is accepted as an alias for `frames: "none"`.** The enum is the documented way to ask for a transcript alone, but a zero budget means the same thing and should not error. The description mentions both, since an agent reasoning about budgets may reach for the number before the enum.

**Removed: `mode` and `fps`.** `fps` is redundant per above. `mode` only ever decided whether platform auto-captions were trusted in place of running speech recognition — far narrower than "fast versus accurate" implies, and a reviewer already flagged the description as overselling it. Accuracy bias becomes unconditional: human-authored captions are used when present, otherwise local speech recognition runs.

**`language` is an optional override, not a required input.** See §4.

**The video is left at `destinationPath` when a URL is given**, so a later drill-down needs no second download. This is *not* advertised as a headline capability — it appears once, as an output field useful for follow-up calls. Anyone wanting a video file reaches for `resolve_video`, which says exactly that and nothing else.

## 3. Output and context economy

`destinationPath` is **mandatory on both tools**. A 35-frame manifest plus a full transcript is a large amount of context for an agent that may need three numbers from it.

- The **transcript is always written** to `destinationPath`, and additionally returned inline when short enough to be useful.
- Frames are written as files; the result carries paths and counts.
- The manifest is written in full; the inline result is a summary plus its path.

## 4. Language

Auto-detect where we honestly can, override where we cannot.

- **Platform metadata first.** yt-dlp's info dict carries a language field, already threaded through as a hint. WeChat carries a documented `zh` platform prior.
- **Explicit `language` outranks metadata** when supplied.
- **No audio-based detection.** The speech library's language field returns a constant value regardless of the actual spoken language on the installed version — verified across five languages by two independent checks during the v1 build. The library ships a separate language-identification model, but loading it means a third heavy model stage, which cuts against the staged-memory architecture the whole design rests on.

The description must not promise detection the engine cannot deliver.

## 5. Range extraction — what is actually true

Ranges are an optimization for some sources and a post-filter for others, and the description must say so.

- **yt-dlp sources genuinely download only the requested section.** A 30–340s request on a two-hour video fetches roughly five minutes of media. Because cuts snap to keyframes, the clip may begin slightly before the requested point; the applied range is verified after download, and a local trim is used as fallback when it did not apply.
- **Direct URLs and WeChat download in full, then trim.** Byte-range fetching is possible for both and is a worthwhile follow-up, but is not implemented.

Either way, **transcription covers only the selected range** — caption segments are clamped and re-based to the clip, and speech recognition runs on the trimmed audio.

### 5.1 Clipped media re-bases timestamps — state this loudly

A file fetched with `resolve_video(..., start: 724, end: 1200)` **starts at zero**. It is a 476-second video, not a two-hour video with a hole in it.

So an agent that then calls `analyze_video` on that local path must use clip-relative times: the moment 30 seconds into the demonstration is `start: 30`, not `start: 754`. Passing original-video timestamps to a clipped file silently yields the wrong section, or an empty result when the number exceeds the clip's length.

This is the same failure class as the absolute-versus-clip-relative caption bug that blocked the v1 build, and it is now reachable through ordinary tool use rather than only internally. Two mitigations, both required:

- `resolve_video`'s result must state plainly, whenever a range was applied, that the saved file begins at zero and that subsequent timestamps are relative to it — including the original offset so the agent can convert if it needs to.
- The saved metadata must record the applied range (`clipStart`, `clipEnd` against the original), so the relationship survives beyond the call that created it.

The alternative — passing the original URL to `analyze_video` with original timestamps — remains correct and is the simpler path when an agent is unsure.

## 6. Platform support, stated honestly

The `resolve_video` description names what is genuinely exercised — YouTube, TikTok, Facebook and Reels, X, Instagram, Twitch, Vimeo, Reddit, WeChat Channels, and direct MP4/HLS — then says plainly that many other sites work through generic extraction and some will not.

**On ranges (revised — the clause this replaced described v1 behaviour and stopped being true once the local-trim fallback shipped):** when a resolver cannot apply the requested range itself, it is trimmed locally instead (yt-dlp's own fallback, and the direct/WeChat path, which never applies a range natively). If that local trim also fails, the call returns an honest failure — `extractor_failed`, no `videoPath` — never the full video mislabeled as the requested clip. The one case that still returns the full video silently, and the one the tool descriptions must state plainly, is a half-specified range: both the resolver's own range gate and the local-trim fallback require `start` **and** `end` together, so supplying just one is treated as no range at all.

## 7. Idempotent writes

The same URL written to the same `destinationPath` twice **overwrites cleanly and returns the same shape**, whether it is the first call or the third. Throwing is hostile; keeping both copies leaves the agent guessing which is current. This covers the common metadata-then-video sequence, which is the same call made twice with `returnVideo` flipped.

**Ranges make "the same video" ambiguous, so treat the range as part of the identity.** Fetching 12:04–20:00 and then fetching the full video into the same directory are not the same artifact, and silently overwriting one with the other would leave an agent holding a file whose length contradicts what it just read. Media files are therefore named to reflect the applied range, so a full fetch and a clipped fetch coexist without collision, while re-fetching *the same range* overwrites in place. Metadata, which describes the source video rather than any particular clip, is single and always replaced.

The rule an agent can rely on: repeating a call is always safe and always yields the same result; varying the range adds an artifact rather than destroying one.

## 8. The implementation risk worth naming

If `analyze_video` subsumes single-frame extraction, then `start: 7, end: 7, maxFrames: 1` must be genuinely cheap — no scene detection, no quality filtering, no OCR, no embedding model, no transcription.

Today the orchestrator runs those stages unconditionally. Without early-exit paths, the cheapest operation would pay the full pipeline's cost, turning a simplification into a regression. **This is the actual work of the change; the parameter surface is the easy part.**

Concretely, the pipeline must skip:
- everything except frame extraction when `frames: "even"` and `transcript: false`
- the entire vision path when `frames: "none"`
- the transcript path when `transcript: false`

## 9. Metadata capture

`resolve_video`'s value depends on metadata the v1 code fetches but discards. The resolver currently captures six fields; the info dict also carries `chapters`, `description`, `uploader`, `upload_date`, `view_count` and `comment_count`.

**Chapters matter most**, because they compose with range extraction into a workflow neither has alone: an agent reads the chapter list, sees the demonstration starts at 12:04, and analyzes only that section — skipping most of the media, transcription and frame work. Without chapters it would analyze the whole video just to locate the interesting part.

## 10. Out of scope

Byte-range fetching for direct and WeChat sources; chapter-name matching in range requests (`--download-sections` supports regex against chapter titles); the follow-ups already recorded in `docs/follow-ups.md`.
