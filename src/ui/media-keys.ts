export interface RemoteActions {
  togglePause(): void | Promise<void>;
  play(): void | Promise<void>;
  pause(): void;
  stop(): void | Promise<void>;
  mute(): void | Promise<void>;
  volume(direction: -1 | 1): void | Promise<void>;
  channel(direction: -1 | 1): void;
  back(): void | Promise<void>;
  /** The remote's Rewind key, where it has one. */
  rewind?(): void | Promise<void>;
  failed(): void;
}

/** Only key events actually exposed by the device are handled. */
export function installMediaKeys(actions: RemoteActions): () => void {
  const bindings: Record<string, () => void | Promise<void>> = {
    MediaPlayPause: () => actions.togglePause(),
    MediaPlay: () => actions.play(),
    MediaPause: () => actions.pause(),
    MediaStop: () => actions.stop(),
    AudioVolumeMute: () => actions.mute(),
    AudioVolumeUp: () => actions.volume(1),
    AudioVolumeDown: () => actions.volume(-1),
    ChannelUp: () => actions.channel(1),
    ChannelDown: () => actions.channel(-1),
    MediaTrackNext: () => actions.channel(1),
    MediaTrackPrevious: () => actions.channel(-1),
    ...(actions.rewind ? { MediaRewind: () => actions.rewind!() } : {}),
    BrowserBack: () => actions.back(),
    GoBack: () => actions.back(),
  };
  const keydown = (event: KeyboardEvent): void => {
    const action = bindings[event.key];
    if (!action || event.defaultPrevented) return;
    const volume = event.key.startsWith('AudioVolume');
    const back = ['BrowserBack', 'GoBack'].includes(event.key);
    if (document.querySelector('dialog[open]') && !volume && !back) return;
    event.preventDefault();
    if (event.repeat && !volume && !event.key.startsWith('Channel')) return;
    try {
      Promise.resolve(action()).catch(() => actions.failed());
    } catch {
      actions.failed();
    }
  };
  document.addEventListener('keydown', keydown);
  return () => document.removeEventListener('keydown', keydown);
}
