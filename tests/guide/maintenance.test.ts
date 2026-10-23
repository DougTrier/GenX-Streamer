import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ invoke: vi.fn(), native: true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: () => api.native }));
import { maintainGuideStorage, validateGuideMaintenance } from '../../src/guide/maintenance';
const page = { pageSize: 4096, pages: 8, freePages: 0, fileBytes: 32768 };
function receipt() {
  return {
    maintenance: {
      value: {
        sourcesChanged: 1,
        programsBefore: 2000,
        programsAfter: 30,
        programsRemoved: 1970,
        headersRetained: 40,
      },
      compaction: { status: 'compacted', before: page, after: page },
      fatalVerification: null as string | null,
    },
    rootGeneration: 2,
    quarantined: false,
    quarantineError: null as string | null,
  };
}
beforeEach(() => {
  api.invoke.mockReset();
  api.native = true;
});
it('keeps retention success distinct from deferred physical compaction and quarantine', () => {
  const r = receipt();
  r.maintenance.compaction = {
    status: 'deferred',
    reason: 'sqlite-maintenance-canceled',
    pages: page,
  } as unknown as typeof r.maintenance.compaction;
  expect(validateGuideMaintenance(r)).toBe('deferred');
  r.maintenance.fatalVerification = 'sqlite-maintenance-verification-failed';
  r.quarantined = true;
  expect(validateGuideMaintenance(r)).toBe('reopen-required');
  expect(r.maintenance.value.programsRemoved).toBe(1970);
});
it.each([
  (r: ReturnType<typeof receipt>) => (r.maintenance.value.programsRemoved = 2001),
  (r: ReturnType<typeof receipt>) => (r.maintenance.value.programsAfter = -1),
  (r: ReturnType<typeof receipt>) => (r.maintenance.compaction.after.freePages = 9),
  (r: ReturnType<typeof receipt>) => (r.rootGeneration = Number.MAX_SAFE_INTEGER + 1),
  (r: ReturnType<typeof receipt>) => (r.quarantined = true),
  (r: ReturnType<typeof receipt>) => (r.quarantineError = 'verification-error'),
  (r: ReturnType<typeof receipt>) => Reflect.set(r.maintenance.compaction, 'status', 'unknown'),
  (r: ReturnType<typeof receipt>) => Reflect.set(r, 'extra', true),
])('refuses malformed counts, geometry, unknown status and invented quarantine', (mutate) => {
  const r = structuredClone(receipt());
  mutate(r);
  expect(() => validateGuideMaintenance(r)).toThrow('receipt is invalid');
});
it('fatal physical geometry remains reopen-required instead of being hidden as a normal retry', () => {
  const r = receipt();
  r.maintenance.fatalVerification = 'sqlite-maintenance-verification-failed';
  r.quarantined = true;
  r.maintenance.compaction = {
    status: 'failed',
    reason: 'sqlite-maintenance-verification-failed',
    before: page,
    after: { ...page, fileBytes: page.fileBytes + 1 },
  } as unknown as typeof r.maintenance.compaction;
  expect(validateGuideMaintenance(r)).toBe('reopen-required');
  r.maintenance.fatalVerification = null;
  r.quarantined = false;
  expect(() => validateGuideMaintenance(r)).toThrow('receipt is invalid');
});
it('cancellation joins the original native command and matching cancel acknowledgment', async () => {
  let finish!: (v: unknown) => void;
  let finishCancel!: () => void;
  api.invoke.mockImplementation((command: string) =>
    command === 'cancel_playlist'
      ? new Promise<void>((resolve) => (finishCancel = resolve))
      : new Promise((resolve) => (finish = resolve)),
  );
  const controller = new AbortController();
  const work = maintainGuideStorage(controller.signal);
  let settled = false;
  void work.finally(() => (settled = true));
  controller.abort();
  const requestId = api.invoke.mock.calls[0][1].requestId;
  expect(api.invoke.mock.calls).toEqual([
    ['guide_retention_cleanup', { requestId }],
    ['cancel_playlist', { requestId }],
  ]);
  finish(receipt());
  await Promise.resolve();
  expect(settled).toBe(false);
  finishCancel();
  expect(await work).toBe('compacted');
});
it('does not start native maintenance when already canceled or outside installed app', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(maintainGuideStorage(controller.signal)).rejects.toThrow();
  api.native = false;
  await expect(maintainGuideStorage(new AbortController().signal)).rejects.toThrow('installed app');
  expect(api.invoke).not.toHaveBeenCalled();
});
it('unconfirmed cancellation stays an error even when the SQL receipt arrives', async () => {
  let finish!: (v: unknown) => void;
  api.invoke.mockImplementation((command: string) =>
    command === 'cancel_playlist'
      ? Promise.reject(new Error('fixture cancellation unavailable'))
      : new Promise((resolve) => (finish = resolve)),
  );
  const controller = new AbortController();
  const work = maintainGuideStorage(controller.signal);
  controller.abort();
  finish(receipt());
  await expect(work).rejects.toThrow('cancellation could not be confirmed');
});
