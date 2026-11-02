// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import {
  ArchivePlaybackCleanupError,
  ArchivePlaybackUnavailableError,
  archivePlaybackDiagnosticReason,
  type ArchivePlaybackDiagnosticReason,
} from '../platform/archive-playback';
import { ArchiveBookmarkError } from '../platform/archive-bookmarks';
import {
  ArchiveFileRemovedError,
  ArchivePlayerCleanupError,
} from '../application/genxtra/archive-player';
import { recordPlaybackTrace, type TraceValues } from './playback-trace';

const phases = [
  'release',
  'guide',
  'before-start',
  'allocate',
  'bookmark',
  'resume-choice',
  'bookmark-reset',
  'decode',
  'resume-seek',
  'unknown',
] as const;
export type ArchiveStartupPhase = (typeof phases)[number];
export type ArchiveStartupReason =
  | ArchivePlaybackDiagnosticReason
  | 'cancelled'
  | 'bookmark-stale'
  | 'bookmark-unproven'
  | 'bookmark-failed'
  | 'bookmark-unavailable';

/** Do not inspect Error messages, nested causes, request values or native identities. */
function reason(error: unknown): ArchiveStartupReason {
  try {
    const native = archivePlaybackDiagnosticReason(error);
    if (native) return native;
    if (error instanceof ArchivePlaybackCleanupError) return 'cleanup';
    if (error instanceof ArchivePlayerCleanupError) return 'cleanup';
    if (error instanceof ArchiveFileRemovedError) return 'unavailable';
    if (error instanceof ArchivePlaybackUnavailableError) return 'unavailable';
    if (error instanceof ArchiveBookmarkError) {
      const category = Object.getOwnPropertyDescriptor(error, 'category')?.value;
      if (['stale', 'unproven', 'failed', 'unavailable'].includes(category))
        return `bookmark-${category}` as ArchiveStartupReason;
    }
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  } catch {
    // A forged/proxied failure cannot break playback or export private values.
  }
  return 'unknown';
}

export function archiveStartupFailureFacts(
  phase: ArchiveStartupPhase,
  error: unknown,
): TraceValues {
  return {
    initiator: 'startup',
    startupPhase: phases.includes(phase) ? phase : 'unknown',
    startupReason: reason(error),
    code: 'unknown',
    phase: 'startup-progress',
    evidence: 'opaque',
  };
}

/** Opt-in exported capture is independent of decoder selection/current player mode. */
export function recordArchiveStartupFailure(phase: ArchiveStartupPhase, error: unknown): void {
  recordPlaybackTrace('genxtra', 'error', archiveStartupFailureFacts(phase, error));
}
