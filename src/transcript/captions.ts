import type { TranscriptSegment, CaptionTrack } from '../types.js';

const CUE = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/;

function toSeconds(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

/** One cue with its lines still separate -- the line boundaries ARE the
 *  rolling-duplicate signal, so they cannot be joined before deduping. */
export interface RollingCue { start: number; end: number; lines: string[] }

/**
 * A "scroll" cue carries no new words: platform rolling captions emit a
 * near-instant cue holding just the completed line before the next real cue
 * repeats it and appends. Measured at 10ms on YouTube's own output; 50ms is
 * a deliberately loose ceiling, since no cue this short can carry speech.
 */
const SCROLL_CUE_MAX_SECONDS = 0.05;

/**
 * Cue text is XML-escaped, so a real YouTube track reaches an agent reading
 * `&gt;&gt; Agora a meta e dominar` -- the `>>` is that platform's
 * speaker-change marker, and `&amp;` is any literal ampersand. Decoded AFTER
 * tag stripping, never before: decoding first would turn an escaped `&lt;`
 * into a `<` that the tag stripper then eats along with everything up to the
 * next `>`.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');   // last, so "&amp;lt;" yields "&lt;" not "<"
}

export function parseVttCues(vtt: string): RollingCue[] {
  const out: RollingCue[] = [];
  for (const block of vtt.split(/\r?\n\r?\n/)) {
    const raw = block.split(/\r?\n/).filter((l) => l.trim() !== '');
    const idx = raw.findIndex((l) => CUE.test(l));
    if (idx === -1) continue;
    const m = CUE.exec(raw[idx]!);
    if (!m) continue;
    // Inline cue tags carry per-word timings (`<00:00:02.240><c> word</c>`).
    // Stripped here so dedupe compares plain text: the same line reappears
    // tagged in one cue and untagged in the next, and would not match
    // otherwise.
    const lines = raw.slice(idx + 1)
      .map((l) => decodeEntities(l.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
      .filter((l) => l !== '');
    if (lines.length === 0) continue;
    out.push({
      start: toSeconds(m[1]!, m[2]!, m[3]!, m[4]!),
      end: toSeconds(m[5]!, m[6]!, m[7]!, m[8]!),
      lines,
    });
  }
  return out;
}

/**
 * Collapses platform rolling captions, where each cue repeats the previous
 * cue's trailing lines before appending new ones. Left alone, a YouTube
 * automatic track inflates roughly 3x -- measured 8571 -> 2921 characters on
 * a real 180s window -- and every line reaches the agent two or three times.
 *
 * Only leading lines that genuinely duplicate the previous cue are removed,
 * and only when new content follows them. A cue that repeats the previous one
 * with NOTHING new is kept verbatim: that is a real repeat (a chorus, a
 * chanted line), not a scroll artifact. The single exception is a cue too
 * short to contain speech at all, which is dropped outright.
 */
export function dedupeRollingCues(cues: RollingCue[]): RollingCue[] {
  const out: RollingCue[] = [];
  let prev: string[] = [];
  for (const cue of cues) {
    // Longest run of prev's TRAILING lines that equals this cue's LEADING
    // lines. Longest-first, so a two-line scroll is not mistaken for a
    // one-line one.
    let overlap = 0;
    for (let n = Math.min(cue.lines.length, prev.length); n >= 1; n--) {
      if (prev.slice(-n).every((l, i) => l === cue.lines[i])) { overlap = n; break; }
    }
    const fresh = cue.lines.slice(overlap);
    if (fresh.length === 0) {
      // Nothing new. Drop it only if it is a scroll artifact; otherwise it is
      // a genuine repeat and belongs in the transcript with its own timing.
      if (cue.end - cue.start > SCROLL_CUE_MAX_SECONDS) out.push(cue);
    } else {
      out.push({ start: cue.start, end: cue.end, lines: fresh });
    }
    prev = cue.lines;
  }
  return out;
}

export function parseVtt(vtt: string): TranscriptSegment[] {
  return dedupeRollingCues(parseVttCues(vtt))
    .map((c) => ({ start: c.start, end: c.end, text: c.lines.join(' ').replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text !== '');
}

/**
 * Re-bases full-video caption segments onto a [start, end] clip: keeps only
 * segments overlapping the range, shifts them by -start, and clamps them to
 * the clip's bounds. Needed because caption files always cover the WHOLE
 * video with absolute timestamps (yt-dlp writes subtitle tracks whole even
 * under --download-sections), while a ranged analysis works on a 0-based
 * clip -- without this, every transcriptWindow is offset by `start` seconds.
 * (ASR output needs no such treatment: it is produced FROM the clip.)
 */
export function clampSegmentsToRange(
  segments: TranscriptSegment[], start: number, end: number,
): TranscriptSegment[] {
  return segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => ({
      start: Math.max(0, s.start - start),
      end: Math.min(end - start, s.end - start),
      text: s.text,
    }));
}

/**
 * Any platform caption beats local speech recognition. Local ASR is the
 * fallback for videos that have no captions at all -- not a preferred tier.
 *
 * This reverses the original "accuracy bias", which assumed local ASR was
 * more faithful than an automatic track. Measured on three real videos
 * against the shipped Whisper small model, the assumption was simply wrong:
 *
 *  - Accented English (Uncle Roger): local output drifted mid-clip out of
 *    English entirely and finished in Malay. The automatic track did not.
 *  - Sung English (a music video): local output emitted CJK characters and
 *    invented words. The automatic track returned clean lyrics.
 *  - Brazilian Portuguese: local output degraded into gibberish about
 *    halfway through and missed proper nouns the automatic track got right.
 *
 * Timing resolution moved the same way, which matters because frames are
 * aligned against these segments: 57 automatic segments versus 4 local ones
 * on a 65s video, and 165 versus 7 on a 180s window.
 *
 * Platform ASR runs at a scale local inference cannot match, so a machine
 * translation of a platform transcript still beats transcribing here. Hence
 * no caller-facing choice: there is no case where local ASR is the better
 * option when captions exist.
 */
export function chooseCaptionTier(
  captions: { manual: CaptionTrack | null; auto: CaptionTrack | null },
): 'manual' | 'auto' | 'asr' {
  if (captions.manual) return 'manual';
  if (captions.auto) return 'auto';
  return 'asr';
}
