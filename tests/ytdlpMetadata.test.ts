import { describe, it, expect } from 'vitest';
import { toVideoMetadata } from '../src/resolve/ytdlp.js';

describe('toVideoMetadata', () => {
  it('maps chapters with start, end and title', () => {
    const m = toVideoMetadata({
      title: 'T', duration: 100,
      chapters: [{ start_time: 0, end_time: 12, title: 'Intro' },
                 { start_time: 12, end_time: 100, title: 'Demo' }],
    });
    expect(m.chapters).toEqual([
      { start: 0, end: 12, title: 'Intro' },
      { start: 12, end: 100, title: 'Demo' },
    ]);
  });
  it('yields an empty chapter list when the platform provides none', () => {
    expect(toVideoMetadata({ title: 'T' }).chapters).toEqual([]);
  });
  it('prefers uploader over channel for creator', () => {
    expect(toVideoMetadata({ uploader: 'U', channel: 'C' }).creator).toBe('U');
  });
  it('falls back to channel when uploader is absent', () => {
    expect(toVideoMetadata({ channel: 'C' }).creator).toBe('C');
  });
  it('returns null creator when neither is present', () => {
    expect(toVideoMetadata({}).creator).toBeNull();
  });
  it('keeps the full description (truncation belongs to the artifact layer)', () => {
    const long = 'x'.repeat(500);
    expect(toVideoMetadata({ description: long }).description).toHaveLength(500);
  });
  it('carries counts through and nulls them when absent', () => {
    expect(toVideoMetadata({ view_count: 5, comment_count: 2 }).viewCount).toBe(5);
    expect(toVideoMetadata({}).commentCount).toBeNull();
  });
  it('tolerates a malformed chapters value instead of throwing', () => {
    expect(toVideoMetadata({ chapters: 'nope' as never }).chapters).toEqual([]);
  });
  it('carries comments through when present', () => {
    const comments = [{ id: '1', text: 'great!' }, { id: '2', text: 'thanks' }];
    expect(toVideoMetadata({ comments }).comments).toEqual(comments);
  });
  it('leaves comments undefined when absent', () => {
    expect(toVideoMetadata({}).comments).toBeUndefined();
  });
});
