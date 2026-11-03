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

/** A failed owner does not release another owner's still-running suspension. */
export async function joinGuideWork(
  owners: readonly { suspend(): Promise<void>; reportFailure?(): void }[],
): Promise<void> {
  const stopped = await Promise.allSettled(
    owners.map((owner) => Promise.resolve().then(() => owner.suspend())),
  );
  let failed = false;
  stopped.forEach((result, index) => {
    if (result.status !== 'rejected') return;
    failed = true;
    owners[index]?.reportFailure?.();
  });
  if (failed) throw new Error('Automatic guide cleanup could not be confirmed.');
}
