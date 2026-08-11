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
  comments:        boolean   // default false
)
```

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

**`comments` defaults to false** and its cost is stated in the description. yt-dlp's own help warns comments are fetched even when that is not quick; on a popular video this can mean thousands of comments and a long wait. A parameter that can turn a two-second call into a two-minute one must say so, or it will be enabled by reflex.

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

## 6. Platform support, stated honestly

The `resolve_video` description names what is genuinely exercised — YouTube, TikTok, Facebook and Reels, X, Instagram, Twitch, Vimeo, Reddit, WeChat Channels, and direct MP4/HLS — then says plainly that many other sites work through generic extraction, some will not, and a range request that cannot be applied yields the full video rather than a failure.

## 7. Idempotent writes

The same URL written to the same `destinationPath` twice **overwrites cleanly and returns the same shape**, whether it is the first call or the third. Throwing is hostile; keeping both copies leaves the agent guessing which is current. This covers the common metadata-then-video sequence, which is the same call made twice with `returnVideo` flipped.

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
