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
 * The player: the playback controller and its engines, the Paid TV player,
 * and the playback diagnostics exposed for tests. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { type NativeEngineHost } from '../../playback/native-vod-engine';
import { PlaybackController } from '../../playback/controller';
import { accountOnDemand, createRoutingEngineFactory } from '../../playback/routing-engine';
import { createBrowserEngineFactory, readVideoQuality } from '../../platform/browser-engine';
import { inspectSource } from '../../platform/records';
import { createNativeVodEngine } from '../../playback/native-vod-engine';
import { createNativeLiveEngine, nativeLiveRelay } from '../../playback/native-live-engine';
import { createAccountPlayer } from '../accounts/account-player';
import { playbackResourceOwners } from '../../playback/resource-owners';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { startTiming } from '../../playback/start-timing';
import { type createBootstrapBoundary } from '../shell/bootstrap-boundary';
import { type createCatalogView } from '../catalog/catalog-view';
import { type createArchivePlayer } from '../genxtra/archive-player';

/** What this area reads from, and writes back to, the rest of the application. */
export interface PlaybackSetupEnvironment {
  readonly bootstrapBoundary: ReturnType<typeof createBootstrapBoundary>;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly playbackAllowsHttp: (url: string) => boolean;
  readonly archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
  accountPlayer: ReturnType<typeof createAccountPlayer> | undefined;
  readonly nativePicture: NativeEngineHost | null;
  readonly notice: ReturnType<typeof createCatalogView>['notice'];
}

export function createPlaybackSetup(env: PlaybackSetupEnvironment) {
  // Created just before this, and never replaced.
  const nativePicture = env.nativePicture;
  const player = env.bootstrapBoundary.run(
    'playback',
    () =>
      new PlaybackController(
        createRoutingEngineFactory(
          createBrowserEngineFactory(
            env.element<HTMLVideoElement>('video'),
            (url, signal) => inspectSource(url, env.playbackAllowsHttp(url), signal),
            {
              allowHttp: env.playbackAllowsHttp,
              preferNativeHls: false,
              requestAllowed: (url) =>
                env.archivePlayer?.selection
                  ? env.archivePlayer.allowsRequest(url)
                  : env.accountPlayer?.selection
                    ? env.accountPlayer.allowsRequest(url)
                    : true,
            },
          ),
          nativePicture ? (emit) => createNativeVodEngine(emit, nativePicture) : null,
          accountOnDemand,
          // Live channels whose MPEG-2 picture the WebView cannot show.
          nativePicture
            ? (emit) =>
                createNativeLiveEngine(
                  emit,
                  nativePicture,
                  nativeLiveRelay,
                  env.playbackAllowsHttp,
                  () =>
                    env.notice(
                      'This channel is playing without sound: this device cannot decode its audio format.',
                    ),
                  // Live channels reach this player for their MPEG-2 picture; a
                  // phone without an MPEG-2 decoder (Galaxy S25) plays only the sound.
                  () => {
                    env.notice(
                      'This channel’s picture is MPEG-2, which this device cannot show. Its sound plays; Android TVs show the picture.',
                    );
                    // Kept on the black picture while this channel plays.
                    const note = env.element('picture-note');
                    note.textContent = 'MPEG-2 picture · sound only on this device';
                    note.dataset.channel = player.snapshot.selection?.id ?? '';
                    note.hidden = false;
                  },
                )
            : null,
        ),
      ),
  );
  env.accountPlayer = createAccountPlayer({ player });
  // Read-only, redacted ownership evidence for deterministic packaged diagnostics.
  // This exposes no channels, addresses, credentials, commands or mutable registry.
  Object.defineProperty(window, '__GENX_PLAYBACK_OWNERS__', {
    get: () => playbackResourceOwners.snapshot(),
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(window, '__GENX_VIDEO_QUALITY__', {
    get: () => readVideoQuality(env.element<HTMLVideoElement>('video')),
    enumerable: false,
    configurable: false,
  });
  // Measurement only: when each stage of the latest channel starts happened.
  // A Paid TV start also gets the local relay's times (provider and player bytes).
  if (isTauri())
    startTiming.enrichAccountStarts((add) => {
      void invoke<{
        requestMs: number;
        playerRequestMs: number | null;
        preopened: boolean;
        freshRuns: number;
        upstreamHeadersMs: number | null;
        upstreamFirstByteMs: number | null;
        playerFirstByteMs: number | null;
        busyRetries: number;
        hops: Array<{
          dnsMs: number;
          connectMs: number | null;
          serverWaitMs: number;
          https: boolean;
          status: number;
        }>;
      } | null>('account_playback_start_timing')
        .then((relay) => {
          if (!relay) return;
          add.wallStage('relay-request', relay.requestMs);
          add.wallStage('player-request', relay.playerRequestMs);
          add.fact('preopened', relay.preopened);
          add.fact('fresh-runs', relay.freshRuns);
          add.wallStage('upstream-headers', relay.upstreamHeadersMs);
          add.wallStage('upstream-first-byte', relay.upstreamFirstByteMs);
          add.wallStage('player-first-byte', relay.playerFirstByteMs);
          add.fact('provider-busy-retries', relay.busyRetries);
          // The provider stage split: DNS, connect, redirects and server wait.
          const hops = relay.hops;
          add.fact('redirects', Math.max(0, hops.length - 1));
          const total = (pick: (hop: (typeof hops)[number]) => number | null) =>
            Math.round(hops.reduce((sum, hop) => sum + (pick(hop) ?? 0), 0));
          add.fact(
            'dns-ms',
            total((hop) => hop.dnsMs),
          );
          add.fact(
            'connect-ms',
            total((hop) => hop.connectMs),
          );
          add.fact(
            'server-wait-ms',
            total((hop) => hop.serverWaitMs),
          );
          hops.forEach((hop, index) => {
            const name = `hop${index + 1}`;
            add.fact(`${name}-dns-ms`, Math.round(hop.dnsMs));
            if (hop.connectMs !== null) add.fact(`${name}-connect-ms`, Math.round(hop.connectMs));
            add.fact(`${name}-wait-ms`, Math.round(hop.serverWaitMs));
            add.fact(`${name}-status`, hop.status);
            add.fact(`${name}-https`, hop.https);
          });
        })
        .catch(() => undefined);
    });
  Object.defineProperty(window, '__GENX_START_TIMING__', {
    get: () => startTiming.snapshot(),
    enumerable: false,
    configurable: false,
  });
  return {
    player,
  };
}
