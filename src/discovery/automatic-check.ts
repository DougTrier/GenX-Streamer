import {
  createHealthObservation,
  reconcileHealth,
  type HealthObservation,
  type HealthEvidence,
} from './health';
import type { ReviewCandidate, ScanReview } from './scan';
import type { HealthCheckBudgetMs } from '../sources/health-inspection';

export interface AutomaticCheckProgress {
  done: number;
  total: number;
  responded: number;
  observation?: HealthObservation;
}
export interface ScanProbeSourcePolicy {
  sourceId: string;
  fingerprint: string;
  allowHttp: boolean;
  /** Exact request headers captured by the acquisition owner; omitted means none. */
  headers?: Readonly<Record<string, string>>;
}
export interface AutomaticCheckOptions {
  probe(
    candidate: ReviewCandidate,
    signal: AbortSignal,
    budgetMs: HealthCheckBudgetMs,
  ): Promise<HealthObservation>;
  platform: string;
  signal: AbortSignal;
  /** Without captured policy scope, every candidate retains its own actual probe. */
  sourcePolicies?: readonly ScanProbeSourcePolicy[];
  budgetMs?: HealthCheckBudgetMs;
  /** Response probes only; each provider retains its own pacing policy. */
  maxConcurrency?: number;
  now?(): number;
  timer?: { set(callback: () => void, delayMs: number): unknown; clear(handle: unknown): void };
  progress?(progress: AutomaticCheckProgress): void;
  /** Owned publication work must settle before this worker admits another probe. */
  onObservation?(candidate: ReviewCandidate, observation: HealthObservation): Promise<void>;
}
export interface AutomaticCheckResult {
  observations: HealthObservation[];
  eligibleKeys: string[];
}

/** Checks the exact collected snapshot, without another collection or a second decoder. */
export async function checkScanCandidates(
  review: ScanReview,
  options: AutomaticCheckOptions,
): Promise<AutomaticCheckResult> {
  return runChecks(review, options, false);
}
/** No trusted flag: all reachable snapshot data must already be immutable plain DTOs. */
export async function checkOwnedScanCandidates(
  review: ScanReview,
  options: AutomaticCheckOptions,
): Promise<AutomaticCheckResult> {
  options.signal.throwIfAborted();
  await assertFrozenSnapshot(review, options.signal);
  return runChecks(review, options, true);
}
/** Work bounds cover the admitted 100k DTO graph; this verification owns no lasting cache. */
async function assertFrozenSnapshot(value: unknown, signal: AbortSignal): Promise<void> {
  const refuse = () => new Error('Owned channel check requires a deeply frozen data snapshot.');
  if (!value || typeof value !== 'object') throw refuse();
  const candidateDescriptor = Object.getOwnPropertyDescriptor(value, 'candidates');
  if (
    !candidateDescriptor ||
    !Object.hasOwn(candidateDescriptor, 'value') ||
    !Array.isArray(candidateDescriptor.value) ||
    candidateDescriptor.value.length > 100000
  )
    throw refuse();
  const complete = new WeakSet<object>(),
    active = new WeakSet<object>();
  type Frame = { item: object; keys: (string | symbol)[]; position: number; depth: number };
  const stack: Frame[] = [];
  let nodes = 0,
    edges = 0,
    lastYield = 0;
  const enter = (item: unknown, depth: number): void => {
    if (item === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof item)) return;
    if (typeof item !== 'object' || depth > 32 || active.has(item)) throw refuse();
    if (complete.has(item)) return;
    if (++nodes > 1000000)
      throw new Error('Owned channel check snapshot exceeds its verification bound.');
    const prototype = Object.getPrototypeOf(item);
    if (
      !Object.isFrozen(item) ||
      (Array.isArray(item)
        ? prototype !== Array.prototype
        : ![Object.prototype, null].includes(prototype))
    )
      throw refuse();
    if (Array.isArray(item) && item.length > 100000) throw refuse();
    const keys = Reflect.ownKeys(item);
    if (Array.isArray(item) ? keys.length > item.length + 1 : keys.length > 32) throw refuse();
    active.add(item);
    stack.push({ item, keys, position: 0, depth });
  };
  enter(value, 0);
  while (stack.length) {
    const frame = stack.at(-1)!;
    if (frame.position === frame.keys.length) {
      active.delete(frame.item);
      complete.add(frame.item);
      stack.pop();
      continue;
    }
    if (++edges > 8000000)
      throw new Error('Owned channel check snapshot exceeds its verification bound.');
    if (edges % 128 === 0) signal.throwIfAborted();
    if (edges - lastYield >= 16384) {
      // Yield to real cancellation; the one accepted timer is joined before returning.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      lastYield = edges;
    }
    const key = frame.keys[frame.position++]!;
    if (typeof key !== 'string') throw refuse();
    if (
      Array.isArray(frame.item) &&
      key !== 'length' &&
      (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= frame.item.length)
    )
      throw refuse();
    const descriptor = Object.getOwnPropertyDescriptor(frame.item, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw refuse();
    enter(descriptor.value, frame.depth + 1);
  }
  signal.throwIfAborted();
}
async function runChecks(
  review: ScanReview,
  options: AutomaticCheckOptions,
  owned: boolean,
): Promise<AutomaticCheckResult> {
  const budgetMs = options.budgetMs ?? 20_000;
  const maxConcurrency = options.maxConcurrency ?? 4;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16)
    throw new Error('Channel check concurrency must be an integer from 1 to 16.');
  const now = options.now ?? Date.now;
  const timer = options.timer ?? {
    set: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  options.signal.throwIfAborted();
  if (
    review.status !== 'completed' ||
    review.candidates.length > 100_000 ||
    ![20_000, 45_000, 60_000].includes(budgetMs)
  )
    throw new Error('Automatic channel check scope is invalid or exceeds 100,000 channels.');
  const candidates = owned ? review.candidates : structuredClone(review.candidates);
  const keys = new Set<string>();
  for (const candidate of candidates) {
    if (
      keys.has(candidate.key) ||
      candidate.sessionRevision !== review.sessionRevision ||
      candidate.channel.sourceId !== candidate.sourceId
    )
      throw new Error('Automatic channel check candidate ownership is invalid.');
    keys.add(candidate.key);
    createHealthObservation(
      {
        channelId: candidate.key,
        sourceId: candidate.sourceId,
        fingerprint: candidate.sourceFingerprint,
      },
      { platform: options.platform, observedAt: now() },
      { kind: 'not-checked' },
    );
  }
  const policies = new Map<string, ScanProbeSourcePolicy>();
  if (options.sourcePolicies) {
    if (options.sourcePolicies.length > 100)
      throw new Error('Probe source scope exceeds its bound.');
    for (const policy of structuredClone(options.sourcePolicies)) {
      if (
        !policy.sourceId ||
        !policy.fingerprint ||
        typeof policy.allowHttp !== 'boolean' ||
        policies.has(policy.sourceId)
      )
        throw new Error('Probe source policy scope is invalid.');
      if (
        policy.headers &&
        (Object.keys(policy.headers).length > 32 ||
          Object.entries(policy.headers).some(
            ([key, value]) =>
              !key ||
              key.length > 256 ||
              typeof value !== 'string' ||
              value.length > 4096 ||
              /[\r\n]/.test(key + value),
          ))
      )
        throw new Error('Probe header scope is invalid.');
      policies.set(policy.sourceId, policy);
    }
  }
  // Bounded response reuse, never decoder proof or a cross-provider catalog merge.
  const responses = new Map<
    string,
    { observedAt: number; evidence: HealthEvidence; cost: number }
  >();
  let responseBytes = 0;
  const stable = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : item,
    );
  const responseKey = (candidate: ReviewCandidate): string | null => {
    const policy = policies.get(candidate.sourceId);
    if (!policy || policy.fingerprint !== candidate.sourceFingerprint) return null;
    try {
      const { sourceId: _sourceId, ...metadata } = candidate.channel;
      const key = stable({
        ...metadata,
        urls: metadata.urls.map((url) => new URL(url).href),
        allowHttp: policy.allowHttp,
        headers: policy.headers ?? {},
        platform: options.platform,
        budgetMs,
      });
      return key.length * 2 + 512 <= 1024 * 1024 ? key : null;
    } catch {
      return null;
    }
  };
  const rememberResponse = (key: string | null, observed: HealthObservation) => {
    if (!key || observed.verdict !== 'Reachable') return;
    const cost = key.length * 2 + 512;
    const previous = responses.get(key);
    if (previous) {
      responseBytes -= previous.cost;
      responses.delete(key);
    }
    while (responses.size >= 256 || responseBytes + cost > 1024 * 1024) {
      const oldest = responses.keys().next().value;
      if (oldest === undefined) return;
      responseBytes -= responses.get(oldest)!.cost;
      responses.delete(oldest);
    }
    responses.set(key, {
      observedAt: observed.observedAt,
      evidence: structuredClone(observed.evidence),
      cost,
    });
    responseBytes += cost;
  };
  const observations = new Array<HealthObservation>(candidates.length);
  let done = 0,
    responded = 0,
    admitted = 0,
    failure: unknown;
  // Only one head per idle origin is eligible. The min-heap preserves input
  // priority without repeatedly scanning a potentially 100,000-entry review.
  const origins = new Map<string, { indices: number[]; next: number }>();
  const invalidDestinations = new Set<number>();
  const originKeys = candidates.map((candidate, index) => {
    let origin: string;
    try {
      const url = new URL(candidate.channel.urls[0]!);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Invalid origin');
      origin = url.origin;
    } catch {
      // A malformed destination belongs to this channel, not the whole scan.
      // Never dispatch it or share its inert lane with a real provider.
      invalidDestinations.add(index);
      origin = `invalid:${index}`;
    }
    const group = origins.get(origin) ?? { indices: [], next: 0 };
    group.indices.push(index);
    origins.set(origin, group);
    return origin;
  });
  const eligible: number[] = [];
  const push = (index: number) => {
    let position = eligible.length;
    eligible.push(index);
    while (position > 0) {
      const parent = (position - 1) >> 1;
      if (eligible[parent]! <= index) break;
      eligible[position] = eligible[parent]!;
      position = parent;
    }
    eligible[position] = index;
  };
  const take = (): number | undefined => {
    const first = eligible[0];
    const last = eligible.pop();
    if (eligible.length && last !== undefined) {
      let position = 0;
      while (position * 2 + 1 < eligible.length) {
        let child = position * 2 + 1;
        if (child + 1 < eligible.length && eligible[child + 1]! < eligible[child]!) child++;
        if (last <= eligible[child]!) break;
        eligible[position] = eligible[child]!;
        position = child;
      }
      eligible[position] = last;
    }
    return first;
  };
  for (const group of origins.values()) push(group.indices[0]!);
  const waiters = new Set<() => void>();
  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const owner = new AbortController();
  const cancelOwner = () => {
    owner.abort();
    wake();
  };
  options.signal.addEventListener('abort', cancelOwner, { once: true });
  if (options.signal.aborted) cancelOwner();
  const progress = (observation?: HealthObservation) => {
    options.signal.throwIfAborted();
    options.progress?.({
      done,
      total: candidates.length,
      responded,
      ...(observation ? { observation: structuredClone(observation) } : {}),
    });
  };
  const check = async (candidate: ReviewCandidate, index: number): Promise<HealthObservation> => {
    owner.signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    owner.signal.addEventListener('abort', abort, { once: true });
    let expired = false;
    let deadline: unknown,
      deadlineSet = false;
    const started = now();
    const identity = {
      channelId: candidate.key,
      sourceId: candidate.sourceId,
      fingerprint: candidate.sourceFingerprint,
    };
    let observed: HealthObservation;
    if (invalidDestinations.has(index)) {
      owner.signal.removeEventListener('abort', abort);
      return createHealthObservation(
        identity,
        { platform: options.platform, observedAt: now() },
        { kind: 'unsupported' },
      );
    }
    const reusableKey = responseKey(candidate);
    const cached = reusableKey ? responses.get(reusableKey) : undefined;
    if (cached && now() >= cached.observedAt && now() - cached.observedAt < budgetMs) {
      owner.signal.removeEventListener('abort', abort);
      options.signal.throwIfAborted();
      return createHealthObservation(
        identity,
        { platform: options.platform, observedAt: cached.observedAt },
        structuredClone(cached.evidence),
      );
    }
    try {
      deadline = timer.set(() => {
        expired = true;
        controller.abort();
      }, budgetMs);
      deadlineSet = true;
      let reply: HealthObservation | undefined;
      try {
        reply = await options.probe(
          owned ? structuredClone(candidate) : candidate,
          controller.signal,
          budgetMs,
        );
      } catch (error) {
        if (options.signal.aborted) {
          if (!(error instanceof Error && error.name === 'AbortError')) {
            // eslint-disable-next-line preserve-caught-error -- Provider and native diagnostics may contain private source addresses.
            throw new Error('Channel check cancellation could not be confirmed.');
          }
          options.signal.throwIfAborted();
        }
      }
      options.signal.throwIfAborted();
      if (expired || now() - started >= budgetMs)
        observed = createHealthObservation(
          identity,
          { platform: options.platform, observedAt: now() },
          { kind: 'timeout' },
        );
      else if (!reply)
        observed = createHealthObservation(
          identity,
          { platform: options.platform, observedAt: now() },
          { kind: 'network-failure' },
        );
      else {
        try {
          if (
            reply.platform !== options.platform ||
            reply.observedAt < started ||
            reply.observedAt > now()
          )
            throw new Error('Channel check result is obsolete or belongs to another platform.');
          if (
            reply.channelId !== identity.channelId ||
            reply.sourceId !== identity.sourceId ||
            reply.fingerprint !== identity.fingerprint
          )
            throw new Error('Channel check result belongs to another source or candidate.');
          const checked = createHealthObservation(
            identity,
            { platform: reply.platform, observedAt: reply.observedAt },
            safeEvidence(reply.evidence),
          );
          const accepted = reconcileHealth(identity, null, checked);
          if (!accepted.accepted || !accepted.record)
            throw new Error('Channel check result belongs to another source or candidate.');
          observed = accepted.record;
        } catch {
          // Refuse unsafe/stale evidence without admitting success or aborting peers.
          observed = createHealthObservation(
            identity,
            { platform: options.platform, observedAt: now() },
            { kind: 'not-checked' },
          );
        }
      }
    } finally {
      try {
        if (deadlineSet) timer.clear(deadline);
      } finally {
        owner.signal.removeEventListener('abort', abort);
      }
    }
    options.signal.throwIfAborted();
    owner.signal.throwIfAborted();
    rememberResponse(reusableKey, observed);
    return observed;
  };
  const worker = async () => {
    try {
      while (!owner.signal.aborted && admitted < candidates.length) {
        const index = take();
        if (index === undefined) {
          await new Promise<void>((resolve) => waiters.add(resolve));
          continue;
        }
        admitted++;
        const group = origins.get(originKeys[index]!)!;
        group.next++;
        try {
          const observed = await check(candidates[index]!, index);
          owner.signal.throwIfAborted();
          if (options.onObservation) {
            await options.onObservation(
              structuredClone(candidates[index]!),
              structuredClone(observed),
            );
            owner.signal.throwIfAborted();
            options.signal.throwIfAborted();
          }
          observations[index] = observed;
          done++;
          if (observed.verdict === 'Reachable' || observed.verdict === 'PlayedHere') responded++;
          progress(observed);
        } finally {
          const next = group.indices[group.next];
          if (next !== undefined && !owner.signal.aborted) push(next);
          wake();
        }
      }
    } catch (error) {
      if (
        failure === undefined ||
        (error instanceof Error &&
          error.message === 'Channel check cancellation could not be confirmed.')
      )
        failure = error;
      owner.abort();
      wake();
    }
  };
  try {
    progress();
    await Promise.all(
      Array.from({ length: Math.min(maxConcurrency, candidates.length) }, () => worker()),
    );
    if (failure !== undefined) throw failure;
    options.signal.throwIfAborted();
    return {
      observations,
      eligibleKeys: observations.flatMap((observed, index) =>
        observed.verdict === 'Reachable' || observed.verdict === 'PlayedHere'
          ? [candidates[index]!.key]
          : [],
      ),
    };
  } finally {
    options.signal.removeEventListener('abort', cancelOwner);
    responses.clear();
  }
}

function safeEvidence(value: HealthEvidence): HealthEvidence {
  const allowed: Record<string, string[]> = {
    http: ['kind', 'status', 'contentRecognized'],
    decoded: ['kind', 'before', 'after', 'elapsedMilliseconds'],
    'recognized-media-response': ['kind'],
    timeout: ['kind'],
    slow: ['kind'],
    unsupported: ['kind'],
    canceled: ['kind'],
    'local-network-unavailable': ['kind'],
    'network-failure': ['kind'],
    'host-down': ['kind'],
    'not-checked': ['kind'],
  };
  if (
    !value ||
    typeof value !== 'object' ||
    !allowed[value.kind] ||
    Object.keys(value).some((key) => !allowed[value.kind]!.includes(key))
  )
    throw new Error('Channel check evidence is invalid.');
  if (
    value.kind === 'http' &&
    value.contentRecognized !== undefined &&
    typeof value.contentRecognized !== 'boolean'
  )
    throw new Error('Channel check evidence is invalid.');
  if (value.kind === 'decoded')
    for (const sample of [value.before, value.after]) {
      if (
        !sample ||
        typeof sample !== 'object' ||
        Object.keys(sample).some(
          (key) => !['mediaTime', 'decodedFrames', 'width', 'height'].includes(key),
        )
      )
        throw new Error('Channel check evidence is invalid.');
    }
  return value;
}
