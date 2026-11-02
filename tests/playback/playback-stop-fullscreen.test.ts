import { describe, expect, it } from 'vitest';
import {
  createPlaybackControls,
  type PlaybackControlsEnvironment,
} from '../../src/application/playback/playback-controls';
import { createFullscreenOwner } from '../../src/ui/player/fullscreen-owner';

describe('Stop leaves fullscreen', () => {
  it.each([false, true])(
    'returns GenXtra to the app even when cleanup fails: %s',
    async (fails) => {
      const events: string[] = [];
      const fullscreenOwner = createFullscreenOwner({
        apply: async (enabled) => {
          events.push(`fullscreen ${enabled}`);
        },
        changed: () => undefined,
      });
      await fullscreenOwner.set(true);
      const controls = createPlaybackControls({
        fullscreenOwner,
        setExpanded: (enabled: boolean) => {
          events.push(`expanded ${enabled}`);
        },
        backgroundLiveChoice: null,
        archivePlayer: {
          selection: {},
          stop: async () => {
            expect(fullscreenOwner.active).toBe(false);
            events.push('stop');
            if (fails) throw new Error('cleanup failed');
          },
        },
        library: {},
        clearArchiveResume: () => undefined,
      } as unknown as PlaybackControlsEnvironment);
      if (fails) await expect(controls.stopLocalPlayback()).rejects.toThrow('cleanup failed');
      else await controls.stopLocalPlayback();
      expect(events).toEqual(['fullscreen true', 'fullscreen false', 'expanded false', 'stop']);
      expect(fullscreenOwner.active).toBe(false);
    },
  );
});
