/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * The player as the viewer sees it: the picture panel's state and messages,
 * on-demand transport controls (seek, rewind, forward), instant replay, the
 * Cast button and playback health records. Moved out of main.ts; main.ts
 * passes the shared state it owns through the environment.
 */
import { restoreRemoteFocus } from '../../ui/shell/remote-navigation';
import { type LiveReplayControls } from '../../ui/player/live-replay';
import { type PlaybackController, type PlaybackSnapshot } from '../../playback/controller';
import { playbackFailureGuidance } from '../../playback/failure-guidance';
import { PICTURE_ART } from '../../ui/shell/shell';
import { createChannelCategoryResolver, type Preferences } from '../../preferences';
import { createPlaybackHealthCapture } from './playback-health';
import { DECODER_HEALTH_PROFILE } from '../health/health-profile';
import { isRecordRevisionConflict, readRecordPair, writeHealth } from '../../platform/records';
import { type installVODDock } from '../../ui/player/vod-dock';
import { type createDiagnostics } from '../../diagnostics/native';
import { type createActivityWakePolicy } from './activity-wake';
import { type createAccountBrowser } from '../accounts/account-browser';
import { type mountGuide } from '../../ui/guide/guide';
import { type createScanController } from '../discovery/scan-controller';
import { type createSharingHost } from '../sharing/sharing-host';
import { type ContentLibrary } from '../genxtra/content-library';
import { type createArchivePlayer } from '../genxtra/archive-player';
import { type PrimaryPage } from '../shell/primary-page';
import { type mountArchiveSearch } from '../../ui/genxtra/archive-search';
import type { AccountPlaybackChoice, createAccountPlayer } from '../accounts/account-player';
import { type ArchiveSelection } from '../../platform/archive-catalog';
import { type mountLocalStreams } from '../../ui/scan/local-streams';
import { type mountVODStop } from '../../ui/player/vod-stop';
import { type AccountPreferencesReceipt } from '../../platform/account-preferences';
import { type ChannelBrowser } from '../../ui/channels/channel-browser';
import { type CatalogRecord } from '../../catalog';

/** What this area reads from, and writes back to, the rest of the application. */
export interface PlayerViewEnvironment {
  readonly player: PlaybackController;
  readonly vodDock: ReturnType<typeof installVODDock>;
  readonly contentLibrary: ContentLibrary;
  readonly applicationClosing: boolean;
  readonly nativeViewingForeground: boolean;
  readonly archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly backgroundSuspension: Promise<void> | null;
  readonly primaryPage: PrimaryPage;
  readonly notice: (message: string) => void;
  readonly playbackAction: (work: Promise<unknown>) => void;
  readonly archiveSearch: ReturnType<typeof mountArchiveSearch> | undefined;
  readonly diagnostics: ReturnType<typeof createDiagnostics>;
  readonly accountPlayer: ReturnType<typeof createAccountPlayer> | undefined;
  readonly activityWake: ReturnType<typeof createActivityWakePolicy>;
  readonly backgroundLiveChoice:
    | { kind: 'public'; selection: NonNullable<PlaybackSnapshot['selection']> }
    | { kind: 'account'; choice: AccountPlaybackChoice }
    | null;
  readonly archiveBackgroundPaused: boolean;
  readonly archiveResumeChoice: ArchiveSelection | null;
  readonly updatePreviewControl: () => void;
  readonly localStreams: ReturnType<typeof mountLocalStreams> | undefined;
  readonly vodStopControl: ReturnType<typeof mountVODStop> | undefined;
  readonly accountVodSelected: () => boolean;
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  readonly accountPreferenceWork: Promise<AccountPreferencesReceipt> | null;
  readonly settings: Preferences;
  readonly castButton: HTMLButtonElement;
  readonly castingAvailable: boolean;
  readonly privatePlayback: (selection: PlaybackSnapshot['selection']) => boolean;
  renderedSelection: string | null;
  readonly guide: ReturnType<typeof mountGuide>;
  readonly browser: ChannelBrowser;
  readonly catalog: CatalogRecord;
  readonly persistedCatalogRevision: string;
  readonly scanController: ReturnType<typeof createScanController>;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  catalogWrites: Promise<unknown>;
}

export function createPlayerView(env: PlayerViewEnvironment) {
  const finitePlayback = env.player;
  let vodSeekWork: Promise<void> | null = null;
  let vodSeekGeneration = 0;
  const vodPositionEvents = [
    'timeupdate',
    'loadedmetadata',
    'seeked',
    'durationchange',
    'emptied',
    'playing',
    'pause',
  ] as const;
  function renderVODTransport(): void {
    env.vodDock.render(
      env.player.snapshot.selection
        ? env.player.snapshot.selection.playMode === 'on-demand'
        : env.contentLibrary === 'genxtra',
    );
    const active =
      !env.applicationClosing &&
      !document.hidden &&
      env.nativeViewingForeground &&
      !!env.archivePlayer?.selection &&
      env.player.snapshot.selection?.playMode === 'on-demand' &&
      ['playing', 'paused', 'buffering'].includes(env.player.snapshot.state);
    // Written only when changed: this runs several times a second while playing.
    const root = env.element('vod-transport');
    if (root.hidden !== !active) root.hidden = !active;
    const position = active ? (finitePlayback.currentVODposition?.() ?? null) : null;
    const valid =
      position !== null && Number.isFinite(position) && position >= 0 && position <= 604800;
    const shown = env.element('vod-position');
    const text = valid
      ? `${Math.floor(position / 60)}:${String(Math.floor(position % 60)).padStart(2, '0')}`
      : '—:—';
    if (shown.textContent !== text) shown.textContent = text;
    const label = valid ? 'Current playback position' : 'Playback position unavailable';
    if (shown.getAttribute('aria-label') !== label) shown.setAttribute('aria-label', label);
    const rewind = env.element<HTMLButtonElement>('vod-rewind');
    const forward = env.element<HTMLButtonElement>('vod-forward');
    const rewindDisabled = !valid || position <= 0 || !!vodSeekWork;
    const forwardDisabled = !valid || !!vodSeekWork;
    const focused = document.activeElement;
    if (
      active &&
      !env.backgroundSuspension &&
      env.primaryPage === 'watch' &&
      !document.querySelector('dialog[open]') &&
      !root.closest('[hidden],[inert]') &&
      root.checkVisibility({ visibilityProperty: true }) &&
      ((focused === rewind && rewindDisabled) || (focused === forward && forwardDisabled))
    ) {
      // Native disabled controls may lose focus before the next key. Keep this
      // handoff local and synchronous; seek completion never restores old focus.
      restoreRemoteFocus(env.element('pause-button'), env.element('mute-button'));
    }
    if (rewind.disabled !== rewindDisabled) rewind.disabled = rewindDisabled;
    if (forward.disabled !== forwardDisabled) forward.disabled = forwardDisabled;
  }
  async function seekVODRelative(distance: number): Promise<void> {
    if (
      vodSeekWork ||
      env.applicationClosing ||
      document.hidden ||
      !env.nativeViewingForeground ||
      !env.archivePlayer?.selection ||
      !finitePlayback.seek
    )
      return;
    const position = finitePlayback.currentVODposition?.();
    if (position == null) return;
    const generation = vodSeekGeneration;
    const work = (async () => {
      const result = await finitePlayback.seek!(Math.max(0, position + distance));
      if (generation !== vodSeekGeneration || env.applicationClosing) return;
      if (!result.ok && result.reason !== 'superseded')
        env.notice(
          result.reason === 'out-of-range'
            ? 'That position is not available in this video yet.'
            : 'Seeking is not available for this video right now.',
        );
    })();
    vodSeekWork = work;
    renderVODTransport();
    try {
      await work;
    } finally {
      if (vodSeekWork === work) vodSeekWork = null;
      renderVODTransport();
    }
  }
  const vodRewind = () => env.playbackAction(seekVODRelative(-10));
  const vodForward = () => env.playbackAction(seekVODRelative(10));
  for (const event of vodPositionEvents)
    env.element('video').addEventListener(event, renderVODTransport);
  env.element('vod-rewind').addEventListener('click', vodRewind);
  env.element('vod-forward').addEventListener('click', vodForward);
  /** Instant replay on live TV (docs/instant-replay.md); installed with the dock's handlers. */
  let liveReplay: LiveReplayControls | null = null;
  async function disposeVODTransport(): Promise<void> {
    liveReplay?.dispose();
    env.vodDock.dispose();
    vodSeekGeneration++;
    for (const event of vodPositionEvents)
      env.element('video').removeEventListener(event, renderVODTransport);
    env.element('vod-rewind').removeEventListener('click', vodRewind);
    env.element('vod-forward').removeEventListener('click', vodForward);
    await vodSeekWork;
  }
  let playbackFailureLogged = false;
  let alternateRetry: Promise<boolean> | null = null;
  function renderPlayer(snapshot: PlaybackSnapshot): void {
    env.archiveSearch?.syncDetails();
    // The sound-only note belongs to the channel that raised it.
    const pictureNote = env.element('picture-note');
    if (
      !pictureNote.hidden &&
      (pictureNote.dataset.channel !== snapshot.selection?.id ||
        ['idle', 'failed', 'disposed'].includes(snapshot.state))
    )
      pictureNote.hidden = true;
    if (env.contentLibrary !== 'genxtra') env.element('archive-details').hidden = true;
    if (snapshot.state === 'connecting' || snapshot.state === 'disposed') vodSeekGeneration++;
    renderVODTransport();
    if (snapshot.state === 'failed' && !playbackFailureLogged)
      void env.diagnostics.emit({ operation: 'playback', level: 'error', code: 'playback-failed' });
    playbackFailureLogged = snapshot.state === 'failed';
    // Paid TV only: a start that delivered no video tries the provider's other
    // stored format once (never a guessed address; Free TV never reaches this).
    if (snapshot.state === 'failed' && env.accountPlayer?.alternateAvailable && !alternateRetry) {
      alternateRetry = env.accountPlayer
        .retryAlternate()
        .catch(() => false)
        .finally(() => {
          alternateRetry = null;
        });
    }
    const focusedControl = document.activeElement;
    const viewingActive =
      !document.hidden &&
      !env.backgroundSuspension &&
      !env.applicationClosing &&
      (snapshot.state === 'playing' || snapshot.state === 'buffering');
    void env.activityWake.setPlayback(viewingActive).catch(() => undefined);
    const resumeChoice = ['failed', 'disposed'].includes(snapshot.state)
      ? null
      : env.backgroundLiveChoice;
    const selection = resumeChoice?.kind === 'public' ? resumeChoice.selection : snapshot.selection;
    const archived = selection?.playMode === 'on-demand';
    const failureGuidance =
      snapshot.state === 'failed'
        ? playbackFailureGuidance(snapshot.failure, { playMode: archived ? 'on-demand' : 'live' })
        : null;
    env.element('watch-title').textContent =
      selection?.name ??
      (resumeChoice?.kind === 'account' ? resumeChoice.choice.channel.name : undefined) ??
      (env.archiveBackgroundPaused ? env.archiveResumeChoice?.fileTitle : undefined) ??
      'Make yourself comfortable.';
    env.element('playback-status').textContent = resumeChoice
      ? 'Paused'
      : {
          idle: 'Ready when you are',
          connecting: 'Connecting…',
          playing: 'Playing',
          buffering: 'Buffering…',
          paused: 'Paused',
          reconnecting: 'Reconnecting…',
          failed: 'Unable to play',
          disposed: 'Player closed',
        }[snapshot.state];
    const overlay = env.element('player-overlay');
    const backgroundPaused =
      resumeChoice !== null ||
      (snapshot.state === 'paused' && snapshot.pauseReason === 'background') ||
      (env.archiveBackgroundPaused && snapshot.state === 'idle');
    // The picture's states, each with the owner's artwork (October 19, 2026):
    // nothing playing → play screen; opening, buffering or reconnecting → the
    // buffering screen; failed → could not connect, whose painted TRY AGAIN is
    // the real Retry button. A stall during playback shows only after a moment
    // (CSS delay on data-wait), so brief hiccups never flash it.
    const busy =
      !!selection &&
      !backgroundPaused &&
      ['idle', 'connecting', 'buffering', 'reconnecting'].includes(snapshot.state);
    const art =
      backgroundPaused || snapshot.state === 'paused'
        ? 'paused'
        : snapshot.state === 'failed'
          ? 'failed'
          : busy
            ? 'buffering'
            : !selection && snapshot.state === 'idle'
              ? 'play'
              : 'none';
    overlay.hidden = !backgroundPaused && snapshot.state === 'playing';
    // Paused: the painted PRESS PLAY TO RESUME is a real Resume; the artwork says
    // PAUSED, so words show only when GenX paused in the background.
    env.element('picture-resume').hidden = art !== 'paused';
    overlay.toggleAttribute('data-quiet', art === 'paused' && !backgroundPaused);
    if (overlay.dataset.art !== art) {
      overlay.dataset.art = art;
      const image = overlay.querySelector<HTMLImageElement>('.picture-image');
      if (image && art !== 'none') image.src = PICTURE_ART[art];
    }
    overlay.toggleAttribute('data-wait', snapshot.state === 'buffering');
    // Nothing chosen to play: the right-panel Guide does not keep an empty picture box.
    env.element('app').dataset.playerIdle = String(!selection && snapshot.state === 'idle');
    env.updatePreviewControl();
    env.element('welcome-icon').hidden = !!selection || art !== 'none';
    env.element('overlay-title').textContent = backgroundPaused
      ? 'Playback paused'
      : snapshot.state === 'failed'
        ? failureGuidance!.title
        : selection
          ? snapshot.state === 'buffering'
            ? 'Buffering…'
            : snapshot.state === 'reconnecting'
              ? 'Reconnecting…'
              : archived
                ? 'Opening your video…'
                : 'Opening your channel…'
          : env.contentLibrary === 'genxtra'
            ? 'Your next favorite show.'
            : 'Your next favorite channel.';
    env.element('overlay-message').textContent = backgroundPaused
      ? env.archiveBackgroundPaused
        ? 'Playback stopped in the background. Resume opens this file from the beginning.'
        : 'Playback paused in the background. Resume reconnects to this channel.'
      : (failureGuidance?.explanation ??
        snapshot.error ??
        (selection
          ? 'Waiting for the stream to begin.'
          : env.contentLibrary === 'genxtra'
            ? 'Browse a decade, or search for shows and movies.'
            : 'Choose a channel, or use channel search to discover more.'));
    env.element('retry-button').hidden = snapshot.state !== 'failed';
    const pause = env.element<HTMLButtonElement>('pause-button');
    pause.disabled =
      !resumeChoice &&
      !env.archiveBackgroundPaused &&
      !env.localStreams?.pageOpen &&
      !['playing', 'paused', 'buffering'].includes(snapshot.state) &&
      // Resuming passes through Connecting: disabling Pause there moved the
      // remote's focus to Mute (Sansui, October 19, 2026). The player pauses a
      // connecting channel safely, so Pause stays usable while a channel is chosen.
      !(selection && ['connecting', 'reconnecting'].includes(snapshot.state));
    pause.textContent =
      snapshot.state === 'paused' || env.archiveBackgroundPaused || resumeChoice
        ? 'Resume'
        : 'Pause';
    pause.dataset.icon = pause.textContent === 'Resume' ? 'play' : 'pause';
    env.vodStopControl?.render(
      env.contentLibrary === 'genxtra' || env.accountVodSelected(),
      !!env.archivePlayer?.selection || env.accountVodSelected(),
    );
    const favorite = env.element<HTMLButtonElement>('favorite-button');
    const accountRow = selection ? env.accountBrowser.selectionFor(selection.id) : undefined;
    favorite.disabled =
      env.backgroundLiveChoice !== null ||
      archived ||
      !selection ||
      (!!env.accountPlayer?.selection && (!accountRow || !!env.accountPreferenceWork));
    const isFavorite = accountRow
      ? accountRow.favorite
      : !!selection && env.settings.favorites.includes(selection.id);
    favorite.textContent = isFavorite ? '★ Favorited' : '☆ Favorite';
    favorite.setAttribute('aria-pressed', String(isFavorite));
    env.element<HTMLButtonElement>('remove-channel').disabled =
      env.backgroundLiveChoice !== null ||
      archived ||
      !selection ||
      (!!env.accountPlayer?.selection && (!accountRow || !!env.accountPreferenceWork));
    env.element<HTMLButtonElement>('restore-channels').disabled = env.accountBrowser.selectedAccount
      ? !env.accountBrowser.preferenceScope() || !!env.accountPreferenceWork
      : env.settings.removedChannels.length === 0;
    env.castButton.disabled =
      !!env.backgroundLiveChoice || !env.castingAvailable || env.privatePlayback(selection);
    if (
      focusedControl instanceof HTMLButtonElement &&
      focusedControl.disabled &&
      focusedControl.closest('.view')
    )
      restoreRemoteFocus(null, env.element('mute-button'));
    const selectedId = selection?.id ?? null;
    if (selectedId !== env.renderedSelection) {
      env.renderedSelection = selectedId;
      env.guide.selectedChannelChanged();
      const removed = new Set(env.settings.removedChannels);
      const category = createChannelCategoryResolver(env.settings);
      if (env.contentLibrary === 'live')
        env.browser.update(
          env.catalog.channels
            .filter((channel) => !removed.has(channel.id))
            .map((channel) =>
              category(channel) === channel.category
                ? channel
                : { ...channel, category: category(channel) },
            ),
          env.settings.favorites,
          selectedId,
        );
    }
  }
  env.player.subscribe(renderPlayer);
  let healthCaptureClosing = false;
  const playbackHealth = createPlaybackHealthCapture({
    player: env.player,
    resolve: (selection) => {
      if (healthCaptureClosing || env.element('app').dataset.ready !== 'true') return null;
      const channel = env.catalog.channels.find((entry) => entry.id === selection.id);
      if (!channel || !channel.urls.includes(selection.url)) return null;
      const source = env.catalog.sources.find((entry) => entry.id === channel.sourceId);
      if (!source) return null;
      return {
        channel: structuredClone(channel),
        source: structuredClone(source),
        catalogRevision: env.persistedCatalogRevision,
      };
    },
    context: () =>
      env.scanController.healthPlatform === null || healthCaptureClosing || document.hidden
        ? null
        : {
            platform: env.scanController.healthPlatform,
            observerProfile: DECODER_HEALTH_PROFILE,
            scope: String(env.sharingBridge.host.snapshot().generation),
          },
    isContextCurrent: (context) =>
      !healthCaptureClosing &&
      !document.hidden &&
      env.element('app').dataset.ready === 'true' &&
      context.platform === env.scanController.healthPlatform &&
      context.observerProfile === DECODER_HEALTH_PROFILE &&
      context.scope === String(env.sharingBridge.host.snapshot().generation),
    readRecordPair: async (signal) => {
      signal.throwIfAborted();
      const saved = await readRecordPair();
      signal.throwIfAborted();
      return saved;
    },
    writeHealth: (request, signal) =>
      writeHealth(
        request.health,
        request.expectedCatalogRevision,
        request.expectedHealthRevision,
        signal,
      ),
    isRevisionConflict: isRecordRevisionConflict,
    enqueue: (action) => {
      const work = env.catalogWrites.then(action);
      env.catalogWrites = work.catch(() => undefined);
      return work;
    },
    now: () => Date.now(),
    notice: env.notice,
  });
  return {
    renderPlayer,
    get liveReplay() {
      return liveReplay;
    },
    set liveReplay(value: typeof liveReplay) {
      liveReplay = value;
    },
    vodRewind,
    get vodSeekGeneration() {
      return vodSeekGeneration;
    },
    set vodSeekGeneration(value: typeof vodSeekGeneration) {
      vodSeekGeneration = value;
    },
    renderVODTransport,
    get vodSeekWork() {
      return vodSeekWork;
    },
    disposeVODTransport,
    get healthCaptureClosing() {
      return healthCaptureClosing;
    },
    set healthCaptureClosing(value: typeof healthCaptureClosing) {
      healthCaptureClosing = value;
    },
    playbackHealth,
  };
}
