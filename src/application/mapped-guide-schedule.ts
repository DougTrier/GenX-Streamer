/** Explicit Map only. The caller owns this entire promise through close/background. */
export interface MappedGuideIdentity {
  catalogSourceId: string;
  appChannelId: string;
  guideSourceId: string;
  xmltvChannelId: string;
}
export interface MappedGuideReceipt {
  schemaVersion: 1;
  mapping: MappedGuideIdentity;
  rootGeneration: string;
  catalogRevision: string;
  guideRevision: number;
  sourceRevision: number;
  sourceFingerprint: string;
}
export interface MappedGuidePreview {
  ticket: string;
  sourceId: string;
  sourceRevision: number;
}
export interface MappedGuideHydrationResult {
  status: 'ready' | 'no-listings' | 'saved-but-failed' | 'file-required' | 'canceled';
  published: boolean;
}
export interface MappedGuideHydrationHost {
  /** Calls committed immediately after a validated durable ACK, before cleanup/abort checks. */
  save(
    mapping: MappedGuideIdentity,
    signal: AbortSignal,
    committed: (receipt: MappedGuideReceipt) => void,
  ): Promise<MappedGuideReceipt>;
  /** Native verifies the exact root, catalog, mapping, source descriptor and requested revision. */
  status(
    receipt: MappedGuideReceipt,
    revision: number,
    signal: AbortSignal,
  ): Promise<{ kind: 'url' | 'file'; listed: boolean }>;
  /** Native admission binds the ACK root/source/catalog/guide revision and mapping atomically. */
  preview(receipt: MappedGuideReceipt, signal: AbortSignal): Promise<MappedGuidePreview>;
  /** Cache-only publication, never auto-match unrelated channels. A durable ACK wins late abort. */
  publish(
    preview: MappedGuidePreview,
    signal: AbortSignal,
    committed: (revision: number) => void,
  ): Promise<number>;
  /** Must retain failed cleanup ownership and join native work before rejection. */
  discard(ticket: string): Promise<void>;
}
export class MappedGuideCleanupError extends Error {
  readonly mappingSaved = true;
  constructor() {
    super('Guide connection saved. Schedule cleanup could not be confirmed.');
    this.name = 'MappedGuideCleanupError';
  }
}
export const mappedGuideResultText = (result: MappedGuideHydrationResult): string => {
  switch (result.status) {
    case 'ready':
      return 'Program guide connected. Listings are ready.';
    case 'no-listings':
      return 'Guide connection saved. This source has no listings for this channel in the next seven days.';
    case 'file-required':
      return 'Guide connection saved. Choose the guide file again in Manage sources to load its listings.';
    case 'canceled':
      return result.published
        ? 'Guide connection and schedule saved.'
        : 'Guide connection saved. Schedule update canceled.';
    default:
      return 'Guide connection saved. Its schedule could not be updated. Retry from Manage sources.';
  }
};
export async function mapGuideAndHydrate(
  host: MappedGuideHydrationHost,
  mapping: MappedGuideIdentity,
  signal: AbortSignal,
  saved: () => void,
): Promise<MappedGuideHydrationResult> {
  signal.throwIfAborted();
  const captured = Object.freeze({ ...mapping });
  let acknowledged = false;
  let published = false;
  let ticket: string | null = null;
  try {
    const receipt = await host.save(captured, signal, () => {
      acknowledged = true;
      saved();
    });
    // The ACK callback is part of the transport contract, not a speculative UI event.
    if (!acknowledged) throw new Error('Guide mapping acknowledgment missing.');
    signal.throwIfAborted();
    const current = await host.status(receipt, receipt.sourceRevision, signal);
    signal.throwIfAborted();
    if (current.listed) return { status: 'ready', published: false };
    if (current.kind === 'file') return { status: 'file-required', published: false };
    const preview = await host.preview(receipt, signal);
    ticket = preview.ticket;
    signal.throwIfAborted();
    const revision = await host.publish(preview, signal, () => {
      published = true;
      ticket = null; // A validated COMMIT ACK wins even a later cleanup failure.
    });
    if (!published) throw new Error('Guide publication acknowledgment missing.');
    if (signal.aborted) return { status: 'canceled', published };
    const final = await host.status(receipt, revision, signal);
    signal.throwIfAborted();
    return { status: final.listed ? 'ready' : 'no-listings', published };
  } catch (error) {
    if (ticket) {
      try {
        await host.discard(ticket);
      } catch {
        throw new MappedGuideCleanupError();
      }
    }
    if (error instanceof MappedGuideCleanupError) throw error;
    if (!acknowledged) throw error;
    return {
      status: signal.aborted ? 'canceled' : 'saved-but-failed',
      published,
    };
  }
}
