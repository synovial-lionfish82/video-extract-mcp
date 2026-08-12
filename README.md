# video-extract-mcp

**Turn any video URL into a transcript and the handful of frames that actually matter — locally, from an MCP server your AI agent can call.**

Give it a YouTube link, a TikTok, a WeChat Channels share URL, a raw `.mp4`, or a page from a site nobody has heard of. It downloads the video, produces a transcript (real captions when the platform has them, local speech recognition when it does not), and returns a small set of *important* keyframes — deduplicated, scene-aware, and scored — instead of a thousand near-identical stills.

Built for AI agents. Two MCP tools, no cloud, no API keys, no Python.

[![npm](https://img.shields.io/npm/v/@yanlinglabs/video-extract-mcp)](https://www.npmjs.com/package/@yanlinglabs/video-extract-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A526-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-456%20passing-success.svg)](#testing)
[![MCP](https://img.shields.io/badge/MCP-server-orange.svg)](https://modelcontextprotocol.io)

---

## Why this exists

An LLM cannot watch a video. The usual workaround — dump every Nth frame into the context window — burns enormous amounts of context on frames that are 98% identical to the one before, and still misses the slide that changed while nothing else moved.

`video-extract-mcp` does the selection work first:

- **Transcript, honestly sourced.** The platform's own captions are used whenever the video has any — human-written first, otherwise the platform's automatic ones. Audio is transcribed locally (Whisper or SenseVoice) only for videos with no captions at all. The result tells you which you got, via `transcript.source`.
- **Keyframes chosen, not sampled.** Scene-boundary detection, blur/quality filtering, on-screen-text novelty (subtitle-aware, so burned-in captions don't preserve redundant frames), and image-embedding similarity feed an iterative diversity-aware selector.
- **Output goes to disk, not into your context.** The tool reply is a compact summary plus file paths. A 35-frame manifest and a full transcript don't belong in a conversation where the agent needs three numbers from them.
- **Everything runs on your machine.** No third-party API, no upload, no key.

## Quick start

Install the system binaries first — these can't come from npm:

```bash
# macOS; use your package manager elsewhere
brew install ffmpeg yt-dlp tesseract tesseract-lang
```

Then point your MCP client at the package. For Claude Code:

```bash
claude mcp add video-extract -- npx -y @yanlinglabs/video-extract-mcp
```

Or in any MCP client's config:

```json
{
  "mcpServers": {
    "video-extract": {
      "command": "npx",
      "args": ["-y", "@yanlinglabs/video-extract-mcp"]
    }
  }
}
```

That is enough for any video that has captions — which, thanks to the caption-first transcript policy, is most of them. The vision model downloads itself on first use.

**Speech models are only needed for videos with no captions at all.** They are ~1.5 GB, so they are not bundled. Fetch them when you want that fallback:

```bash
npx -y @yanlinglabs/video-extract-mcp --help   # installs the package
curl -fsSL https://raw.githubusercontent.com/yanlingLabs/video-extract-mcp/main/scripts/fetch-models.sh \
  | bash -s -- ~/.cache/video-extract-mcp/models
```

`~/.cache/video-extract-mcp/models` is where the tool looks by default. Override with `VIDEO_EXTRACT_MODELS_DIR`. Without them, an uncaptioned video still returns frames and records a warning explaining the transcript is missing — it degrades rather than fails.

### From source (contributors)

```bash
git clone https://github.com/yanlingLabs/video-extract-mcp.git
cd video-extract-mcp
npm install && npm run build
./scripts/fetch-models.sh    # into ./models, which takes precedence when present
npm run preflight            # verifies ffmpeg / ffprobe / yt-dlp / tesseract
```

### Environment variables

| Variable | Purpose |
|---|---|
| `VIDEO_EXTRACT_MODELS_DIR` | Where speech models live. Defaults to `./models` when that exists, else `~/.cache/video-extract-mcp/models`. |
| `VIDEO_EXTRACT_WECHAT_COOKIE` | A yuanbao session cookie, required only for WeChat Channels links. |

## Three ways to use it

The MCP server is the main surface, but the same engine is available two other ways.

**As a CLI**, which is the quickest way to see what it does before wiring up an agent:

```bash
npm run cli -- "https://youtube.com/watch?v=..." --max-frames 10 --out ./output

# just the transcript, no frames
npm run cli -- "<url>" --frames none --out ./output

# one exact frame at 7s, as cheap as this gets
npm run cli -- "<url>" --start 7 --end 7 --frames even --max-frames 1 --no-transcript --out ./output
```

It writes `manifest.json` plus the frame images into `--out`, and also prints the manifest to stdout.

If you want to pipe that JSON somewhere, call the built entry point directly — `npm run` prefixes its own banner lines to stdout, so `npm run cli` output is not valid JSON on its own:

```bash
npm run build
node dist/cli.js "<url>" --max-frames 10 | jq '.transcript.source'
```

**As a library**, if you want the pipeline without an agent in the loop:

```ts
import { analyzeVideo } from '@yanlinglabs/video-extract-mcp/dist/analyze.js';

const manifest = await analyzeVideo('https://youtube.com/watch?v=...', {
  start: 30, end: 90, frames: 'key', maxFrames: 12, outDir: './output',
});
console.log(manifest.transcript?.source);   // 'manual' | 'auto' | 'asr'
console.log(manifest.frames.map((f) => f.image));
```

`analyzeVideo` never throws for expected failures — a DRM page or a dead link comes back as a manifest whose `source.status` is not `'ok'`, carrying a readable reason. Check `processing.warnings` too: any optional stage that failed and was skipped past records an entry there.

Note that both the CLI and library paths run the **compiled** output. The speech and vision models run in separate worker processes resolved next to the compiled module, so running the TypeScript sources directly leaves those workers unresolvable — they degrade to a warning rather than an error, which is quiet enough to miss. `npm run cli` builds first for this reason.

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

WeChat Channels (视频号) support is worth calling out: it resolves **headlessly**, through a documented request sequence, with no browser automation and no MITM proxy. It needs a `VIDEO_EXTRACT_WECHAT_COOKIE` environment variable. The protocol was derived clean-room from Tencent's own served frontend and authenticated probes — deliberately *without* consulting existing implementations, since the well-known one is MIT + Commons Clause and would have restricted commercial use.

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
