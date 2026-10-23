import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharingService } from '../../src/sharing/service';
import type {
  HostObservation,
  RemoteCommand,
  SharingApi,
  SharingHost,
} from '../../src/sharing/contracts';
import { scopedChannels, validateSettings } from '../../src/sharing/validation';

const settings = {
  bindAddress: '127.0.0.1',
  port: 9443,
  certPath: 'C:\\cert.pem',
  keyPath: 'C:\\key.pem',
  allowHttp: false,
};
const command: RemoteCommand = {
  commandId: 'opaque',
  sequence: 1,
  revision: 1,
  action: 'select',
  channelId: 'b',
};
const services: SharingService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
});
function setup() {
  let observation: HostObservation = {
    generation: 1,
    muted: false,
    volume: 1,
    playback: {
      state: 'connecting',
      error: null,
      selection: { id: 'a', name: 'A', url: 'https://fixture.invalid/a', mediaKind: 'hls' },
    },
  };
  const listeners = new Set<(value: HostObservation) => void>();
  const emit = (update: Partial<HostObservation>) => {
    observation = { ...observation, ...update };
    for (const listener of listeners) listener(observation);
  };
  const host: SharingHost = {
    snapshot: () => observation,
    channels: () => [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    apply: vi.fn(async () => ({ generation: observation.generation })),
  };
  const queue: RemoteCommand[] = [];
  const api: SharingApi = {
    start: vi.fn(async () => ({ address: 'https://fixture.invalid', pairingSecret: 'invite' })),
    stop: vi.fn(async () => {}),
    selectionChanged: vi.fn(async () => {}),
    publish: vi.fn(async () => ({ revision: 1, mediaId: 'media' })),
    invite: vi.fn(async () => 'next-invite'),
    viewers: vi.fn(async () => ['viewer']),
    revoke: vi.fn(async () => {}),
    nextCommand: vi.fn(async () => queue.shift() ?? null),
    active: vi.fn(async () => true),
    allows: vi.fn(async () => true),
    acknowledge: vi.fn(async () => true),
  };
  const service = new SharingService(host, api);
  services.push(service);
  return {
    service,
    host,
    api,
    queue,
    emit,
    get observation() {
      return observation;
    },
  };
}
describe('sharing host ownership', () => {
  it('does not require AbortSignal.any in older native WebViews', async () => {
    const unsupported = vi.spyOn(AbortSignal, 'any').mockImplementation(() => {
      throw new Error('AbortSignal.any is unavailable');
    });
    const fixture = setup();
    fixture.queue.push({ ...command, action: 'mute', muted: true });
    vi.mocked(fixture.host.apply).mockImplementation(async () => {
      fixture.emit({ muted: true });
      return { generation: 1 };
    });
    await fixture.service.start(settings);
    await vi.waitFor(() => expect(fixture.api.acknowledge).toHaveBeenCalledWith('opaque', true));
    expect(unsupported).not.toHaveBeenCalled();
  });
  it('publishes only observed HLS playing and coalesces repeated progress', async () => {
    const fixture = setup();
    await fixture.service.start(settings);
    expect(fixture.api.publish).not.toHaveBeenCalled();
    fixture.emit({ playback: { ...fixture.observation.playback, state: 'playing' } });
    for (let index = 0; index < 1000; index++) fixture.emit({});
    await vi.waitFor(() => expect(fixture.api.publish).toHaveBeenCalledTimes(1));
    await fixture.service.beforeSelection(2);
    expect(fixture.api.selectionChanged).toHaveBeenLastCalledWith(2, undefined);
    fixture.emit({
      generation: 2,
      playback: { ...fixture.observation.playback, state: 'connecting' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fixture.api.publish).toHaveBeenCalledTimes(1);
  });
  it('does not publish direct media or connecting imports', async () => {
    const fixture = setup();
    await fixture.service.start(settings);
    fixture.emit({
      playback: {
        ...fixture.observation.playback,
        state: 'playing',
        selection: { ...fixture.observation.playback.selection!, mediaKind: 'media' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fixture.api.publish).not.toHaveBeenCalled();
  });
  it('retains the viewer publication through local pause and resume without republishing', async () => {
    const fixture = setup();
    await fixture.service.start(settings);
    fixture.emit({ playback: { ...fixture.observation.playback, state: 'playing' } });
    await vi.waitFor(() => expect(fixture.service.snapshot.publishedGeneration).toBe(1));
    vi.mocked(fixture.api.selectionChanged).mockImplementation(async (generation) => ({
      generation,
      publicationRevision: 1,
    }));
    await fixture.service.beforeSelection(2, undefined, true);
    fixture.emit({
      generation: 2,
      playback: { ...fixture.observation.playback, state: 'paused' },
    });
    expect(fixture.api.selectionChanged).toHaveBeenLastCalledWith(2, undefined, true);
    expect(fixture.service.snapshot.publishedGeneration).toBe(2);
    await fixture.service.beforeSelection(3, undefined, true);
    fixture.emit({
      generation: 3,
      playback: { ...fixture.observation.playback, state: 'playing' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fixture.service.snapshot.publishedGeneration).toBe(3);
    expect(fixture.api.publish).toHaveBeenCalledTimes(1);
    expect(fixture.api.stop).not.toHaveBeenCalled();
  });
  it('uses the native receipt when a durable publication response arrives after local pause', async () => {
    const fixture = setup();
    let complete!: (result: { revision: number; mediaId: string }) => void;
    vi.mocked(fixture.api.publish).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await fixture.service.start(settings);
    fixture.emit({ playback: { ...fixture.observation.playback, state: 'playing' } });
    await vi.waitFor(() => expect(fixture.api.publish).toHaveBeenCalledTimes(1));
    expect(fixture.service.snapshot.publishedGeneration).toBeNull();
    vi.mocked(fixture.api.selectionChanged).mockResolvedValue({
      generation: 2,
      publicationRevision: 1,
    });
    await fixture.service.beforeSelection(2, undefined, true);
    fixture.emit({
      generation: 2,
      playback: { ...fixture.observation.playback, state: 'paused' },
    });
    complete({ revision: 1, mediaId: 'media' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fixture.service.snapshot.publishedGeneration).toBe(2);
    expect(fixture.api.publish).toHaveBeenCalledTimes(1);
  });
  it('does not invent a publication when pause precedes any shared media', async () => {
    const fixture = setup();
    await fixture.service.start(settings);
    vi.mocked(fixture.api.selectionChanged).mockResolvedValue({
      generation: 2,
      publicationRevision: 0,
    });
    await fixture.service.beforeSelection(2, undefined, true);
    fixture.emit({
      generation: 2,
      playback: { ...fixture.observation.playback, state: 'paused' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fixture.service.snapshot.publishedGeneration).toBeNull();
    expect(fixture.api.publish).not.toHaveBeenCalled();
    fixture.emit({ playback: { ...fixture.observation.playback, state: 'playing' } });
    await vi.waitFor(() => expect(fixture.service.snapshot.publishedGeneration).toBe(2));
  });
  it('rejects malformed transition receipts instead of claiming retained remote playback', async () => {
    const fixture = setup();
    await fixture.service.start(settings);
    vi.mocked(fixture.api.selectionChanged).mockResolvedValue({
      generation: 9,
      publicationRevision: 1,
    });
    await expect(fixture.service.beforeSelection(2, undefined, true)).rejects.toThrow(
      'could not be confirmed',
    );
    expect(fixture.service.snapshot.publishedGeneration).toBeNull();
  });
  it('discards a delayed older transition receipt after a newer retained publication', async () => {
    const fixture = setup();
    await fixture.service.start(settings);
    fixture.emit({ playback: { ...fixture.observation.playback, state: 'playing' } });
    await vi.waitFor(() => expect(fixture.service.snapshot.publishedGeneration).toBe(1));
    let complete!: (receipt: { generation: number; publicationRevision: number }) => void;
    vi.mocked(fixture.api.selectionChanged).mockImplementation(async (generation) => {
      if (generation === 2)
        return new Promise((resolve) => {
          complete = resolve;
        });
      return { generation, publicationRevision: 1 };
    });
    const older = fixture.service.beforeSelection(2);
    await fixture.service.beforeSelection(3, undefined, true);
    complete({ generation: 2, publicationRevision: 0 });
    await older;
    expect(fixture.service.snapshot.publishedGeneration).toBe(3);
    expect(fixture.api.publish).toHaveBeenCalledTimes(1);
  });
  it('requires matching observed playback before affirmative phone acknowledgment', async () => {
    const fixture = setup();
    let actionSignal: AbortSignal | undefined;
    vi.mocked(fixture.host.apply).mockImplementation(async (_action, context) => {
      actionSignal = context.signal;
      expect(await context.authorized()).toBe(true);
      await fixture.service.beforeSelection(2, context.commandId);
      fixture.emit({
        generation: 2,
        playback: {
          state: 'connecting',
          error: null,
          selection: { id: 'b', name: 'B', url: 'https://fixture.invalid/b', mediaKind: 'hls' },
        },
      });
      return { generation: 2 };
    });
    fixture.queue.push(command);
    await fixture.service.start(settings);
    await vi.waitFor(() => expect(fixture.host.apply).toHaveBeenCalled());
    expect(fixture.api.acknowledge).not.toHaveBeenCalled();
    expect(fixture.api.publish).not.toHaveBeenCalled();
    fixture.emit({ playback: { ...fixture.observation.playback, state: 'playing' } });
    await vi.waitFor(() => expect(fixture.api.acknowledge).toHaveBeenCalledWith('opaque', true));
    expect(actionSignal?.aborted).toBe(false);
    await vi.waitFor(() =>
      expect(fixture.api.publish).toHaveBeenCalledWith('https://fixture.invalid/b', 2),
    );
  });
  it('denies revoked scope before host mutation', async () => {
    const fixture = setup();
    vi.mocked(fixture.api.allows).mockResolvedValue(false);
    fixture.queue.push(command);
    await fixture.service.start(settings);
    await vi.waitFor(() => expect(fixture.api.acknowledge).toHaveBeenCalledWith('opaque', false));
    expect(fixture.host.apply).not.toHaveBeenCalled();
  });
  it('rejects superseded generation even if a different channel starts playing', async () => {
    const fixture = setup();
    fixture.queue.push(command);
    await fixture.service.start(settings);
    await vi.waitFor(() => expect(fixture.host.apply).toHaveBeenCalled());
    fixture.emit({
      generation: 3,
      playback: { ...fixture.observation.playback, state: 'playing' },
    });
    await vi.waitFor(() => expect(fixture.api.acknowledge).toHaveBeenCalledWith('opaque', false));
  });
  it('stop cancels an owned pending action and waits for confirmation work', async () => {
    const fixture = setup();
    let canceled = false;
    vi.mocked(fixture.host.apply).mockImplementation(
      (_action, context) =>
        new Promise((resolve) =>
          context.signal.addEventListener(
            'abort',
            () => {
              canceled = true;
              resolve({ generation: 1 });
            },
            { once: true },
          ),
        ),
    );
    fixture.queue.push(command);
    await fixture.service.start(settings);
    await vi.waitFor(() => expect(fixture.host.apply).toHaveBeenCalled());
    await fixture.service.stop();
    expect(canceled).toBe(true);
    expect(fixture.api.acknowledge).toHaveBeenCalledWith('opaque', false);
    expect(fixture.service.snapshot.state).toBe('stopped');
  });
  it('cleans a server when generation announcement fails during startup', async () => {
    const fixture = setup();
    vi.mocked(fixture.api.selectionChanged).mockRejectedValue(new Error('private detail'));
    await expect(fixture.service.start(settings)).rejects.toThrow('Sharing could not start');
    expect(fixture.api.stop).toHaveBeenCalledTimes(1);
    expect(fixture.service.snapshot.error).not.toContain('private detail');
  });
});
describe('sharing permission inputs', () => {
  it('rejects malformed interface/public bind and missing absolute certificate paths', () => {
    for (const bindAddress of ['10..0.1', '8.8.8.8', 'hostname', '192.168.1.999'])
      expect(() => validateSettings({ ...settings, bindAddress })).toThrow();
    expect(() => validateSettings({ ...settings, certPath: 'relative.pem' })).toThrow();
    expect(() => validateSettings(settings)).not.toThrow();
  });
  it('retains catalog order with distinct scope and refuses obsolete or repeated IDs', () => {
    const channels = [
      { id: 'a', name: '<script>' },
      { id: 'b', name: 'B' },
    ];
    expect(scopedChannels(channels, ['b', 'a'])).toEqual(channels);
    expect(() => scopedChannels(channels, ['a', 'a'])).toThrow();
    expect(() => scopedChannels(channels, ['removed'])).toThrow();
  });
});
