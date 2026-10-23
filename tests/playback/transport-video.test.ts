import { describe, expect, it } from 'vitest';
import { transportVideoFormat } from '../../src/playback/transport-video';

/** One 188-byte transport packet carrying a PSI section (payload unit start). */
function packet(pid: number, section: number[]): number[] {
  const bytes = [0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0x00, ...section];
  while (bytes.length < 188) bytes.push(0xff);
  return bytes;
}
function pat(programMap: number): number[] {
  const body = [
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0x00,
    0x01,
    0xe0 | (programMap >> 8),
    programMap & 0xff,
  ];
  return [0x00, 0xb0, body.length + 4, ...body, 0, 0, 0, 0];
}
function pmt(streams: Array<[type: number, pid: number]>): number[] {
  const entries = streams.flatMap(([type, pid]) => [
    type,
    0xe0 | (pid >> 8),
    pid & 0xff,
    0xf0,
    0x00,
  ]);
  const body = [0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00, ...entries];
  return [0x02, 0xb0, body.length + 4, ...body, 0, 0, 0, 0];
}
function segment(streams: Array<[number, number]>, lead: number[] = []): Uint8Array {
  return new Uint8Array([
    ...lead,
    ...packet(0, pat(0x1000)),
    ...packet(0x1000, pmt(streams)),
    ...packet(0x100, []),
  ]);
}

describe('transport stream picture format', () => {
  it('finds MPEG-2 video with MPEG audio (the ACC Network stream)', () => {
    expect(
      transportVideoFormat(
        segment([
          [0x02, 0x100],
          [0x03, 0x101],
        ]),
      ),
    ).toBe('mpeg2');
    expect(transportVideoFormat(segment([[0x01, 0x100]]))).toBe('mpeg2');
  });
  it('leaves H.264, HEVC and audio-only streams to the web player', () => {
    expect(
      transportVideoFormat(
        segment([
          [0x1b, 0x100],
          [0x0f, 0x101],
        ]),
      ),
    ).toBeNull();
    expect(
      transportVideoFormat(
        segment([
          [0x24, 0x100],
          [0x0f, 0x101],
        ]),
      ),
    ).toBeNull();
    expect(transportVideoFormat(segment([[0x0f, 0x101]]))).toBeNull();
    // A program that also offers H.264 plays in the web player.
    expect(
      transportVideoFormat(
        segment([
          [0x02, 0x100],
          [0x1b, 0x102],
        ]),
      ),
    ).toBeNull();
  });
  it('finds the packets after leading bytes and ignores what is not a transport stream', () => {
    expect(transportVideoFormat(segment([[0x02, 0x100]], [0x00, 0x47, 0x12]))).toBe('mpeg2');
    expect(transportVideoFormat(new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x09]))).toBeNull();
    expect(transportVideoFormat(new TextEncoder().encode('#EXTM3U\n'))).toBeNull();
    expect(transportVideoFormat(new Uint8Array(0))).toBeNull();
  });
  it('reads a truncated program map without reading past the packet', () => {
    const bytes = segment([[0x02, 0x100]]);
    bytes[188 + 7] = 0xff; // section length far beyond the packet
    expect(() => transportVideoFormat(bytes)).not.toThrow();
  });
});
