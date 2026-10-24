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
 * Timeline guide in a real browser: the listed bridge, malformed listings
 * and channel cards.
 */
import { describe, expect, it } from 'vitest';
import { type ProgramQuery } from '../../src/guide/native';
import { type TimelineChannel } from '../../src/ui/guide/guide-timeline-model';
import { useTimelineBrowser, fixture, listedBridgeBundle } from './timeline-browser.fixture';

useTimelineBrowser();

describe('actual timeline component', () => {
  it('listed membership hides old-window rows, joins an obsolete request and cannot steal later navigation focus', async () => {
    const page = await fixture(false, true);
    try {
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        Reflect.set(window, 'listedCalls', []);
        Reflect.set(window, 'listedSignals', []);
        host.listedChannels = async (start: number, end: number, signal: AbortSignal) => {
          const calls = Reflect.get(window, 'listedCalls');
          calls.push([start, end]);
          Reflect.get(window, 'listedSignals').push(signal);
          const n = calls.length;
          if (n === 2)
            await new Promise<void>((resolve) => Reflect.set(window, 'releaseListed', resolve));
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: [
              {
                catalogSourceId: 's',
                appChannelId: n === 3 ? 'c21' : 'c20',
                guideSourceId: 'g',
                xmltvChannelId: n === 3 ? 'x21' : 'x20',
                sourceRevision: 1,
              },
            ],
          };
        };
        host.query = async (q: ProgramQuery) => ({
          programs: [
            {
              catalogSourceId: 's',
              appChannelId: q.appChannelIds[0],
              guideSourceId: 'g',
              xmltvChannelId: 'x' + q.appChannelIds[0].slice(1),
              startMs: q.windowStartMs,
              stopMs: q.windowEndMs,
              title: 'Window listing',
              description: null,
              ordinal: 0,
            },
          ],
          nextCursor: null,
          sourceRevision: 1,
          databaseRevision: 1,
        });
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(
        await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
      ).toEqual(['Channel 20']);
      await page.getByRole('button', { name: 'Next 3 hours', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'listedCalls').length))
        .toBe(2);
      expect(await page.locator('.gx-timeline-row').count()).toBe(0);
      expect(await page.locator('.gx-timeline-status').textContent()).toBe(
        'Checking saved listings…',
      );
      const later = page.getByRole('button', { name: 'Next day', exact: true });
      await later.click();
      expect(await page.evaluate(() => Reflect.get(window, 'listedSignals')[1].aborted)).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls').length)).toBe(2);
      await page.evaluate(() => Reflect.get(window, 'releaseListed')());
      await expect
        .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
        .toEqual(['Channel 21']);
      expect(await later.evaluate((node) => node === document.activeElement)).toBe(true);
      expect(
        await page.evaluate(() =>
          Reflect.get(window, 'listedCalls').map(
            (q: number[]) => q[0] - Reflect.get(window, 'base'),
          ),
        ),
      ).toEqual([0, 10800000, 97200000]);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('listed membership suspension joins the original held request and suppresses its late publication', async () => {
    const page = await fixture(false, true);
    try {
      await page.evaluate(() => {
        Reflect.set(window, 'listedCalls', 0);
        Reflect.set(window, 'listedStopped', false);
        Reflect.get(window, 'host').listedChannels = async (
          _start: number,
          _end: number,
          signal: AbortSignal,
        ) => {
          Reflect.set(window, 'listedCalls', Reflect.get(window, 'listedCalls') + 1);
          Reflect.set(window, 'listedSignal', signal);
          if (Reflect.get(window, 'listedCalls') === 1)
            await new Promise<void>((resolve) => Reflect.set(window, 'releaseListed', resolve));
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: [
              {
                catalogSourceId: 's',
                appChannelId: 'c20',
                guideSourceId: 'g',
                xmltvChannelId: 'x20',
                sourceRevision: 1,
              },
            ],
          };
        };
        Reflect.set(window, 'listedStart', Reflect.get(window, 'owner').setForeground(true));
      });
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'listedCalls'))).toBe(1);
      await page.evaluate(() => {
        Reflect.set(
          window,
          'listedStop',
          Reflect.get(window, 'owner')
            .suspend()
            .then(() => Reflect.set(window, 'listedStopped', true)),
        );
      });
      expect(await page.evaluate(() => Reflect.get(window, 'listedSignal').aborted)).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'listedStopped'))).toBe(false);
      await page.evaluate(async () => {
        Reflect.get(window, 'releaseListed')();
        await Reflect.get(window, 'listedStop');
      });
      expect(await page.locator('.gx-timeline-row').count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls'))).toBe(2);
      expect(
        await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
      ).toEqual(['Channel 20']);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it.each(['canceled', 'guide-cancelled', 'application-closing', 'database-busy', 'ack-failed'])(
    'real listed bridge cancellation joins producer and acknowledgement before Timeline reopen (%s)',
    async (outcome) => {
      const page = await fixture(false, true);
      try {
        await page.addScriptTag({ content: listedBridgeBundle });
        await page.evaluate(() => {
          // setContent uses an opaque origin; supply the secure-context UUID primitive used by IPC.
          if (!crypto.randomUUID)
            crypto.randomUUID = () =>
              '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (digit) =>
                (
                  Number(digit) ^
                  (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(digit) / 4)))
                ).toString(16),
              ) as `${string}-${string}-${string}-${string}-${string}`;
          Reflect.set(window, 'isTauri', true);
          Reflect.set(window, 'nativeMembershipCalls', 0);
          Reflect.set(window, 'nativeRequestIds', []);
          Reflect.set(window, 'nativeCancelIds', []);
          Reflect.set(window, 'suspendSettled', false);
          Reflect.set(window, '__TAURI_INTERNALS__', {
            invoke: async (
              command: string,
              args: { requestId: string; query?: { startMs: number; endMs: number } },
            ) => {
              if (command === 'cancel_playlist') {
                Reflect.get(window, 'nativeCancelIds').push(args.requestId);
                return new Promise<void>((resolve, reject) => {
                  Reflect.set(window, 'finishNativeCancel', resolve);
                  Reflect.set(window, 'failNativeCancel', reject);
                });
              }
              if (command !== 'guide_listed_channels') throw new Error('Unexpected native command');
              const count = Reflect.get(window, 'nativeMembershipCalls') + 1;
              Reflect.set(window, 'nativeMembershipCalls', count);
              Reflect.get(window, 'nativeRequestIds').push(args.requestId);
              if (count === 1)
                return new Promise<never>((_resolve, reject) =>
                  Reflect.set(window, 'rejectNativeMembership', reject),
                );
              return {
                startMs: args.query!.startMs,
                endMs: args.query!.endMs,
                rootGeneration: 1,
                catalogRevision: '1',
                databaseRevision: 1,
                viewRevision: '11',
                groupingPolicy: 'exact-ordered-endpoints-policy-v2',
                channels: [
                  {
                    catalogSourceId: 's',
                    appChannelId: 'c20',
                    guideSourceId: 'g',
                    xmltvChannelId: 'x20',
                    sourceRevision: 1,
                    filterMask: 0,
                  },
                ],
                nextCursor: null,
              };
            },
          });
          Reflect.get(window, 'host').listedChannels = Reflect.get(
            window,
            'ListedBridge',
          ).readListedGuideChannels;
          Reflect.set(
            window,
            'initialMembership',
            Reflect.get(window, 'owner')
              .setForeground(true)
              .catch(() => {}),
          );
        });
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'nativeMembershipCalls')))
          .toBe(1);
        await page.evaluate(() => {
          Reflect.set(
            window,
            'suspendReceipt',
            Reflect.get(window, 'owner')
              .suspend()
              .then(
                () => {
                  Reflect.set(window, 'suspendSettled', true);
                  return null;
                },
                (error: unknown) => {
                  Reflect.set(window, 'suspendSettled', true);
                  return String(error);
                },
              ),
          );
        });
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'nativeCancelIds').length))
          .toBe(1);
        expect(await page.evaluate(() => Reflect.get(window, 'nativeCancelIds')[0])).toBe(
          await page.evaluate(() => Reflect.get(window, 'nativeRequestIds')[0]),
        );
        expect(await page.evaluate(() => Reflect.get(window, 'suspendSettled'))).toBe(false);
        await page.evaluate(
          (code) =>
            Reflect.get(
              window,
              'rejectNativeMembership',
            )(code === 'ack-failed' ? 'canceled' : code),
          outcome,
        );
        // The original command has settled; the separately held matching ACK still owns cleanup.
        expect(await page.evaluate(() => Reflect.get(window, 'suspendSettled'))).toBe(false);
        expect(await page.locator('.gx-timeline-row').count()).toBe(0);
        expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
        const failure = await page.evaluate(async (code) => {
          if (code === 'ack-failed')
            Reflect.get(window, 'failNativeCancel')(new Error('ACK refused'));
          else Reflect.get(window, 'finishNativeCancel')();
          return Reflect.get(window, 'suspendReceipt');
        }, outcome);
        if (outcome === 'database-busy' || outcome === 'ack-failed') {
          expect(failure).toContain('cancellation could not finish');
          expect(
            await page.evaluate(async () => {
              try {
                await Reflect.get(window, 'owner').setForeground(true);
                return null;
              } catch (error) {
                return String(error);
              }
            }),
          ).toContain('cancellation could not finish');
          expect(await page.evaluate(() => Reflect.get(window, 'nativeMembershipCalls'))).toBe(1);
          expect(await page.locator('.gx-timeline-row').count()).toBe(0);
        } else {
          expect(failure).toBeNull();
          await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
          expect(await page.evaluate(() => Reflect.get(window, 'nativeMembershipCalls'))).toBe(2);
          expect(
            await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
          ).toEqual(['Channel 20']);
          expect(
            await page.getByRole('button', { name: 'Current listing', exact: true }).count(),
          ).toBe(1);
        }
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      } finally {
        // Explicit cleanup failures remain errors in the assertions above; close the isolated browser fixture.
        await page.evaluate(() =>
          Reflect.get(window, 'owner')
            .dispose()
            .catch(() => {}),
        );
        await page.close();
      }
    },
  );
  for (const malformed of [
    'catalog',
    'mapping',
    'source-revision',
    'duplicate',
    'malformed',
  ] as const)
    it(`listed membership rejects ${malformed} scope without publishing partial channels or a false empty state`, async () => {
      const page = await fixture(false, true);
      try {
        await page.evaluate((malformed) => {
          Reflect.get(window, 'host').listedChannels = async () => {
            const member = {
              catalogSourceId: 's',
              appChannelId: 'c20',
              guideSourceId: malformed === 'mapping' ? 'wrong' : 'g',
              xmltvChannelId: malformed === 'malformed' ? '' : 'x20',
              sourceRevision: malformed === 'source-revision' ? 2 : 1,
            };
            return {
              catalogRevision: malformed === 'catalog' ? '2' : '1',
              databaseRevision: 1,
              channels: malformed === 'duplicate' ? [member, member] : [member],
            };
          };
        }, malformed);
        await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
        expect(await page.locator('.gx-timeline-row').count()).toBe(0);
        expect(await page.locator('.gx-timeline-status').textContent()).toBe(
          'Guide could not refresh. Choose Now to retry.',
        );
        expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
      } finally {
        await page.evaluate(() => Reflect.get(window, 'owner').dispose());
        await page.close();
      }
    });
  it('listed membership keeps source identity exact instead of joining by app channel ID alone', async () => {
    const page = await fixture(false, true);
    try {
      await page.evaluate(() => {
        Reflect.get(window, 'host').listedChannels = async () => ({
          catalogRevision: '1',
          databaseRevision: 1,
          channels: [
            {
              catalogSourceId: 'other',
              appChannelId: 'c20',
              guideSourceId: 'g',
              xmltvChannelId: 'x20',
              sourceRevision: 1,
            },
          ],
        });
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(await page.locator('.gx-timeline-row').count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('listed membership invalidates on a changed programme revision and clears already rendered partial rows before retry', async () => {
    const page = await fixture(false, true);
    try {
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        Reflect.set(window, 'listedCalls', 0);
        Reflect.set(window, 'listedQueries', 0);
        Reflect.set(window, 'listedStable', false);
        const oldQuery = host.query;
        host.listedChannels = async () => {
          Reflect.set(window, 'listedCalls', Reflect.get(window, 'listedCalls') + 1);
          return {
            catalogRevision: '1',
            databaseRevision: Reflect.get(window, 'listedStable') ? 2 : 1,
            channels: [20, 21].map((i) => ({
              catalogSourceId: 's',
              appChannelId: 'c' + i,
              guideSourceId: 'g',
              xmltvChannelId: 'x' + i,
              sourceRevision: 1,
            })),
          };
        };
        host.query = async (q: ProgramQuery, signal: AbortSignal) => {
          Reflect.set(window, 'listedQueries', Reflect.get(window, 'listedQueries') + 1);
          const result = await oldQuery(q, signal);
          return {
            ...result,
            databaseRevision:
              Reflect.get(window, 'listedStable') || Reflect.get(window, 'listedQueries') === 2
                ? 2
                : 1,
          };
        };
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(await page.evaluate(() => Reflect.get(window, 'listedQueries'))).toBe(2);
      expect(await page.locator('.gx-timeline-row').count()).toBe(0);
      expect(await page.locator('.gx-timeline-status').textContent()).toBe(
        'Guide could not refresh. Choose Now to retry.',
      );
      await page.evaluate(() => Reflect.set(window, 'listedStable', true));
      await page.getByRole('button', { name: 'Now', exact: true }).click();
      await expect
        .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
        .toEqual(['Channel 20', 'Channel 21']);
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls'))).toBe(2);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('channel cards reuse admitted artwork with safe fallback and no extra focus or query work', async () => {
    const page = await fixture();
    try {
      await page.evaluate(async () => {
        const host = Reflect.get(window, 'host');
        Reflect.set(window, 'logoMode', 'safe');
        Reflect.set(window, 'logoVisible', []);
        Reflect.set(window, 'logoRejected', []);
        host.logos = {
          get: () =>
            Reflect.get(window, 'logoMode') === 'remote'
              ? 'https://private.fixture.invalid/logo.png'
              : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          visible: (rows: TimelineChannel[]) =>
            Reflect.set(
              window,
              'logoVisible',
              rows.map((c) => c.id),
            ),
          rejected: (c: TimelineChannel) => Reflect.get(window, 'logoRejected').push(c.id),
          suspend: async () => {
            Reflect.set(window, 'logoVisible', []);
          },
        };
        await Reflect.get(window, 'owner').refresh();
      });
      const card = page.locator('.gx-timeline-channel').first();
      expect(await card.locator('.media-result-title').textContent()).toBe('Channel 0');
      expect(await card.getAttribute('aria-label')).toBe('Channel 0');
      expect(await card.locator('.channel-logo-image').count()).toBe(1);
      expect(
        await card.evaluate((node) => {
          const outer = node.getBoundingClientRect();
          return ['.media-result-artwork', '.media-result-title', '.media-result-subtitle'].every(
            (selector) => {
              const r = node.querySelector(selector)!.getBoundingClientRect();
              return (
                r.width > 0 &&
                r.height > 0 &&
                r.left >= outer.left &&
                r.right <= outer.right &&
                r.top >= outer.top &&
                r.bottom <= outer.bottom
              );
            },
          );
        }),
      ).toBe(true);
      expect(await page.locator('.gx-timeline-row').first().locator('button').count()).toBe(3);
      await card.focus();
      const before = await page.evaluate(() => ({
        queries: Reflect.get(window, 'calls'),
        watches: Reflect.get(window, 'watches'),
      }));
      const obsoleteImage = await card.locator('img').elementHandle();
      await page.evaluate(() => Reflect.get(window, 'owner').refreshArtwork());
      await obsoleteImage!.evaluate((image) => image.dispatchEvent(new Event('error')));
      expect(await page.evaluate(() => Reflect.get(window, 'logoRejected'))).toEqual([]);
      expect(await card.evaluate((n) => n === document.activeElement)).toBe(true);
      expect(
        await page.evaluate(() => ({
          queries: Reflect.get(window, 'calls'),
          watches: Reflect.get(window, 'watches'),
        })),
      ).toEqual(before);
      await card.locator('img').dispatchEvent('error');
      expect(await card.locator('.media-result-artwork').textContent()).toBe('C0');
      expect(await page.evaluate(() => Reflect.get(window, 'logoRejected'))).toContain('c0');
      await page.evaluate(() => {
        Reflect.set(window, 'logoMode', 'remote');
        Reflect.get(window, 'owner').refreshArtwork();
      });
      expect(await card.locator('img').count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'logoVisible').length)).toBeGreaterThan(
        0,
      );
      await page.evaluate(() => Reflect.get(window, 'owner').suspend());
      expect(await page.evaluate(() => Reflect.get(window, 'logoVisible'))).toEqual([]);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('Guide artwork suspension joins its original owner and propagates unconfirmed cleanup', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        Reflect.get(window, 'host').logos = {
          get: () => null,
          visible: () => {},
          rejected: () => {},
          suspend: () =>
            new Promise((_resolve, reject) => Reflect.set(window, 'rejectArtwork', reject)),
        };
        Reflect.set(window, 'artworkSettled', false);
        Reflect.set(
          window,
          'artworkStop',
          Reflect.get(window, 'owner')
            .suspend()
            .then(
              () => Reflect.set(window, 'artworkSettled', true),
              () => Reflect.set(window, 'artworkSettled', 'refused'),
            ),
        );
      });
      await page.waitForFunction(() => typeof Reflect.get(window, 'rejectArtwork') === 'function');
      expect(await page.evaluate(() => Reflect.get(window, 'artworkSettled'))).toBe(false);
      await page.evaluate(async () => {
        Reflect.get(window, 'rejectArtwork')(new Error('owned artwork cancellation unconfirmed'));
        await Reflect.get(window, 'artworkStop');
      });
      expect(await page.evaluate(() => Reflect.get(window, 'artworkSettled'))).toBe('refused');
    } finally {
      await page.evaluate(() => {
        Reflect.get(window, 'host').logos.suspend = async () => {};
        return Reflect.get(window, 'owner').dispose();
      });
      await page.close();
    }
  });
});
