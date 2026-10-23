import type { ArchiveDiscoverySnapshot } from '../application/archive-discovery';

export interface ArchiveDiscoveryStatus {
  readonly hidden: boolean;
  readonly text: string;
  /** Optional diagnostics/accessibility details; not a second visible status block. */
  readonly details: string;
  readonly action: 'find-more' | 'continue' | null;
  readonly actionReady: boolean;
  readonly retryDelayMs: number | null;
}

export interface ArchiveDiscoveryStatusOptions {
  /** Explicit clock input keeps presentation deterministic and starts no timer. */
  nowEpochMs: number;
  /** Actual native count for this exact query/revision; never the library title count. */
  resultCount?: number;
}

/** Fixed copy only. Acquisition, counters and durable receipts remain with the broker. */
export function archiveDiscoveryStatus(
  snapshot: Readonly<ArchiveDiscoverySnapshot>,
  options: ArchiveDiscoveryStatusOptions,
): Readonly<ArchiveDiscoveryStatus> {
  const action = snapshot.query.trim() ? 'find-more' : 'continue';
  const label = 'Search';
  const retryDelayMs =
    snapshot.retryAfterMs !== null && snapshot.retryAfterMs > options.nowEpochMs
      ? snapshot.retryAfterMs - options.nowEpochMs
      : null;
  const continueInstruction = 'Search again to continue.';
  const waitInstruction =
    retryDelayMs === null
      ? null
      : `${label} in ${Math.ceil(retryDelayMs / 1000)} ${Math.ceil(retryDelayMs / 1000) === 1 ? 'second' : 'seconds'}.`;
  const resultCount =
    Number.isSafeInteger(options.resultCount) && options.resultCount! >= 0
      ? options.resultCount
      : undefined;
  const details = [
    `Checked: ${snapshot.examined}.`,
    `Admitted candidates: ${snapshot.admitted}.`,
    `Unknown years skipped: ${snapshot.excludedUnknownYear}.`,
    `Unavailable checks: ${snapshot.unavailable}.`,
    `Temporary failures: ${snapshot.transientFailures}.`,
    `Confirmed unavailable: ${snapshot.confirmedDead}.`,
    `Library titles: ${snapshot.titleCount}.`,
    `Years checked: ${snapshot.yearsChecked}/${snapshot.yearsTotal}.`,
    `Years complete: ${snapshot.yearsComplete}.`,
    `Years pending: ${snapshot.yearsPending}.`,
    `Pending video pages: ${snapshot.pendingFilePages.length}.`,
    `Capacity reached: ${snapshot.capacityReached ? 'yes' : 'no'}.`,
  ].join(' ');
  let text = '';
  let nextAction: ArchiveDiscoveryStatus['action'] = null;
  let actionReady = false;
  switch (snapshot.state) {
    case 'reading':
      text = 'Preparing search…';
      break;
    case 'discovering':
      text = snapshot.examined
        ? `Checking… ${snapshot.examined} items checked.`
        : 'Checking items…';
      break;
    case 'complete':
      text =
        resultCount === 0
          ? snapshot.pendingFilePages.length
            ? 'More items remain to check.'
            : 'No matching saved videos. Try another search.'
          : 'Search finished. Browse the results.';
      break;
    case 'partial':
      if (snapshot.capacityReached && snapshot.yearsTotal > 0 && snapshot.yearsPending === 0) {
        text = 'Some searches reached their limit. Browse the saved results.';
        break;
      }
      nextAction = action;
      actionReady = retryDelayMs === null;
      text =
        retryDelayMs !== null
          ? `Search paused. ${waitInstruction}`
          : snapshot.transientFailures
            ? `Some checks couldn’t finish. ${label} to try again.`
            : snapshot.examined
              ? `Checked ${snapshot.examined} items. ${continueInstruction}`
              : `More checks remain. ${continueInstruction}`;
      break;
    case 'waiting':
      nextAction = action;
      actionReady = retryDelayMs === null;
      text =
        retryDelayMs !== null
          ? `Search paused. ${waitInstruction}`
          : `Search paused. ${label} to try again.`;
      break;
    case 'capacity':
      text = 'This search reached its limit. Try another search.';
      break;
    case 'canceled':
      text =
        retryDelayMs === null
          ? `Search canceled. ${label} when ready.`
          : `Search canceled. ${waitInstruction}`;
      nextAction = action;
      actionReady = retryDelayMs === null;
      break;
    case 'failed':
      text =
        retryDelayMs === null
          ? `Search couldn’t finish. ${label} to try again.`
          : `Search couldn’t finish. ${waitInstruction}`;
      nextAction = action;
      actionReady = retryDelayMs === null;
      break;
    case 'idle':
    case 'disposed':
      break;
  }
  return Object.freeze({
    hidden: !text,
    text,
    details,
    action: nextAction,
    actionReady,
    retryDelayMs,
  });
}
