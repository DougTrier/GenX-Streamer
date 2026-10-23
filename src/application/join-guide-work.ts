/** A failed owner does not release another owner's still-running suspension. */
export async function joinGuideWork(
  owners: readonly { suspend(): Promise<void> }[],
): Promise<void> {
  const stopped = await Promise.allSettled(
    owners.map((owner) => Promise.resolve().then(() => owner.suspend())),
  );
  if (stopped.some((result) => result.status === 'rejected'))
    throw new Error('Automatic guide cleanup could not be confirmed.');
}
