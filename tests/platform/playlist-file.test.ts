import { afterEach, expect, it, vi } from 'vitest';
import { savePlaylistExport, type PlaylistFileTransport } from '../../src/platform/playlist-file';
import { serializePlaylistExport } from '../../src/catalog/playlist-export';
const result = () =>
  serializePlaylistExport({
    sources: [{ id: 'source', name: 'Fixture', kind: 'file', location: 'fixture.m3u' }],
    channels: [
      {
        id: 'channel',
        sourceId: 'source',
        name: 'Fixture',
        category: 'News',
        urls: ['https://example.invalid/live'],
      },
    ],
  });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const native = (): PlaylistFileTransport => ({
  isNative: () => true,
  pickSave: vi.fn(async () => 'content://fixture/document/selected'),
  writeText: vi.fn(async () => {}),
  download: vi.fn(async () => {}),
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.each(['content://fixture/document/selected', 'C:\\Users\\Fixture\\chosen.m3u'])(
  'writes only the actual selected destination %s and reports no path',
  async (destination) => {
    const transport = native();
    transport.pickSave = vi.fn(async () => destination);
    const output = result();
    const receipt = await savePlaylistExport(output, new AbortController().signal, transport);
    expect(transport.writeText).toHaveBeenCalledWith(destination, output.text);
    expect(receipt).toEqual({ status: 'saved', filename: 'genx-channels.m3u' });
    expect(JSON.stringify(receipt)).not.toContain(destination);
    expect(transport.download).not.toHaveBeenCalled();
  },
);
it('actual canceled picker admits no write', async () => {
  const transport = native();
  transport.pickSave = vi.fn(async () => null);
  expect((await savePlaylistExport(result(), new AbortController().signal, transport)).status).toBe(
    'canceled',
  );
  expect(transport.writeText).not.toHaveBeenCalled();
});
it('aborting while the picker is held still waits its actual settlement and never writes', async () => {
  const transport = native(),
    picker = deferred<string | null>(),
    controller = new AbortController();
  transport.pickSave = () => picker.promise;
  let settled = false;
  const pending = savePlaylistExport(result(), controller.signal, transport).then((receipt) => {
    settled = true;
    return receipt;
  });
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  picker.resolve('content://fixture/document/selected');
  expect((await pending).status).toBe('canceled');
  expect(transport.writeText).not.toHaveBeenCalled();
});
it('an admitted write remains owned after abort and reports its actual late success', async () => {
  const transport = native(),
    writing = deferred<void>(),
    controller = new AbortController();
  transport.writeText = vi.fn(() => writing.promise);
  let settled = false;
  const pending = savePlaylistExport(result(), controller.signal, transport).then((receipt) => {
    settled = true;
    return receipt;
  });
  await Promise.resolve();
  expect(transport.writeText).toHaveBeenCalledTimes(1);
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  writing.resolve();
  expect((await pending).status).toBe('saved');
});
it.each(['picker', 'write'] as const)(
  'redacts actual %s rejection and never claims saved',
  async (kind) => {
    const transport = native();
    if (kind === 'picker')
      transport.pickSave = async () => {
        throw new Error('private URI');
      };
    else
      transport.writeText = async () => {
        throw new Error('private URI');
      };
    await expect(
      savePlaylistExport(result(), new AbortController().signal, transport),
    ).rejects.toThrow(`playlist-save-${kind}-failed`);
  },
);
it('captures immutable text before asynchronous picker completion', async () => {
  const transport = native(),
    picker = deferred<string | null>(),
    output = result();
  transport.pickSave = () => picker.promise;
  const original = output.text;
  const pending = savePlaylistExport(output, new AbortController().signal, transport);
  output.text = 'late mutation';
  picker.resolve('content://fixture/document/selected');
  await pending;
  expect(transport.writeText).toHaveBeenCalledWith('content://fixture/document/selected', original);
});
it('already canceled action acquires neither picker nor download', async () => {
  const transport = native(),
    controller = new AbortController();
  controller.abort();
  expect((await savePlaylistExport(result(), controller.signal, transport)).status).toBe(
    'canceled',
  );
  expect(transport.pickSave).not.toHaveBeenCalled();
  expect(transport.download).not.toHaveBeenCalled();
});
it('browser receipt proves activation only and joins objectURL cleanup', async () => {
  const anchor = { href: '', download: '', hidden: false, click: vi.fn(), remove: vi.fn() };
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', { createElement: () => anchor, body: { append: vi.fn() } });
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const receipt = await savePlaylistExport(result(), new AbortController().signal);
  expect(receipt.status).toBe('download-started');
  expect(anchor.download).toBe('genx-channels.m3u');
  expect(anchor.click).toHaveBeenCalledTimes(1);
  expect(anchor.remove).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledTimes(1);
  expect(revoke).toHaveBeenCalledWith('blob:fixture');
});
it('failed browser activation releases URL and element without claiming download', async () => {
  const anchor = {
    href: '',
    download: '',
    hidden: false,
    click: () => {
      throw new Error('secret');
    },
    remove: vi.fn(),
  };
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', { createElement: () => anchor, body: { append: vi.fn() } });
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await expect(savePlaylistExport(result(), new AbortController().signal)).rejects.toThrow(
    'playlist-save-download-failed',
  );
  expect(anchor.remove).toHaveBeenCalledTimes(1);
  expect(revoke).toHaveBeenCalledWith('blob:fixture');
});
