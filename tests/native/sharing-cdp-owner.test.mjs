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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnedCdp } from './sharing-cdp-owner.mjs';

test('successful diagnostic retains live owner', async () => {
  let canceled = 0;
  const owner = new OwnedCdp(1, async () => {
    canceled++;
  });
  assert.equal(await owner.run('fixture', async () => 42, 20), 42);
  assert.equal(canceled, 0);
  assert.equal(owner.dead, false);
});
test('deadline closes owned transport and refuses later operations', async () => {
  let settle;
  let canceled = 0;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  const owner = new OwnedCdp(1, async () => {
    canceled++;
    settle('late');
  });
  await assert.rejects(
    owner.run('fixture', () => pending, 5),
    /INCOMPLETE_HARNESS_CDP/,
  );
  assert.equal(canceled, 1);
  await assert.rejects(
    owner.run('stale', async () => 42),
    /already disconnected/,
  );
});
test('known killed owner never invokes dead transport cleanup twice', async () => {
  let canceled = 0;
  const owner = new OwnedCdp(1, async () => {
    canceled++;
  });
  await owner.kill();
  await owner.kill();
  assert.equal(canceled, 1);
  await assert.rejects(
    owner.run('detach', () => {
      throw new Error('must not invoke');
    }),
    /already disconnected/,
  );
});
test('failed transport cleanup reports incomplete instead of accepting late completion', async () => {
  const owner = new OwnedCdp(1, async () => {
    throw new Error('fixture cleanup refused');
  });
  await assert.rejects(
    owner.run('fixture', () => new Promise(() => {}), 5),
    /cleanup unconfirmed/,
  );
});
test('requires explicit process ownership terminator', () => {
  assert.throws(() => new OwnedCdp(1), /Explicit owned terminator/);
});
test('transport rejection after deadline waits for deferred cleanup confirmation', async () => {
  let rejectTransport, finishCleanup;
  const transport = new Promise((_, reject) => {
    rejectTransport = reject;
  });
  const cleanup = new Promise((resolve) => {
    finishCleanup = resolve;
  });
  const owner = new OwnedCdp(1, () => {
    rejectTransport(new Error('raw transport disconnected'));
    return cleanup;
  });
  let settled = false;
  const operation = owner.run('fixture', () => transport, 5);
  operation
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  finishCleanup();
  await assert.rejects(operation, /INCOMPLETE_HARNESS_CDP.*owned transport closed/);
  assert.equal(owner.terminationConfirmed, true);
});
test('synchronous cleanup throw masks raw transport error with incomplete receipt', async () => {
  let rejectTransport;
  const transport = new Promise((_, reject) => {
    rejectTransport = reject;
  });
  const owner = new OwnedCdp(1, () => {
    rejectTransport(new Error('raw transport disconnected'));
    throw new Error('synchronous fixture refusal');
  });
  await assert.rejects(
    owner.run('fixture', () => transport, 5),
    /INCOMPLETE_HARNESS_CDP.*cleanup unconfirmed/,
  );
  assert.equal(owner.terminationConfirmed, false);
});
