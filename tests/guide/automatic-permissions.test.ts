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

import { describe, expect, it, vi } from 'vitest';
import {
  createAutomaticGuidePermissions,
  previewPermittedAutomaticGuide,
} from '../../src/guide/automatic-permissions';
import type { GuideSource } from '../../src/guide/native';
const native = vi.hoisted(() => ({ sources: vi.fn(), saveSource: vi.fn(), preview: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../src/guide/native', () => ({
  nativeGuide: native,
  previewNativeGuide: native.preview,
  readSelectedGuide: vi.fn(),
  readChannelGuideCoverage: vi.fn(),
}));
import { createGuideHost } from '../../src/application/guide/guide-host';
const source = (patch: Partial<GuideSource> = {}): GuideSource => ({
  id: 'saved',
  name: 'My saved guide',
  location: 'http://fixture.invalid/guide.xml',
  kind: 'url',
  allowHttp: true,
  revision: 1,
  updatedMs: null,
  ...patch,
});
const held = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const setup = (sources: GuideSource[] = []) => ({
  sources: vi.fn(async () => sources),
  previewSource: vi.fn(async () => ({ ticket: 'owned', sourceRevision: 1 })),
  previewProposedSource: vi.fn(async () => ({
    ticket: 'proposed',
    sourceRevision: 0,
    proposed: true as const,
  })),
  createHttpsSource: vi.fn(async () =>
    source({ id: 'new', location: 'https://fixture.invalid/new.xml', allowHttp: false }),
  ),
});
describe('automatic guide permissions remain separate from playlist consent', () => {
  it.each(['http-404', 'guide-input-too-large', 'Guide XML is malformed.'])(
    'failed new suggestion %s never saves a descriptor first',
    async (failure) => {
      const gateway = {
        ...setup(),
        previewProposedSource: vi.fn(async () => {
          throw new Error(failure);
        }),
      };
      gateway.previewSource.mockRejectedValue(new Error(failure));
      await expect(
        previewPermittedAutomaticGuide(
          createAutomaticGuidePermissions([]).forLocation('https://fixture.invalid/new.xml'),
          'New guide',
          gateway,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(gateway.createHttpsSource).not.toHaveBeenCalled();
      expect(gateway.previewProposedSource).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { saved: [], grant: false },
    { saved: [source()], grant: true },
    { saved: [source({ allowHttp: false })], grant: false },
    { saved: [source({ location: 'http://fixture.invalid/other.xml' })], grant: false },
    { saved: [source({ kind: 'file' })], grant: false },
  ])('uses only exact configured URL grant ($grant)', ({ saved, grant }) => {
    expect(
      createAutomaticGuidePermissions(saved).forLocation('http://fixture.invalid/guide.xml')
        .allowHttp,
    ).toBe(grant);
  });
  it('snapshots primitive metadata and never grants from duplicated URL definitions', () => {
    const original = source();
    const snapshot = createAutomaticGuidePermissions([original]);
    original.allowHttp = false;
    original.name = 'Changed';
    const permission = snapshot.forLocation('http://fixture.invalid/guide.xml');
    expect(permission.source?.name).toBe('My saved guide');
    expect(permission.allowHttp).toBe(true);
    expect(Object.isFrozen(permission.source)).toBe(true);
    expect(
      createAutomaticGuidePermissions([source(), source({ id: 'other' })]).forLocation(
        permission.location,
      ),
    ).toMatchObject({ status: 'ambiguous', source: null, allowHttp: false });
  });
  it('accepts 1000 descriptors and refuses overflow/malformed getters before admission', () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      source({ id: 's' + i, location: 'https://fixture.invalid/' + i }),
    );
    expect(createAutomaticGuidePermissions(rows).forLocation(rows[999]!.location).source?.id).toBe(
      's999',
    );
    expect(() => createAutomaticGuidePermissions([...rows, source({ id: 'overflow' })])).toThrow();
    const getter = vi.fn(() => true),
      raw = source();
    Object.defineProperty(raw, 'allowHttp', { get: getter });
    expect(() => createAutomaticGuidePermissions([raw])).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('previews an existing source by ID without changing its saved name/grant/revision', async () => {
    const existing = source(),
      gateway = setup([existing]);
    const permission = createAutomaticGuidePermissions([existing]).forLocation(existing.location);
    await previewPermittedAutomaticGuide(
      permission,
      'Discovered name',
      gateway,
      new AbortController().signal,
    );
    expect(gateway.previewSource).toHaveBeenCalledExactlyOnceWith('saved', expect.any(AbortSignal));
    expect(gateway.createHttpsSource).not.toHaveBeenCalled();
    expect(existing).toEqual(source());
  });
  it.each(['revoked', 'removed', 'changed-url', 'duplicate'])(
    'refuses stale permission %s without creating/previewing',
    async (change) => {
      const permission = createAutomaticGuidePermissions([source()]).forLocation(source().location);
      const current =
        change === 'revoked'
          ? [source({ allowHttp: false, revision: 2 })]
          : change === 'removed'
            ? []
            : change === 'changed-url'
              ? [source({ location: 'http://fixture.invalid/changed.xml' })]
              : [source(), source({ id: 'duplicate' })];
      const gateway = setup(current);
      await expect(
        previewPermittedAutomaticGuide(
          permission,
          'Discovered',
          gateway,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(gateway.previewSource).not.toHaveBeenCalled();
      expect(gateway.createHttpsSource).not.toHaveBeenCalled();
    },
  );
  it('never previews unconfigured HTTP even if a new grant appeared after capture', async () => {
    const permission = createAutomaticGuidePermissions([]).forLocation(source().location);
    const gateway = setup([source()]);
    await expect(
      previewPermittedAutomaticGuide(
        permission,
        'Discovered',
        gateway,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(gateway.previewSource).not.toHaveBeenCalled();
  });
  it('previews new HTTPS in memory without saving or source-ID preview', async () => {
    const url = 'https://fixture.invalid/new.xml';
    const gateway = setup();
    gateway.sources
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([source({ id: 'new', location: url, allowHttp: false })]);
    const permission = createAutomaticGuidePermissions([]).forLocation(url);
    await previewPermittedAutomaticGuide(
      permission,
      'New guide',
      gateway,
      new AbortController().signal,
    );
    expect(gateway.createHttpsSource).not.toHaveBeenCalled();
    expect(gateway.previewProposedSource).toHaveBeenCalledExactlyOnceWith(
      url,
      'New guide',
      expect.any(AbortSignal),
    );
    expect(gateway.previewSource).not.toHaveBeenCalled();
  });
  it('an HTTPS source created by the user after capture is previewed without overwriting it', async () => {
    const url = 'https://fixture.invalid/new.xml',
      gateway = setup([source({ location: url })]);
    await previewPermittedAutomaticGuide(
      createAutomaticGuidePermissions([]).forLocation(url),
      'Automatic name',
      gateway,
      new AbortController().signal,
    );
    expect(gateway.createHttpsSource).not.toHaveBeenCalled();
    expect(gateway.previewSource).toHaveBeenCalledOnce();
  });
  it('storage failure and canceled held reads never admit network or configuration writes', async () => {
    const permission = createAutomaticGuidePermissions([source()]).forLocation(source().location);
    const gateway = setup();
    gateway.sources.mockRejectedValueOnce(new Error('Storage failed'));
    await expect(
      previewPermittedAutomaticGuide(permission, 'Guide', gateway, new AbortController().signal),
    ).rejects.toThrow('Storage failed');
    const read = held<GuideSource[]>(),
      controller = new AbortController();
    gateway.sources.mockReturnValueOnce(read.promise);
    let settled = false;
    const work = previewPermittedAutomaticGuide(
      permission,
      'Guide',
      gateway,
      controller.signal,
    ).finally(() => {
      settled = true;
    });
    const outcome = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    read.resolve([source()]);
    await outcome;
    expect(gateway.previewSource).not.toHaveBeenCalled();
    expect(gateway.createHttpsSource).not.toHaveBeenCalled();
  });
  it('a native source-identity race refuses the memory proposal without saving', async () => {
    const url = 'https://fixture.invalid/new.xml',
      gateway = setup();
    gateway.previewProposedSource.mockRejectedValueOnce(
      new Error('guide-proposed-source-conflict'),
    );
    await expect(
      previewPermittedAutomaticGuide(
        createAutomaticGuidePermissions([]).forLocation(url),
        'Guide',
        gateway,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(gateway.previewSource).not.toHaveBeenCalled();
  });
  it('an ambiguous location does not suppress independent exact source permissions', () => {
    const permissions = createAutomaticGuidePermissions([
      source(),
      source({ id: 'duplicate' }),
      source({ id: 'healthy', location: 'https://fixture.invalid/healthy.xml' }),
    ]);
    expect(permissions.forLocation(source().location).status).toBe('ambiguous');
    expect(permissions.forLocation('https://fixture.invalid/healthy.xml').source?.id).toBe(
      'healthy',
    );
  });
  it('revocation while the actual metadata read is held joins it and never starts preview', async () => {
    const permission = createAutomaticGuidePermissions([source()]).forLocation(source().location);
    const gateway = setup(),
      read = held<GuideSource[]>();
    gateway.sources.mockReturnValueOnce(read.promise);
    const work = previewPermittedAutomaticGuide(
      permission,
      'Discovered',
      gateway,
      new AbortController().signal,
    );
    const outcome = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    read.resolve([source({ revision: 2, allowHttp: false })]);
    await outcome;
    expect(gateway.previewSource).not.toHaveBeenCalled();
    expect(gateway.createHttpsSource).not.toHaveBeenCalled();
  });
  it('the actual existing Guide host never saves configuration when automatic preview uses sourceId', async () => {
    native.sources.mockReset().mockResolvedValue([source()]);
    native.saveSource.mockReset();
    native.preview
      .mockReset()
      .mockResolvedValue({ ticket: 'owned', sourceId: 'saved', sourceRevision: 1 });
    const host = createGuideHost({
      channels: () => [],
      selectedChannel: () => null,
      watch: async () => {},
    });
    const permission = createAutomaticGuidePermissions([source()]).forLocation(source().location);
    const controller = new AbortController();
    await previewPermittedAutomaticGuide(
      permission,
      'Automatic replacement name',
      {
        sources: native.sources,
        previewSource: (sourceId, signal) => host.preview({ sourceId }, signal),
        previewProposedSource: native.preview,
      },
      controller.signal,
    );
    expect(native.saveSource).not.toHaveBeenCalled();
    expect(native.preview).toHaveBeenCalledExactlyOnceWith('saved', controller.signal, undefined);
    expect(native.sources).toHaveBeenCalledTimes(2);
  });
});
