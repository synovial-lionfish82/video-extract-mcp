import { join } from 'node:path';
import { run } from '../util/run.js';

export async function probe(file: string) {
  const { stdout, code } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'format=duration:stream=width,height,r_frame_rate',
    '-of', 'json', file,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed for ${file}`);
  const j = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
  };
  const s = j.streams?.[0] ?? {};
  const [num, den] = (s.r_frame_rate ?? '0/1').split('/').map(Number);
  return {
    duration: Number(j.format?.duration ?? 0),
    width: s.width ?? 0,
    height: s.height ?? 0,
    fps: den ? (num ?? 0) / den : 0,
  };
}

/** 720p working video + 16 kHz mono wav. Platform differences end here (spec §8). */
export async function normalize(input: string, workDir: string) {
  const video = join(workDir, 'work.mp4');
  const audio = join(workDir, 'work.wav');
  const v = await run('ffmpeg', [
    '-y', '-i', input,
    '-vf', "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease",
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', video,
  ]);
  if (v.code !== 0) throw new Error(`normalize(video) failed: ${v.stderr.slice(-400)}`);
  // Try to extract audio from input. If it fails (no audio track), generate silence.
  const a = await run('ffmpeg', ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio]);
  if (a.code !== 0) {
    // Generate silent audio matching video duration
    const p = await probe(video);
    await run('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `anullsrc=r=16000:cl=mono:d=${p.duration}`,
      '-c:a', 'pcm_s16le', audio,
    ]);
  }
  return { video, audio };
}

export async function trim(input: string, start: number, end: number, out: string) {
  const r = await run('ffmpeg', [
    '-y', '-ss', String(start), '-to', String(end), '-i', input,
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', out,
  ]);
  if (r.code !== 0) throw new Error(`trim failed: ${r.stderr.slice(-400)}`);
  return out;
}

export async function extractFrame(video: string, timestamp: number, out: string) {
  const r = await run('ffmpeg', ['-y', '-ss', String(timestamp), '-i', video, '-frames:v', '1', '-q:v', '3', out]);
  if (r.code !== 0) throw new Error(`extractFrame failed at ${timestamp}: ${r.stderr.slice(-400)}`);
  return out;
}

/** Synthetic fixture: shot changes at 2s and 4s so scene detection has real boundaries. */
export async function makeTestVideo(out: string, seconds = 6) {
  const per = Math.max(1, Math.floor(seconds / 3));
  const r = await run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', `color=c=red:s=640x360:d=${per}`,
    '-f', 'lavfi', '-i', `color=c=blue:s=640x360:d=${per}`,
    '-f', 'lavfi', '-i', `color=c=green:s=640x360:d=${per}`,
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-r', '25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out,
  ]);
  if (r.code !== 0) throw new Error(`makeTestVideo failed: ${r.stderr.slice(-400)}`);
  return out;
}
