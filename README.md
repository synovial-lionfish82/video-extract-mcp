# video-extract-mcp

**Turn any video URL into a transcript and the handful of frames that actually matter — locally, from an MCP server your AI agent can call.**

Give it a YouTube link, a TikTok, a WeChat Channels share URL, a raw `.mp4`, or a page from a site nobody has heard of. It downloads the video, produces a transcript (real captions when the platform has them, local speech recognition when it does not), and returns a small set of *important* keyframes — deduplicated, scene-aware, and scored — instead of a thousand near-identical stills.

Built for AI agents. Two MCP tools, no cloud, no API keys, no Python.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A526-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-440%20passing-success.svg)](#testing)
[![MCP](https://img.shields.io/badge/MCP-server-orange.svg)](https://modelcontextprotocol.io)

---

## Why this exists

An LLM cannot watch a video. The usual workaround — dump every Nth frame into the context window — burns enormous amounts of context on frames that are 98% identical to the one before, and still misses the slide that changed while nothing else moved.

`video-extract-mcp` does the selection work first:

- **Transcript, honestly sourced.** Human-authored captions are used when they exist. Otherwise audio is transcribed locally with Whisper or SenseVoice. The result tells you which one you got.
- **Keyframes chosen, not sampled.** Scene-boundary detection, blur/quality filtering, on-screen-text novelty (subtitle-aware, so burned-in captions don't preserve redundant frames), and image-embedding similarity feed an iterative diversity-aware selector.
- **Output goes to disk, not into your context.** The tool reply is a compact summary plus file paths. A 35-frame manifest and a full transcript don't belong in a conversation where the agent needs three numbers from them.
- **Everything runs on your machine.** No third-party API, no upload, no key.

## Quick start

```bash
git clone https://github.com/yanlingLabs/video-extract-mcp.git
cd video-extract-mcp
npm install
npm run build

# System binaries (macOS shown; use your package manager elsewhere)
brew install ffmpeg yt-dlp tesseract tesseract-lang

# Speech models, ~1.5 GB, one time
./scripts/fetch-models.sh

# Confirm the environment is sane
npm run preflight
```

Then register it with your MCP client. For Claude Code:

```bash
claude mcp add video-extract -- node /absolute/path/to/video-extract-mcp/dist/mcp.js
```

Or add it to any MCP client's config directly:

```json
{
  "mcpServers": {
    "video-extract": {
      "command": "node",
      "args": ["/absolute/path/to/video-extract-mcp/dist/mcp.js"]
    }
  }
}
```

## The two tools

The surface is deliberately small. Earlier versions had four tools and the descriptions had to shout about which ones took URLs versus local paths — a sign the design was wrong, not that the warning needed to be louder.

### `resolve_video` — look it up, optionally fetch it

```ts
resolve_video({
  url:             string,   // required
  destinationPath: string,   // required — where metadata (and media) are written
  returnVideo?:    boolean,  // default false: metadata only, no download
  start?:          number,   // seconds; only with returnVideo: true
  end?:            number,
  comments?:       boolean,  // default false — slow on popular videos
})
```

By default it downloads **nothing heavy**. You get title, creator, duration, the chapter list when the platform publishes one, and a short description preview. That is usually enough to decide what to do next — and it composes with ranges into the workflow that makes this whole thing efficient:

> Read the chapters → see the demo starts at 12:04 → analyze only 12:04–20:00 → skip 90% of the download, transcription, and frame work.

### `analyze_video` — the real work

```ts
analyze_video({
  pathOrUrl:       string,                     // URL *or* a local file — both work
  destinationPath: string,                     // required
  start?:          number,                     // seconds
  end?:            number,                     // end === start means one instant
  frames?:         "key" | "even" | "none",    // default "key"
  maxFrames?:      number,                     // default 35
  transcript?:     boolean,                    // default true
  language?:       string,                     // optional override, e.g. "zh"
})
```

- `"key"` runs the importance selector and returns the best frames, deduplicated.
- `"even"` samples the range uniformly — `maxFrames` sets the density, so 60 frames across 30 seconds is 2fps.
- `"none"` returns no frames at all. That is how you ask for a transcript alone.
- One exact frame: `start: 7, end: 7, frames: "even", maxFrames: 1, transcript: false`.

Frame selection is bounded to `start`–`end` in both modes, and the transcript covers only the selected range.

## What "important frame" actually means

Each candidate frame is scored on:

| Signal | What it catches |
|---|---|
| Scene boundaries | Hard cuts, shot changes — sampled ~250–500ms *after* the boundary so you get the new scene, not the transition |
| On-screen text novelty | A slide whose text changed, spatially aware so a persistent subtitle bar doesn't read as "new" |
| Visual quality | Rejects motion-blurred and out-of-focus frames before they compete |
| Embedding similarity | SigLIP vision embeddings, so two frames that *look* the same don't both survive |

Selection is iterative and diversity-aware (maximal marginal relevance), not a fixed weighted sum — so picking one frame changes what the next pick is worth. Every returned frame carries its `importance` score and the reasons it was chosen.

## Supported sources

Genuinely exercised code paths: **YouTube, TikTok, Facebook and Reels, X/Twitter, Instagram, Twitch, Vimeo, Reddit, WeChat Channels**, and direct `.mp4`/`.m3u8` URLs. Many other sites work through yt-dlp's generic extraction. Some will not, and those return a clear failure status rather than throwing.

WeChat Channels (视频号) support is worth calling out: it resolves **headlessly**, through a documented request sequence, with no browser automation and no MITM proxy. It needs a `NORMA_WECHAT_COOKIE` environment variable. The protocol was derived clean-room from Tencent's own served frontend and authenticated probes — deliberately *without* consulting existing implementations, since the well-known one is MIT + Commons Clause and would have restricted commercial use.

## Design constraints worth knowing

**Peak RAM stays under 2 GB.** Speech recognition and vision embedding are both heavy models, so they never coexist: each runs in its own worker process that exits before the next starts. Measured peak is ~1.1 GB.

**Single Node runtime.** No Python sidecar, no subprocess to a second language runtime. Speech recognition is `sherpa-onnx-node`; vision embeddings are `@huggingface/transformers`.

**Range requests are real.** For yt-dlp sources, asking for 30–340s of a two-hour video downloads roughly five minutes of media, not two hours. Direct URLs and WeChat download then trim locally. Either way, a fetched clip **starts at zero** — the reply says so and gives you the offset.

**Degradation is visible.** If OCR dies, or embeddings fail, or speech recognition errors out, the run continues and records a warning. An empty transcript is always distinguishable from a video that simply has no speech.

**Cheap requests are cheap.** A single-frame request skips scene detection, quality filtering, OCR, embeddings, transcription, *and* the video re-encode. Measured at ~240ms whether the source is 6 seconds or 5 minutes long.

## Status

**This is a working proof of concept, and honest about what that means.**

What is verified:

- 440 automated tests pass, including integration tests driving a real MCP client end-to-end against synthetic video fixtures.
- The WeChat resolution protocol was verified live, end to end, returning a real MP4.
- Caption-tier selection was verified against the installed yt-dlp's own source.
- Memory ceiling and single-frame latency are measured numbers, not estimates.

What is **not** verified:

- **The live-platform acceptance matrix has never been run.** `docs/acceptance-matrix.md` reports 0 of 11 rows executed, because it needs real URLs supplied via environment variables. Every platform above is a code path that is unit- and integration-tested — not a platform someone has watched succeed on a live link.

If you run the matrix against real URLs, that result is the single most valuable contribution this project can receive right now. See below.

## Contributing

Contributions are genuinely welcome, and there is a clear on-ramp.

**Highest value first:** run `npm run matrix` with real URLs in the environment variables it names, and open an issue with what you saw. That converts the project's biggest unknown into fact.

**Also open, with context already written down:** `docs/follow-ups.md` records every deliberately-deferred item with its reasoning — selector weight calibration against real footage, end-of-file candidate edges, byte-range fetching for direct and WeChat sources, and more. These are not vague "good first issue" labels; each one explains what was tried and why it was left.

House rules, briefly:

- Tests are expected to *fail against broken code*. This project's most common review finding has been a test that passes either way — if you add a test, mutate the thing it guards and confirm it goes red.
- No Python. Single Node runtime.
- `src/types.ts` is the single source of truth for shared types.
- Keep the peak-RAM ceiling intact: heavy stages run sequentially, never concurrently.

```bash
npm test          # full suite
npm run typecheck # strict, with noUncheckedIndexedAccess
npm run matrix    # acceptance matrix (honest about skips)
```

## Requirements

| | |
|---|---|
| Node | ≥ 26 |
| System binaries | `ffmpeg`, `ffprobe`, `yt-dlp`, `tesseract` (with `chi_sim` for Chinese OCR) |
| Models | ~1.5 GB, fetched by `scripts/fetch-models.sh` — Silero VAD, Whisper small, SenseVoice |
| Platform | Developed on macOS/arm64; nothing is platform-specific by design, but other platforms are untested |

Speech recognition routes by language: `zh`, `yue`, `ja`, `ko` → SenseVoice; everything else → Whisper. There is no audio-based language detection, because the installed library returns a constant value regardless of what is actually spoken — supply `language` when you know it.

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Keywords: MCP server, Model Context Protocol, video transcription, keyframe extraction, YouTube transcript, TikTok downloader, WeChat Channels 视频号, Whisper, SenseVoice, SigLIP, yt-dlp, scene detection, AI agent tools, video understanding, local ASR, TypeScript, Node.js</sub>
