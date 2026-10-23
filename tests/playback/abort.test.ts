import { describe, expect, it, vi } from 'vitest';
import { combineAbortSignals } from '../../src/platform/abort';

describe('WebView compatible cancellation composition', () => {
  it('uses the first reason and releases every registered listener', () => {
    const a = new AbortController();
    const b = new AbortController();
    const removeA = vi.spyOn(a.signal, 'removeEventListener');
    const removeB = vi.spyOn(b.signal, 'removeEventListener');
    const combined = combineAbortSignals([a.signal, b.signal]);
    a.abort('first');
    b.abort('obsolete');
    expect(combined.reason).toBe('first');
    expect(removeA).toHaveBeenCalledTimes(1);
    expect(removeB).toHaveBeenCalledTimes(1);
  });
  it('settles an already aborted input without retaining earlier listeners', () => {
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    const remove = vi.spyOn(a.signal, 'removeEventListener');
    const later = vi.spyOn(c.signal, 'addEventListener');
    b.abort('already canceled');
    expect(combineAbortSignals([a.signal, b.signal, c.signal]).reason).toBe('already canceled');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
  });
  it('registers one listener for repeated references to the same owner', () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const combined = combineAbortSignals([controller.signal, controller.signal]);
    expect(add).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(combined.aborted).toBe(true);
  });
});
