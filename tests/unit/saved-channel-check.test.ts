import { describe, expect, it } from 'vitest';
import {
  createSavedChannelCheck,
  dueChannels,
  type CheckOutcome,
  type SavedChannel,
  type SavedChannelCheckHost,
} from '../../src/application/saved-channel-check';
import {
  createChannelCheckStore,
  validateChannelChecks,
  type ChannelCheck,
  type ChannelObservation,
} from '../../src/platform/channel-checks';

const HOUR = 3_600_000;
const channel = (id: string, url = `https://example.test/${id}.m3u8`): SavedChannel => ({
  id,
  url,
  allowHttp: false,
});
const check = (id: string, checkedMs: number, failing = false): ChannelCheck => ({
  channelId: id,
  checkedMs,
  okMs: failing ? null : checkedMs,
  firstFailMs: failing ? checkedMs : null,
  lastFailMs: failing ? checkedMs : null,
  verdict: failing ? 'TimedOut' : 'Reachable',
  notResponding: false,
});

/** A host with an in-memory store that applies the native rules, for scheduling only. */
function harness(
  channels: SavedChannel[],
  outcomes: Record<string, CheckOutcome>,
  options: { idle?: () => boolean; seed?: ChannelCheck[] } = {},
) {
  let now = 100 * HOUR;
  const store = new Map((options.seed ?? []).map((c) => [c.channelId, c]));
  const probed: string[] = [];
  const recorded: ChannelObservation[][] = [];
  let published: ReadonlyMap<string, ChannelCheck> = new Map();
  let rests = 0;
  const host: SavedChannelCheckHost = {
    channels: () => channels,
    idle: options.idle ?? (() => true),
    read: async () => ({ nowMs: now, checks: [...store.values()], slowChannels: [] }),
    record: async (observations) => {
      recorded.push([...observations]);
      for (const o of observations) {
        const ok = o.verdict === 'Reachable' || o.verdict === 'PlayedHere';
        const previous = store.get(o.channelId);
        const first = ok ? null : (previous?.firstFailMs ?? now);
        store.set(o.channelId, {
          channelId: o.channelId,
          checkedMs: now,
          okMs: ok ? now : (previous?.okMs ?? null),
          firstFailMs: first,
          lastFailMs: ok ? null : now,
          verdict: o.verdict,
          notResponding: !ok && first !== null && now - first >= 20 * HOUR,
        });
      }
      return observations.length;
    },
    probe: async (c) => {
      probed.push(c.id);
      return outcomes[c.id] ?? 'Reachable';
    },
    changed: (checks) => {
      published = checks;
    },
    wait: (_ms, signal) => {
      rests++;
      // Each rest advances a simulated day so batches come due again.
      now += 24 * HOUR;
      // A real timer turn, so the test's own checks get to run between rests.
      return new Promise((resolve, reject) =>
        setTimeout(() => (signal.aborted ? reject(signal.reason) : resolve()), 0),
      );
    },
  };
  return {
    host,
    probed,
    recorded,
    store,
    published: () => published,
    rests: () => rests,
  };
}
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 0));
};

describe('saved channel check', () => {
  it('orders due channels: failing first, then never checked, then oldest', () => {
    const now = 100 * HOUR;
    const checks = new Map([
      ['fresh', check('fresh', now - HOUR)],
      ['old', check('old', now - 50 * HOUR)],
      ['older', check('older', now - 60 * HOUR)],
      ['failing', check('failing', now - 30 * HOUR, true)],
    ]);
    const due = dueChannels(
      ['fresh', 'old', 'new', 'older', 'failing'].map((id) => channel(id)),
      checks,
      now,
      20 * HOUR,
    );
    expect(due.map((c) => c.id)).toEqual(['failing', 'new', 'older', 'old']);
  });

  it('marks a channel only after failing on two days, and checks shared streams once', async () => {
    const shared = 'https://example.test/same.m3u8';
    const h = harness(
      [channel('good'), channel('dead'), channel('twin-a', shared), channel('twin-b', shared)],
      { dead: 'TimedOut' },
    );
    const check = createSavedChannelCheck(h.host, { startDelayMs: 0, restMs: 0, sleepMs: 0 });
    check.start();
    await settle(() => h.published().get('dead')?.notResponding === true);
    await check.dispose();
    expect(h.published().get('dead')?.notResponding).toBe(true);
    expect(h.published().get('good')?.notResponding).toBe(false);
    // The twins share one probe per round, and both get its result.
    const firstRound = h.recorded[0].map((o) => o.channelId).sort();
    expect(firstRound).toEqual(['dead', 'good', 'twin-a', 'twin-b']);
    expect(h.probed.slice(0, 3).filter((id) => id.startsWith('twin'))).toHaveLength(1);
  });

  it('never counts a failure when the connection itself is down', async () => {
    // Everything fails, including the channel that answered most recently.
    const h = harness(
      [channel('a'), channel('b'), channel('canary')],
      { a: 'TemporaryUnavailable', b: 'TimedOut', canary: 'TimedOut' },
      { seed: [check('canary', 99 * HOUR)] },
    );
    const work = createSavedChannelCheck(h.host, {
      startDelayMs: 0,
      restMs: 0,
      sleepMs: 0,
      batch: 2,
    });
    work.start();
    await settle(() => h.rests() > 6);
    await work.dispose();
    expect(h.recorded.flat().filter((o) => o.verdict !== 'Reachable')).toEqual([]);
    expect(h.probed).toContain('canary');
  });

  it('records a failure when another channel still answers', async () => {
    const h = harness(
      [channel('a'), channel('canary')],
      { a: 'AccessDenied' },
      { seed: [check('canary', 99 * HOUR)] },
    );
    const work = createSavedChannelCheck(h.host, {
      startDelayMs: 0,
      restMs: 0,
      sleepMs: 0,
      batch: 1,
    });
    work.start();
    await settle(() => h.recorded.length > 0);
    await work.dispose();
    expect(h.recorded[0]).toEqual([
      { channelId: 'a', verdict: 'AccessDenied' },
      { channelId: 'canary', verdict: 'Reachable' },
    ]);
  });

  it('does not check while something plays, and skips unknown outcomes', async () => {
    let idle = false;
    const h = harness(
      [channel('a'), channel('offline')],
      { offline: 'NotChecked' },
      { idle: () => idle },
    );
    const work = createSavedChannelCheck(h.host, { startDelayMs: 0, restMs: 0, sleepMs: 0 });
    work.start();
    await settle(() => h.rests() > 3);
    expect(h.probed).toEqual([]);
    idle = true;
    work.poke();
    await settle(() => h.recorded.length > 0);
    await work.dispose();
    expect(h.recorded[0]).toEqual([{ channelId: 'a', verdict: 'Reachable' }]);
  });

  it('records a channel that played, clearing its failures', async () => {
    const h = harness(
      [channel('a')],
      {},
      { idle: () => false, seed: [check('a', 99 * HOUR, true)] },
    );
    const work = createSavedChannelCheck(h.host, { startDelayMs: 0, restMs: 0, sleepMs: 0 });
    work.start();
    await settle(() => h.rests() > 0);
    work.played('a');
    await settle(() => h.recorded.length > 0);
    await work.dispose();
    expect(h.recorded[0]).toEqual([{ channelId: 'a', verdict: 'PlayedHere' }]);
    expect(h.store.get('a')?.firstFailMs).toBeNull();
  });
});

describe('channel check transport', () => {
  it('admits only well-formed native replies', () => {
    const good = {
      schemaVersion: 1,
      nowMs: 5,
      checks: [
        {
          channelId: 'a',
          checkedMs: 5,
          okMs: null,
          firstFailMs: 1,
          lastFailMs: 5,
          verdict: 'TimedOut',
          notResponding: false,
        },
      ],
    };
    expect(validateChannelChecks(good).checks[0].channelId).toBe('a');
    for (const bad of [
      { ...good, schemaVersion: 2 },
      { ...good, checks: [{ ...good.checks[0], verdict: 'Canceled' }] },
      { ...good, checks: [{ ...good.checks[0], channelId: 'a\u0007' }] },
      { ...good, checks: [{ ...good.checks[0], checkedMs: -1 }] },
      { ...good, nowMs: 'now' },
    ])
      expect(() => validateChannelChecks(bad)).toThrow();
  });

  it('sends batches with a request id and refuses invalid ones before sending', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const store = createChannelCheckStore({
      idFactory: () => 'request-1',
      invoke: async (command, args) => {
        calls.push([command, args]);
        return { schemaVersion: 1, recorded: 1 };
      },
    });
    await expect(
      store.record([{ channelId: 'a', verdict: 'Reachable' }], new AbortController().signal),
    ).resolves.toBe(1);
    expect(calls[0]).toEqual([
      'record_channel_checks',
      {
        request: { schemaVersion: 1, observations: [{ channelId: 'a', verdict: 'Reachable' }] },
        requestId: 'request-1',
      },
    ]);
    expect(() => store.record([], new AbortController().signal)).toThrow();
  });
});

// October 21, 2026: on the Sansui TV, checks kept two of four cores busy and
// carried on after a channel started. They now run one at a time with a rest
// between them, and stop the moment GenX is in use.
describe('saved channel check stays out of the way of viewing', () => {
  function controlled(channels: SavedChannel[]) {
    let idle = true;
    let running = 0;
    let most = 0;
    const waits: number[] = [];
    const recorded: ChannelObservation[][] = [];
    const inFlight: Array<{
      id: string;
      signal: AbortSignal;
      finish(outcome: CheckOutcome): void;
    }> = [];
    const host: SavedChannelCheckHost = {
      channels: () => channels,
      idle: () => idle,
      read: async () => ({ nowMs: 100 * HOUR, checks: [], slowChannels: [] }),
      record: async (observations) => {
        recorded.push([...observations]);
        return observations.length;
      },
      probe: (c, signal) =>
        new Promise<CheckOutcome>((resolve) => {
          running++;
          most = Math.max(most, running);
          const done = (outcome: CheckOutcome) => {
            running--;
            resolve(outcome);
          };
          signal.addEventListener('abort', () => done('Canceled'), { once: true });
          inFlight.push({ id: c.id, signal, finish: done });
        }),
      changed: () => undefined,
      wait: (ms, signal) => {
        waits.push(ms);
        return new Promise((resolve, reject) =>
          setTimeout(() => (signal.aborted ? reject(signal.reason) : resolve()), 0),
        );
      },
    };
    return {
      host,
      inFlight,
      recorded,
      waits,
      get most() {
        return most;
      },
      setIdle(value: boolean) {
        idle = value;
      },
    };
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('checks one channel at a time, resting between checks', async () => {
    const h = controlled([channel('a'), channel('b'), channel('c')]);
    const check = createSavedChannelCheck(h.host, { startDelayMs: 0, gapMs: 3_000 });
    check.start();
    for (let i = 0; i < 3; i++) {
      await settle();
      h.inFlight.at(-1)!.finish('Reachable');
    }
    await settle();
    // The test store keeps no results, so the next round starts again at a.
    expect(h.inFlight.slice(0, 3).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(h.most).toBe(1);
    expect(h.waits.filter((ms) => ms === 3_000)).toHaveLength(2);
    expect(h.recorded[0]!.map((o) => o.channelId)).toEqual(['a', 'b', 'c']);
    await check.dispose();
  });

  it('a channel starting stops the check in flight; nothing counts as a failure', async () => {
    const h = controlled([channel('a'), channel('b'), channel('c')]);
    const check = createSavedChannelCheck(h.host, { startDelayMs: 0, gapMs: 0 });
    check.start();
    await settle();
    h.inFlight[0]!.finish('TimedOut');
    await settle();
    expect(h.inFlight).toHaveLength(2);
    // A channel starts: GenX is in use.
    h.setIdle(false);
    check.poke();
    await settle();
    expect(h.inFlight[1]!.signal.aborted).toBe(true);
    // Stopped part way: the earlier failure is not recorded without the
    // connection check, and the canceled one says nothing.
    expect(h.recorded.flat().filter((o) => o.verdict !== 'Reachable')).toEqual([]);
    expect(h.inFlight).toHaveLength(2);
    await check.dispose();
  });
});
