import { describe, expect, it } from 'vitest';
import { createCloseFinalizationObserver } from '../../src/application/close-finalization';

describe('close finalization observation', () => {
  it('times actual finalization promises without retaining errors or changing their result', async () => {
    let now = 10,
      finish!: (value: number) => void;
    const observer = createCloseFinalizationObserver(() => now);
    const work = observer.run(
      'preferences',
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    now = 40;
    expect(observer.snapshot().timings.active[0]).toMatchObject({
      phase: 'preferences',
      elapsedMs: 30,
    });
    finish(7);
    expect(await work).toBe(7);
    expect(observer.snapshot().timings.completed[0]).toMatchObject({
      phase: 'preferences',
      elapsedMs: 30,
      outcome: 'fulfilled',
    });
  });
  it('reports the actual retained wait without mutating earlier snapshots', async () => {
    const observer = createCloseFinalizationObserver();
    const before = observer.snapshot();
    let release!: () => void;
    const work = observer.run(
      'preferences',
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    expect(observer.snapshot()).toMatchObject({
      stage: 'preferences',
      pending: true,
      failed: false,
    });
    expect(before).toMatchObject({ stage: 'idle', pending: false });
    expect(Object.isFrozen(before)).toBe(true);
    release();
    await work;
    expect(observer.snapshot()).toMatchObject({ stage: 'preferences', pending: false });
    observer.complete();
    expect(observer.snapshot().stage).toBe('completed');
  });

  it('preserves failure identity for the caller and exposes only a fixed failing stage', async () => {
    const observer = createCloseFinalizationObserver();
    const failure = new Error('private provider token');
    await expect(
      observer.run('event-history', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(observer.snapshot()).toMatchObject({
      stage: 'event-history',
      failed: true,
      pending: false,
    });
    expect(JSON.stringify(observer.snapshot())).not.toContain('private');
    await observer.run('event-history', async () => {});
    expect(observer.snapshot().failed).toBe(false);
  });
});
