import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { CastDevice } from '../../src/casting/controller';
import { createNativeCastAdapter } from '../../src/casting/native-adapter';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
const device = { id: 'device', name: 'TV', protocol: 'dlna' as const };
const authorize = async () => 'issued-handle';
const confirmedAdapter = (allowHttp = () => false) =>
  createNativeCastAdapter(allowHttp, undefined, () => false, authorize);
const selection = {
  id: 'channel',
  name: 'News',
  url: 'https://example.org/media.mp4',
  mediaKind: 'media' as const,
  mediaMime: 'video/mp4',
};
beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});
describe('native casting bridge contract (mock commands, not hardware acceptance)', () => {
  it('requires explicit authorization by default and never passes raw roster IDs', async () => {
    const engine = createNativeCastAdapter().create(device, 'session', vi.fn());
    await expect(engine.start(selection, new AbortController().signal)).rejects.toThrow(
      'Confirm your TV',
    );
    expect(invoke).not.toHaveBeenCalled();
    await engine.dispose();
  });
  it('denied confirmation and malformed or raw roster authorization never issue LOAD', async () => {
    const callbacks = [
      async () => {
        throw new Error('secret native details');
      },
      ...['', 'x'.repeat(129), ' device ', 'bad\nhandle', device.id].map(
        (handle) => async () => handle,
      ),
    ];
    for (const callback of callbacks) {
      const engine = createNativeCastAdapter(
        () => false,
        undefined,
        () => false,
        callback,
      ).create(device, 'session', vi.fn());
      await expect(engine.start(selection, new AbortController().signal)).rejects.toThrow();
      await engine.dispose();
    }
    expect(invoke).not.toHaveBeenCalled();
  });
  it('cancellation during authorization waits settlement and prevents native startup', async () => {
    let resolve!: (value: string) => void;
    const callback = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const engine = createNativeCastAdapter(
      () => false,
      undefined,
      () => false,
      callback,
    ).create(device, 'session', vi.fn());
    const controller = new AbortController();
    const pending = engine.start(selection, controller.signal);
    controller.abort();
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolve('issued');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
    await engine.dispose();
  });
  it('authorizes after inspection, freezes receiver details, and refuses a disposed pending owner', async () => {
    const order: string[] = [];
    let resolve!: (value: string) => void;
    const selectedDevice = { ...device };
    const inspector = vi.fn(async () => {
      order.push('inspect');
      return { kind: 'media' as const, mime: 'video/mp4' };
    });
    const callback = vi.fn(async (receiver: CastDevice, signal: AbortSignal) => {
      order.push('authorize');
      expect(receiver.id).toBe(device.id);
      expect(Object.isFrozen(receiver)).toBe(true);
      expect(signal.aborted).toBe(false);
      return new Promise<string>((r) => {
        resolve = r;
      });
    });
    const engine = createNativeCastAdapter(
      () => false,
      inspector,
      () => false,
      callback,
    ).create(selectedDevice, 'session', vi.fn());
    selectedDevice.id = 'mutated';
    const pending = engine.start(
      { id: 'channel', name: 'News', url: selection.url },
      new AbortController().signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['inspect', 'authorize']);
    await engine.dispose();
    resolve('issued');
    await expect(pending).rejects.toThrow('released');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('passes separate receiver HTTP consent only for an explicitly enabled Chromecast relay', async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue({
      sessionId: 'session',
      selectionId: 'channel',
      state: 'playing',
      remoteSessionId: 'remote',
    });
    const cast = createNativeCastAdapter(
      () => false,
      undefined,
      () => true,
      authorize,
    ).create({ ...device, protocol: 'chromecast' }, 'session', vi.fn());
    await cast.start(selection, new AbortController().signal);
    expect(invoke).toHaveBeenCalledWith(
      'cast_start',
      expect.objectContaining({ allowHttp: false, allowHttpReceiver: true }),
    );
    await cast.dispose();
    vi.mocked(invoke).mockClear();
    const dlna = createNativeCastAdapter(
      () => false,
      undefined,
      () => true,
      authorize,
    ).create(device, 'session', vi.fn());
    await dlna.start(selection, new AbortController().signal);
    expect(vi.mocked(invoke).mock.calls[0]![1]).not.toHaveProperty('allowHttpReceiver');
    await dlna.dispose();
  });
  it('declines browser preview instead of simulating casting', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(createNativeCastAdapter().discover(new AbortController().signal)).rejects.toThrow(
      'native application',
    );
    expect(invoke).not.toHaveBeenCalled();
  });
  it('passes explicit selected device/session and HTTP policy, and requires verified status', async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === 'cast_start'
        ? {
            sessionId: 'session',
            selectionId: 'channel',
            state: 'playing',
            remoteSessionId: 'avtransport:0',
          }
        : true,
    );
    const engine = confirmedAdapter(() => true).create(device, 'session', emit);
    await engine.start(selection, new AbortController().signal);
    expect(invoke).toHaveBeenCalledWith('cast_start', {
      deviceId: 'issued-handle',
      sessionId: 'session',
      selection: { ...selection, contentType: 'video/mp4' },
      allowHttp: true,
    });
    expect(emit).toHaveBeenCalledWith({
      sessionId: 'session',
      selectionId: 'channel',
      state: 'playing',
      remoteSessionId: 'avtransport:0',
    });
    expect(await engine.stop(new AbortController().signal)).toEqual({ confirmed: true });
    await engine.dispose();
    await vi.advanceTimersByTimeAsync(4000);
    expect(vi.mocked(invoke).mock.calls.map((call) => call[0])).toEqual([
      'cast_start',
      'cast_stop',
    ]);
  });
  it('ignores start reply after cancellation and still stops the native session', async () => {
    const emit = vi.fn();
    let resolve!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((command) =>
      command === 'cast_start'
        ? new Promise((r) => {
            resolve = r;
          })
        : Promise.resolve(true),
    );
    const engine = confirmedAdapter().create(device, 'session', emit);
    const abort = new AbortController();
    const pending = engine.start(selection, abort.signal);
    await Promise.resolve();
    abort.abort();
    resolve({
      sessionId: 'session',
      selectionId: 'channel',
      state: 'playing',
      remoteSessionId: 'remote',
    });
    await pending;
    expect(emit).not.toHaveBeenCalled();
    await engine.stop(new AbortController().signal);
    await engine.dispose();
    expect(invoke).toHaveBeenCalledWith('cast_stop', { sessionId: 'session' });
  });
  it('unconfirmed or failed remote stop is not converted into success', async () => {
    const engine = confirmedAdapter().create(device, 'session', vi.fn());
    vi.mocked(invoke).mockResolvedValue(false);
    expect(await engine.stop(new AbortController().signal)).toEqual({ confirmed: false });
    vi.mocked(invoke).mockRejectedValue('network-failure');
    await expect(engine.stop(new AbortController().signal)).rejects.toThrow('not confirmed');
    vi.mocked(invoke).mockRejectedValue('cast-session-not-owned');
    expect(await engine.stop(new AbortController().signal)).toEqual({ confirmed: true });
    await engine.dispose();
  });
  it('uses inspected media bytes/MIME instead of misleading URL extensions', async () => {
    vi.useFakeTimers();
    const inspector = vi.fn(async () => ({ kind: 'media' as const, mime: 'video/mp2t' }));
    vi.mocked(invoke).mockResolvedValue({
      sessionId: 'session',
      selectionId: 'channel',
      state: 'playing',
      remoteSessionId: 'remote',
    });
    const engine = createNativeCastAdapter(
      () => false,
      inspector,
      () => false,
      authorize,
    ).create(device, 'session', vi.fn());
    const input = { id: 'channel', name: 'News', url: 'https://example.org/misleading.json' };
    const signal = new AbortController().signal;
    await engine.start(input, signal);
    expect(inspector).toHaveBeenCalledWith(input.url, signal);
    expect(invoke).toHaveBeenCalledWith(
      'cast_start',
      expect.objectContaining({ selection: { ...input, contentType: 'video/mp2t' } }),
    );
    await engine.dispose();
  });
  it('uses an inspected HLS hint despite an MP4 filename and rejects catalog content', async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue({
      sessionId: 'session',
      selectionId: 'channel',
      state: 'playing',
      remoteSessionId: 'remote',
    });
    const engine = confirmedAdapter().create(device, 'session', vi.fn());
    await engine.start(
      { ...selection, mediaKind: 'hls', mediaMime: undefined },
      new AbortController().signal,
    );
    expect(invoke).toHaveBeenCalledWith(
      'cast_start',
      expect.objectContaining({
        selection: expect.objectContaining({ contentType: 'application/x-mpegURL' }),
      }),
    );
    await engine.dispose();
    vi.mocked(invoke).mockClear();
    const catalog = createNativeCastAdapter(
      () => false,
      async () => ({ kind: 'catalog' }),
    ).create(device, 'catalog', vi.fn());
    await expect(
      catalog.start({ id: 'c', name: 'Catalog', url: selection.url }, new AbortController().signal),
    ).rejects.toThrow('supported media');
    expect(invoke).not.toHaveBeenCalled();
    await catalog.dispose();
  });
});
