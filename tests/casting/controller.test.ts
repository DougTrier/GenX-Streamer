import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CastingController,
  type CastAdapter,
  type CastEngine,
  type CastEvent,
} from '../../src/casting';
const device = { id: 'device', name: 'Living room', protocol: 'chromecast' as const };
const selection = { id: 'channel', name: 'News', url: 'https://example.org/live' };
function fixture() {
  const sessions: { id: string; emit: (event: CastEvent) => void; engine: CastEngine }[] = [];
  let ids = 0;
  const adapter: CastAdapter = {
    discover: vi.fn(async () => [device]),
    create: (_device, id, emit) => {
      const engine: CastEngine = {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => ({ confirmed: true })),
        dispose: vi.fn(async () => undefined),
      };
      sessions.push({ id, emit, engine });
      return engine;
    },
  };
  return {
    adapter,
    sessions,
    controller: new CastingController(adapter, () => `session-${++ids}`),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('casting ownership and authoritative receiver state', () => {
  it('does not discover or cast until explicitly requested', async () => {
    const f = fixture();
    expect(f.adapter.discover).not.toHaveBeenCalled();
    expect(f.sessions).toHaveLength(0);
    expect(await f.controller.listDevices()).toEqual([device]);
    expect(f.adapter.discover).toHaveBeenCalledOnce();
    await f.controller.dispose();
  });
  it('LOAD completion does not imply playing; matched receiver status does', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    expect(f.controller.snapshot.state).toBe('connecting');
    const session = f.sessions[0]!;
    session.emit({
      sessionId: session.id,
      selectionId: 'wrong',
      state: 'playing',
      remoteSessionId: 'remote',
    });
    session.emit({ sessionId: session.id, selectionId: selection.id, state: 'playing' });
    expect(f.controller.snapshot.state).toBe('connecting');
    session.emit({
      sessionId: session.id,
      selectionId: selection.id,
      state: 'playing',
      remoteSessionId: 'remote',
    });
    expect(f.controller.snapshot.state).toBe('playing');
    await f.controller.dispose();
  });
  it('ignores stale callbacks after replacing a receiver session', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    await f.controller.start(device, { ...selection, id: 'second' });
    expect(f.sessions[0]!.engine.stop).toHaveBeenCalledOnce();
    expect(f.sessions[0]!.engine.dispose).toHaveBeenCalledOnce();
    f.sessions[0]!.emit({
      sessionId: f.sessions[0]!.id,
      selectionId: selection.id,
      state: 'playing',
      remoteSessionId: 'old',
    });
    expect(f.controller.snapshot.selection?.id).toBe('second');
    expect(f.controller.snapshot.state).toBe('connecting');
    await f.controller.dispose();
  });
  it('retains ownership and blocks a second engine when receiver stop is unconfirmed', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    vi.mocked(f.sessions[0]!.engine.stop).mockResolvedValue({ confirmed: false });
    await f.controller.start(device, selection);
    expect(f.sessions).toHaveLength(1);
    expect(f.controller.snapshot.state).toBe('failed');
    expect(f.sessions[0]!.engine.dispose).not.toHaveBeenCalled();
    await expect(f.controller.dispose()).rejects.toThrow('ownership was retained');
    vi.mocked(f.sessions[0]!.engine.stop).mockResolvedValue({ confirmed: true });
    await f.controller.dispose();
    expect(f.controller.snapshot.state).toBe('disposed');
  });
  it('stop confirmation precedes sender disposal and clears selection', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    await f.controller.stop();
    expect(f.sessions[0]!.engine.stop).toHaveBeenCalledOnce();
    expect(f.sessions[0]!.engine.dispose).toHaveBeenCalledOnce();
    expect(f.controller.snapshot).toMatchObject({
      state: 'idle',
      sessionId: null,
      selection: null,
      device: null,
    });
    await f.controller.dispose();
  });
  it('times out stalled LOAD and rejects its late status without leaking URL diagnostics', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.adapter.create = (_device, id, emit) => {
      const engine: CastEngine = {
        start: () => new Promise(() => undefined),
        stop: async () => ({ confirmed: true }),
        dispose: async () => undefined,
      };
      f.sessions.push({ id, emit, engine });
      return engine;
    };
    const pending = f.controller.start(device, {
      ...selection,
      url: 'https://example.org/private?secret=token',
    });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(f.controller.snapshot.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(f.controller.snapshot.state).toBe('failed');
    expect(f.controller.snapshot.error).not.toContain('secret');
    f.sessions[0]!.emit({
      sessionId: f.sessions[0]!.id,
      selectionId: selection.id,
      state: 'playing',
      remoteSessionId: 'late',
    });
    expect(f.controller.snapshot.state).toBe('failed');
    await f.controller.dispose();
  });
  it('rejects untrusted duplicate discovered device identities', async () => {
    const f = fixture();
    vi.mocked(f.adapter.discover).mockResolvedValue([device, device]);
    await expect(f.controller.listDevices()).rejects.toThrow('invalid devices');
    await f.controller.dispose();
  });
  it('idempotent concurrent disposal prevents new starts', async () => {
    const f = fixture();
    await f.controller.start(device, selection);
    const disposal = f.controller.dispose();
    await expect(f.controller.start(device, selection)).rejects.toThrow('closed');
    await Promise.all([disposal, f.controller.dispose()]);
    expect(f.sessions[0]!.engine.dispose).toHaveBeenCalledOnce();
  });
  it('subscriber copies cannot mutate owned state', async () => {
    const f = fixture();
    const unsubscribe = f.controller.subscribe((snapshot) => {
      if (snapshot.device) snapshot.device.name = 'changed';
    });
    await f.controller.start(device, selection);
    expect(f.controller.snapshot.device?.name).toBe('Living room');
    unsubscribe();
    await f.controller.dispose();
  });
});
