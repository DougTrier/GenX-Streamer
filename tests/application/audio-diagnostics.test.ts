import { describe, expect, it, vi } from 'vitest';
import { installAudioDiagnostics } from '../../src/application/audio-diagnostics';
import {
  AUDIO_HEALTH_CHANGE,
  type AudioHealthSnapshot,
} from '../../src/platform/browser-audio-health';

const sample = (): AudioHealthSnapshot => ({
  schemaVersion: 1,
  audioCodecObserved: null,
  audioBufferObserved: null,
  decodedBytes: null,
  decodedByteDelta: null,
  muted: false,
  volume: 0.8,
  trackCount: null,
  selectedTrackIndex: null,
  faults: [],
});
describe('redacted audio warning history', () => {
  it('ignores forged event details and unknown/video-only observations', async () => {
    const video = new EventTarget() as HTMLVideoElement,
      emit = vi.fn(async () => true);
    const owner = installAudioDiagnostics(video, { read: () => sample(), emit });
    video.dispatchEvent(
      Object.assign(new Event(AUDIO_HEALTH_CHANGE), {
        detail: { faults: [{ detail: 'https://private.invalid' }] },
      }),
    );
    await owner.dispose();
    expect(emit).not.toHaveBeenCalled();
  });
  it('emits one fixed warning per attachment and joins it on disposal', async () => {
    const video = new EventTarget() as HTMLVideoElement;
    let current: AudioHealthSnapshot | null = sample(),
      release!: () => void;
    const emit = vi.fn(async () => {
      await new Promise<void>((r) => (release = r));
      return true;
    });
    const owner = installAudioDiagnostics(video, { read: () => current, emit });
    const fire = () => video.dispatchEvent(new Event(AUDIO_HEALTH_CHANGE));
    current = {
      ...sample(),
      faults: [{ detail: 'bufferAppendingError', count: 1, lastElapsedMs: 500 }],
    };
    fire();
    fire();
    await Promise.resolve();
    expect(emit).toHaveBeenCalledTimes(1);
    let done = false;
    const closed = owner.dispose().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await closed;
    fire();
    expect(emit.mock.calls).toEqual([
      [{ operation: 'playback', level: 'warning', code: 'playback-audio-warning' }],
    ]);
  });
  it('starts a new comparison after real attachment reset and safely handles failed logging', async () => {
    const video = new EventTarget() as HTMLVideoElement;
    let current: AudioHealthSnapshot | null = {
      ...sample(),
      faults: [{ detail: 'fragLoadError', count: 1, lastElapsedMs: 1 }],
    };
    const emit = vi.fn(async () => {
      throw Error('Controlled diagnostic failure');
    });
    const owner = installAudioDiagnostics(video, { read: () => current, emit });
    const fire = () => video.dispatchEvent(new Event(AUDIO_HEALTH_CHANGE));
    fire();
    current = null;
    fire();
    current = { ...sample(), faults: [{ detail: 'fragLoadError', count: 1, lastElapsedMs: 1 }] };
    fire();
    await owner.dispose();
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
