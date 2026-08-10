# Norma Universal Video Extraction Engine — PoC Design Spec

**Date:** 2026-08-10
**Status:** Design (pending user review)
**Product context:** A tool for the Norma AI agent to call with a page/video URL (and optional time range). Returns a compact, multimodal-friendly representation of the video: a timestamped transcript plus a small set of important, deduplicated, transcript-aligned keyframes.
**Prior art:** See `extract-any-video+key-frames-selection+transcript.md` (research report). This spec ratifies that report's MVP roadmap with concrete PoC decisions and departs from it where the runtime choice (Node/TypeScript) or explicit user direction requires.

---

## 1. Purpose & the one claim worth proving

A naive "1 frame every 2 seconds" extractor floods a multimodal model with hundreds of near-identical images. The differentiating component of this system — the part worth original engineering — is:

> **selecting the minimum number of frames required for an AI to understand the important visual information in a video**, distinguishing *"the slide/code/chart changed"* (important) from *"the presenter moved their hand"* (not).

Everything else (download, decode, transcribe, scene-detect, embed) is assembled from mature components behind clean interfaces. The PoC exists to prove the whole chain works end-to-end across wildly different sources **and** that the importance selector earns its keep.

## 2. Goals / Non-goals

**Goals (PoC):**
- One agent-facing operation, `analyze_video(url, options)`, that hides all source-specific complexity.
- Extract video from: YouTube, TikTok, Facebook/Reels, X/Twitter, Instagram, direct MP4/HLS/DASH, generic embedded players (via yt-dlp), **and WeChat Channels (视频号) headlessly** after a one-time activation.
- Transcript via captions-first, else local ASR, with manual/auto caption distinction and language-aware ASR routing.
- Keyframe selection that is semantic, text-aware, subtitle-robust, and diversity-aware across the whole timeline.
- Frame↔transcript alignment.
- Optional time-range parameter (e.g. seconds 23–60).
- Clean, structured failure reporting (a DRM page fails honestly).
- **≈ <2 GB peak RAM for the complete tool**, achieved via staged single-language worker processes.
- MCP server exposing the tool (plus power-user primitives) to any agent.

**Non-goals (PoC):**
- DRM circumvention (report §4 — represented as `unsupported`).
- A universal guarantee to extract *literally every* video.
- Spoken-language identification beyond metadata/`preferredLanguage` hints (deferred).
- Production-grade WeChat protocol reimplementation (PoC validates the headless technique; independent reimplementation for commercial use is a later, licensing-gated task — see §7 and §21).
- Multi-tenant scaling, auth server, or persistence beyond a securely-stored WeChat session credential.

## 3. Architecture — single-runtime, staged

**Hard principle (user directive #1):** the entire tool is TypeScript/Node. No Python sidecar is introduced unless a required capability genuinely cannot be matched by Node/native tooling. Today, nothing requires it: ASR, VAD, embeddings, scene detection, OCR, and decoding are all reachable from Node via native addons or already-installed CLI binaries.

```
 analyze_video(url, { start?, end?, maxFrames?, mode?, preferredLanguage? })
        │
        ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Resolver layer   resolve(url) -> ResolvedMedia | Failure     │
 │   DirectMediaResolver | WeChatHeadlessResolver | YtDlpResolver│
 └───────────────────────────────┬─────────────────────────────┘
                                 │ local media file + metadata
                                 ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ FFmpeg normalize -> 720p working video  +  16 kHz mono WAV   │
 └───────────────┬─────────────────────────────┬───────────────┘
                 │                               │
        (ASR worker process)          (vision worker process)
                 ▼                               ▼
     Transcript track                 Visual track
     captions-first                   SceneDetector -> candidates
       else VAD -> ASR                  -> quality filter
       (Whisper | SenseVoice)           -> OCR text (subtitle-aware)
                 │                        -> SigLIP embeddings
                 │                        -> iterative diversity selector
                 └───────────────┬───────────────┘
                                 ▼
                     Aligner (transcript window + OCR per frame)
                                 ▼
                JSON manifest + frames/*.jpg  (tool result)
```

Heavy models are **never co-resident** (§4). The two worker processes run sequentially: ASR worker starts, transcribes, and exits (releasing RSS) before the vision worker starts.

## 4. Memory model — <2 GB peak via staged workers (user directive #3)

The target is not "each model is individually small"; it is **<2 GB peak RSS for the complete tool**. We achieve this in a single-language architecture using short-lived Node worker processes:

```
main TS orchestrator (small, persistent)
  ├─ spawn ASR worker  (sherpa-onnx: Silero VAD + Whisper/SenseVoice)
  │     transcribe -> write transcript.json -> worker EXITS (RSS released)
  ├─ spawn vision worker (Transformers.js: SigLIP) 
  │     embed + select -> write frames + features -> worker EXITS
  └─ assemble manifest
```

- Model choices remain "2 GB-capable" (Whisper small/base, SenseVoice int8, siglip-base ONNX), but the enforcement mechanism is **process lifetime**, not model size alone.
- Scene detection, quality filtering, OCR, and decode are handled by out-of-process binaries (ffmpeg, tesseract) and streaming, so they do not add resident model memory to the orchestrator.
- **Peak RSS is a measured acceptance criterion** (§20), not an assumption. The test harness records peak RSS of the orchestrator plus any child worker at its high-water mark.

## 5. Component matrix

| Function | Choice | Runtime | Notes / departure from report |
|---|---|---|---|
| URL extraction (general) | **yt-dlp** | subprocess (binary) | First build step: upgrade it (see §21). |
| WeChat Channels | **Headless share-link resolver** (yuanbao-cookie) | Node HTTP + persisted credential | Headless-first; desktop MITM only as fallback (§7). |
| Decode / trim / frames / audio | **FFmpeg** | subprocess (binary) | 720p working video + 16 kHz mono WAV. |
| Native captions | **yt-dlp `--write-subs` / `--write-auto-subs`** | subprocess | Distinguish manual vs auto (§9). |
| VAD + general ASR | **sherpa-onnx (Silero VAD + Whisper)** | Node native addon | Replaces report's faster-whisper (Python). |
| Chinese/JP/KR ASR | **sherpa-onnx (SenseVoice int8)** | Node native addon | Same runtime; routed by language (§9). |
| Scene boundaries | **FFmpeg `scdet`** behind `SceneDetector` interface | subprocess | PySceneDetect/TransNetV2 benchmarkable later (§10). |
| Blur/black/white filter | **sharp** (Laplacian variance + brightness) | Node native (libvips) | Cheap pre-embedding reject. |
| OCR text-novelty | **tesseract** (subtitle/region-aware) | subprocess | Already installed. Spatial + persistence aware (§13). |
| Semantic embeddings | **Transformers.js + SigLIP (ONNX)** | Node native | Replaces report's OpenCLIP (Python). |
| Frame selection | **Custom iterative diversity-aware selector** | Node | The differentiator (§15). |
| Agent interface | **MCP server** (`@modelcontextprotocol/sdk`) | Node | Plus power-user primitives (§18). |

**Why sherpa-onnx over faster-whisper (answering the design question directly):** the report recommended faster-whisper *only* for a primarily-Python backend (§11); it recommended the whisper.cpp family for native/desktop. Since Norma's runtime is Node, faster-whisper (a Python/CTranslate2 library) would force a Python sidecar. `sherpa-onnx` provides a Node native addon that unifies **Silero VAD + Whisper + SenseVoice** under one ONNX runtime — giving us general ASR *and* the Chinese specialist *and* VAD with zero Python. faster-whisper cannot provide SenseVoice at all.

## 6. Resolver layer & failure taxonomy

One interface, selected by URL shape:

```ts
interface VideoResolver {
  canResolve(url: string): boolean;
  resolve(url: string, opts: ResolveOptions): Promise<ResolvedMedia | ResolveFailure>;
}
```

Selection order: `DirectMediaResolver` (URL is a known container / HLS/DASH manifest) → `WeChatHeadlessResolver` (host is a WeChat Channels share domain) → `YtDlpResolver` (everything else; covers thousands of sites + generic embed extraction).

Failures are **first-class output** (report §4) — "proving it can be done" includes failing honestly:

```
status ∈ {
  ok,
  auth_required,      // login/cookies needed (non-WeChat)
  auth_expired,       // WeChat credential expired (see §7)
  needs_interaction,  // only path left requires human action (e.g. WeChat desktop fallback)
  unsupported,        // + reason: drm_protected | unsupported_link | extractor_unsupported
  not_found,
  extractor_failed    // transient/site-changed
}
```

`ResolvedMedia` carries: local file path, platform id, title, duration, native-caption availability (manual/auto/none), and a language hint if the platform exposes one.

## 7. WeChat Channels — headless-first design (user directive: rethink WeChat)

**Validated against `wx_channels_download` v260531 (2026-05-31):** it added `/api/channels/parse_sph`, which resolves a WeChat Channels **share link → direct video URL without stream decryption and without depending on the Channels page**, explicitly deployable on a Linux server. Authentication is a persistent **`sphCookie` obtained by logging into `yuanbao.tencent.com`** (Tencent's Yuanbao assistant, which holds Tencent-internal authorization to resolve Channels media). A Cloudflare Worker deployment (`sph_deploy`, mirroring the hosted `sph.litao.workers.dev`) exposes the same capability. The companion `qiaomu-wx-video` skill confirms the intended shape: **online share-link resolution first, desktop proxy/MITM only as fallback** for replays/failures.

This replaces the desktop-MITM-first design entirely. Desired UX:

```
First use:    Activate WeChat extraction -> user logs into yuanbao.tencent.com once
              -> Norma securely persists the session credential (macOS Keychain)
Afterwards:   analyze_video("https://weixin.qq.com/sph/...")
              -> fully headless: resolve -> download -> normal FFmpeg pipeline
```

### 7.1 `WeChatHeadlessResolver` states (first-class credential lifecycle)

```
ready            credential present & valid; resolves headlessly
auth_required    no credential yet -> surface "Activate WeChat extraction"
auth_expired     credential rejected/expired -> surface re-activation (NOT a silent break)
unsupported_link not a resolvable Channels share link (e.g. live/replay class)
resolved         direct media URL obtained -> hand to downloader + pipeline
```

These internal resolver states map onto the external §6 taxonomy: `ready`/`resolved` → `ok`; `auth_required` → `auth_required`; `auth_expired` → `auth_expired`; `unsupported_link` → `unsupported (reason: unsupported_link)`; a forced desktop fallback → `needs_interaction`. Credential expiry is a **known real failure mode** of this approach and is modeled explicitly, not discovered at runtime.

### 7.2 Authentication mechanism (to validate in the spike, §22)

- **Obtain:** one-time browser login to `yuanbao.tencent.com`; extract the session cookie. Norma has browser-automation available (Claude-in-Chrome) for an assisted login flow, or can read the cookie from the user's browser session. The browser need not stay open afterward.
- **Persist:** store the cookie in the macOS Keychain (never plaintext in the manifest or logs).
- **Refresh:** on `auth_expired`, re-run the one-time login. A background validity probe can pre-empt expiry.

### 7.3 Resolution + fallback priority (user-specified order)

```
1. Share URL -> authenticated headless resolve (parse_sph technique + yuanbao cookie) -> direct media URL
2. Headless session refresh/login when credential invalid
3. Browser-assisted authentication only when credentials expire
4. Desktop WeChat MITM/playback ONLY as fallback -> return needs_interaction
```

Only if the headless route fails **for a whole class of videos** do we consider the desktop fallback. Browser ≠ desktop: the classic proxy workflow targets the **PC WeChat client** (user plays the video); the new share-link route needs neither browser automation nor the Channels page.

### 7.4 Licensing constraint (user directive: inspect before copying — confirmed important)

`wx_channels_download` is **MIT + Commons Clause v1.0, Copyright (c) 2025 ltaoo** — *not* permissive MIT. The Commons Clause **prohibits selling the software** (providing its functionality to third parties for compensation) without a separate license. Consequences:

- **PoC (proving the concept):** two acceptable validation routes, distinguished precisely because their disclosure stories differ — (a) run a **self-hosted** parse instance authenticated with **the user's own yuanbao cookie** (no share links leave the user's control), or (b) use the **hosted worker**, which runs on the *author's* cookie and necessarily **receives the user's share links** — permitted only with **explicit user consent** to that third-party disclosure. Either proves headless WeChat extraction end-to-end; (a) is preferred.
- **Product (commercial Norma):** do **not** vendor their Commons-Clause code. Options: (a) implement the share-link→direct-URL resolution against Tencent's own endpoints **independently** in TypeScript (the Tencent protocol itself is not ltaoo's IP), or (b) obtain a commercial license from the author. This is tracked as a distinct legal/engineering task (§21), separate from the PoC.
- **Do not port the Go MITM implementation to Node yet.** If MITM is ever needed as a fallback, first wrap the existing implementation behind our resolver interface; reimplement independently only with clear justification and licensing review.

## 8. Media normalization (FFmpeg)

From the resolved local file, produce two derivatives so every platform distinction disappears downstream (report §6):

- **Visual working copy:** ≤720p (enough for slides/code/text; far cheaper to decode/embed).
- **Audio:** mono 16 kHz WAV for ASR.
- **Probe:** ffprobe for duration, fps, resolution, codec.

Time-range clipping (§18) is applied here when the resolver could not do it at download time.

## 9. Transcript pipeline (captions-first, accuracy-biased)

Order of preference (report §7), refined per user directives #4 and #8:

```
1. Human/creator (manual) captions        -> use directly (any mode)
2. Platform auto-generated captions        -> use in FAST mode
3. No human captions, or ACCURATE mode     -> local ASR
```

- yt-dlp distinguishes manual subs (`--write-subs`) from auto (`--write-auto-subs`), so the source tier is known and recorded in the manifest (`source: "manual" | "auto" | "asr"`).
- A `mode` option (`"fast" | "accurate"`, default `accurate`) governs whether auto-captions are trusted or ASR is run. (Optional later: run ASR *and* diff against auto-captions to flag low-confidence spans.)

**ASR routing (user directive #4 — no vague "CJK-heavy"):**

```
if preferredLanguage ∈ {zh, yue, ja, ko}  OR  reliable source metadata says so:
      -> SenseVoice (sherpa-onnx)
else:
      -> Whisper (sherpa-onnx), default
```

Dedicated spoken-language identification is deferred until benchmarks justify it. VAD (Silero) runs first so ASR only processes speech regions (report §10). Output: `{ language, source, segments: [{ start, end, text }] }`.

## 10. Scene detection (`SceneDetector` interface)

Approved for the PoC: **FFmpeg `scdet`** (frame-difference based; equivalent in spirit to PySceneDetect's ContentDetector) — keeps us single-runtime.

```ts
interface SceneDetector { detect(video: string): Promise<SceneBoundary[]>; }  // FFmpegSceneDetector (PoC)
```

Two required behaviors (user directive #2):
- Implemented behind an interface so `PySceneDetectDetector` / `TransNetV2Detector` (ONNX) can be **benchmarked** against it later without touching callers.
- **Do not sample the exact transition frame.** Sample a representative frame **~250–500 ms after** each boundary to avoid mid-cut blur/dissolve and get a stable, decoded keyframe.

## 11. Candidate generation

Never embed every frame (report §25). Candidates =
- **Scene-boundary frames** (sampled with the post-boundary offset from §10), plus
- **Heartbeat frames**: ≥1 candidate every N seconds (default N = 5, tunable), so important changes *inside* a visually static shot (a slide advancing while the camera holds) are still caught.

## 12. Quality filter (cheap, pre-embedding)

Before any ML, reject obviously useless candidates with `sharp`:
- blur (variance of Laplacian below threshold),
- near-black / near-white (mean brightness extremes),
- fades/dissolves (transitional low-information frames).

This runs before embeddings so we never spend model time on garbage (report §26).

## 13. OCR text-novelty — subtitle-aware (user directive #5)

OCR (tesseract) detects semantically important text changes that visual similarity misses: a code line, a slide number, a chart value (report §22, §24). But **burned-in subtitles (TikTok/Reels/etc.) must not rescue a frame per caption change** — the transcript already captures speech.

Novelty is therefore **spatial + persistence aware**:

```
text change in a caption band (lower-third / upper-third), churning every few frames
      -> classified as subtitle overlay -> LOW text-novelty weight
text change in a persistent content region (slide / code / UI / chart body)
      -> HIGH text-novelty weight
```

Mechanism: partition the frame into regions; track per-region text over time. Text that changes at subtitle cadence within a caption band is discounted; text that changes in the stable content region drives novelty. A subtitle overlay alone does **not** rescue a visually-redundant frame.

## 14. Semantic embeddings

SigLIP via Transformers.js (ONNX, native Node) → one normalized vector per surviving candidate. Cosine similarity in JS drives dedupe and the diversity term in §15. (Report §21 — semantic comparison rather than pixel/histogram.)

## 15. Importance + iterative diversity-aware selection (user directive #6)

**Replace the single fixed weighted score with an iterative, diversity-aware selector.** Base (intrinsic) importance is still a weighted blend, but temporal coverage and redundancy act **dynamically during selection**:

```
intrinsicImportance(frame) =
      0.35 * semantic_novelty
    + 0.25 * scene_significance
    + 0.20 * text_novelty        (subtitle-discounted, §13)
    + 0.10 * image_quality
    + 0.10 * (optional transcript_relevance)   // speech emphasis near timestamp

Greedy selection loop until maxFrames:
  selectionScore(candidate) =
        intrinsicImportance(candidate)
      + timelineCoverageBonus(candidate | alreadySelected)   // rewards under-covered spans
      - similarityToAlreadySelected(candidate)                // max cosine to any picked frame
  pick argmax; recompute coverage/similarity for the rest; repeat.
```

This is a maximal-marginal-relevance style selector. It prevents choosing 15 frames from one interesting minute while barely representing the rest of a long video, and guarantees the whole timeline stays represented under a fixed `maxFrames` budget. Each picked frame records `reasons: ["new_scene", "new_text", "under_covered_span", ...]` for explainability (report §29). Weights are tunable starting values, not constants.

## 16. Frame ↔ transcript alignment

For each selected frame at time `t`, attach the transcript segments overlapping `[t − Δ, t + Δ]` (Δ default 4 s, configurable), plus that frame's content-region OCR text. The agent thus sees *what was visible* and *what was said then*, together (report §28) — far more useful than frames or transcript alone.

## 17. Output manifest

```json
{
  "source": { "url": "...", "platform": "youtube", "title": "...", "duration": 642.8,
              "resolvedBy": "ytdlp", "status": "ok" },
  "transcript": { "language": "en", "source": "manual|auto|asr",
                  "segments": [ { "start": 0.0, "end": 4.2, "text": "..." } ] },
  "frames": [ { "timestamp": 12.42, "scene_id": 3, "image": "frames/frame_0003.jpg",
                "importance": 0.91, "reasons": ["new_scene","new_text"],
                "ocr_content": "...", "transcript_window": "...",
                "nearest_selected_similarity": 0.43 } ],
  "processing": { "selected_frames": 34, "candidate_frames": 181,
                  "peak_rss_mb": 1780, "selector_version": "1", "mode": "accurate" }
}
```

Frames are written as JPEGs to an output directory; the manifest references them by path (and can additionally return base64 for direct tool-result embedding). `peak_rss_mb` is emitted so the memory budget is observable in every run.

## 18. Tool / MCP interface

**Primary:** `analyze_video(url, { start?, end?, maxFrames = 35, transcript = true, preferredLanguage?, mode = "accurate" })`. (`maxFrames` and `mode` are the only budget/quality knobs; no separate "detail" parameter — the iterative selector adapts to `maxFrames`.)

**Time range (your "23–60 secs" ask) — optimization, not guarantee (user directive #7):**
attempt yt-dlp `--download-sections "*start-end"` (with `--force-keyframes-at-cuts`) to fetch only the slice; **verify** the returned clip's actual bounds via ffprobe, and **transparently fall back** to full retrieval + FFmpeg trim whenever range/seek behavior is unsupported or inaccurate. Direct/local files always use FFmpeg trim.

**Power-user primitives (report §34) for coarse-to-fine agent inspection:**
`resolve_video(url)`, `transcribe_video(url|file)`, `extract_keyframes(url|file)`, `get_frame(t)`, `get_clip(start, end, fps)`. These let the agent do a cheap first pass (≈35 frames + full transcript), notice "something at 8:31", then request denser frames only there (report §35).

All primitives are exposed through an MCP server (`@modelcontextprotocol/sdk`) wrapping the same Node library core.

## 19. Process / worker architecture

- **Orchestrator** (persistent, small): resolves, normalizes, spawns workers, assembles manifest, serves MCP.
- **ASR worker** (transient): sherpa-onnx (VAD + Whisper/SenseVoice); writes `transcript.json`; exits.
- **Vision worker** (transient): Transformers.js SigLIP embeddings + selector; writes frames + features; exits.
- Scene detection, quality filter, OCR, decode, download: out-of-process binaries (ffmpeg, tesseract, yt-dlp) invoked as needed.

Sequential worker lifetimes are what enforce the memory budget (§4).

## 20. PoC scope, milestones & acceptance

**Milestones (always keep a working slice):**
1. **Core spine:** yt-dlp(upgraded) → ffmpeg normalize → captions/Whisper via ASR worker → ffmpeg `scdet` + heartbeat → quality filter → similarity dedupe → manifest + CLI. Proves YouTube / TikTok / direct-MP4 end-to-end.
2. **Semantic + text:** SigLIP embeddings, subtitle-aware OCR novelty, iterative diversity selector, frame↔transcript alignment.
3. **Breadth:** WeChat headless resolver + activation flow, SenseVoice routing, MCP server, `get_frame`/`get_clip`.

**Acceptance = a fixed URL test matrix (this *is* the acceptance test):**

| Case | Proves |
|---|---|
| YouTube with manual captions | caption tier 1, alignment |
| YouTube, no captions | VAD → Whisper ASR path |
| TikTok with burned-in subtitles | subtitle-aware OCR does **not** over-select |
| Facebook / Reels (public) | yt-dlp Facebook extraction (named target platform) |
| A login-walled video, no cookies | clean `auth_required` status |
| Direct `.mp4` URL | DirectMediaResolver + trim |
| One generic embedded player | yt-dlp generic extraction |
| WeChat Channels share link | headless resolver + activation + SenseVoice |
| One Chinese-language video | SenseVoice routing by `preferredLanguage`/metadata |
| One DRM page | clean `unsupported: drm_protected` |
| `analyze_video(url, start=23, end=60)` | range slice + fallback correctness |

**Measured criteria:** every matrix run records **peak RSS** (must trend to the <2 GB target) and selected/candidate frame counts. **Unit tests** cover only pure logic: importance/selection, semantic dedupe, subtitle-region classification, alignment windowing, VTT parsing, range-bound verification. Network-touching paths are proven by the matrix, not mocked.

## 21. Environment & setup (implementation-plan preconditions)

- **Upgrade yt-dlp first** and smoke-test one URL. The installed build (2025.12.08) is ~8 months old and will likely fail on current YouTube. Build step #1.
- Ignore the machine's existing torch/openai-whisper packages — they belong to a Python 3.9 user install and are irrelevant now (we are Node-only).
- Install/pin: Node project (Node 26 present), `sherpa-onnx` node addon + models (Whisper small, SenseVoice int8), Transformers.js + SigLIP ONNX, `sharp`, `@modelcontextprotocol/sdk`. `ffmpeg`/`ffprobe`/`yt-dlp`/`tesseract` already present.
- **Native-addon smoke check before any pipeline code:** verify the `sherpa-onnx` node addon actually loads on **Node 26 / darwin-arm64** (prebuilt-binary availability is a real risk on a Node version this new; may need a source build) and that Transformers.js successfully pulls and runs a SigLIP ONNX checkpoint. Fail fast here rather than mid-pipeline.
- **WeChat commercialization task (licensing):** independently implement the share-link resolution protocol in TS, or license `wx_channels_download`, before any commercial ship. PoC uses a self-hosted/hosted instance with user consent only.

## 22. Open questions / spikes before/within implementation

1. **WeChat headless spike (do first, before any desktop-MITM work):** obtain a yuanbao cookie via one-time login; reproduce share-link → direct-URL headlessly; confirm the file flows through the pipeline. Confirm the exact worker endpoint (README documents `/api/channels/parse_sph` for the local server; the user-reported Cloudflare route `/api/fetch_video_profile` is to be verified against the current deployment) and observe cookie-expiry behavior to validate the `auth_expired` state.
2. **ffmpeg `scdet` sufficiency:** validate against real videos; if too coarse/noisy, the `SceneDetector` interface lets us slot TransNetV2 (ONNX) without refactoring callers.
3. **Subtitle-region classification:** confirm the caption-band + persistence heuristic generalizes across TikTok/Reels/YouTube burned-in styles; tune bands.
4. **Peak-RSS reality check:** measure that sequential workers actually keep the complete tool under ~2 GB on the matrix; adjust model sizes/quantization if not.

---

### Appendix A — departures from the research report (with rationale)

| Report said | This spec does | Why |
|---|---|---|
| faster-whisper for a Python backend | sherpa-onnx (Whisper+SenseVoice+VAD) | Runtime is Node; avoids Python; unifies general + Chinese ASR. |
| OpenCLIP/SigLIP (Python) | Transformers.js SigLIP (ONNX) | Native Node embeddings. |
| PySceneDetect | FFmpeg `scdet` behind `SceneDetector` iface | Single-runtime; others benchmarkable later. |
| WeChat = desktop MITM adapter | Headless share-link resolver first; MITM only fallback | v260531 `parse_sph` + yuanbao cookie enables headless; better UX. |
| Fixed weighted importance score | Iterative diversity-aware (MMR-style) selection | Guarantees whole-timeline coverage under a frame budget. |
| "2 GB-capable parts" | <2 GB **peak** via staged worker processes, measured | Real budget for the complete tool, not per-model. |
