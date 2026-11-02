// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { releaseBrowserLogPipesAfterExit } from './browser-process-exit';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Real processes model a browser exiting while its reporting child retains
 * inherited log handles. All processes exit naturally; no kill or new timeout
 * replaces the fixture's graceful close.
 */
async function inheritedPipes(code: number, inheritControl = false, exitDelay = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'genx-owned-browser-exit-'));
  const done = join(directory, 'holder-finished');
  const holder = `setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],String(process.pid)),3000);`;
  const script = `
    const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(holder)},${JSON.stringify(done)}],
      {stdio:${JSON.stringify(inheritControl ? ['ignore', 1, 2, 3, 4] : ['ignore', 1, 2])},windowsHide:true,detached:true});
    child.unref();
    process.send({pid:child.pid},()=>setTimeout(()=>process.exit(${code}),${exitDelay}));
  `;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const output: string[] = [];
  child.stderr?.on('data', (bytes: Buffer) => output.push(bytes.toString()));
  child.stdout?.resume();
  child.stderr?.resume();
  for (const pipe of [child.stdio[3], child.stdio[4]]) if (pipe && 'resume' in pipe) pipe.resume();
  const holderPid = new Promise<number>((yes, no) => {
    child.once('error', no);
    child.once('message', (value) => {
      const pid = (value as { pid?: unknown }).pid;
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
        no(new Error('Invalid owned holder identity.'));
      else yes(pid);
    });
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((yes, no) => {
    child.once('error', no);
    child.once('exit', (code, signal) => yes({ code, signal }));
  });
  let didClose = false;
  const closed = new Promise<void>((yes) => {
    child.once('close', () => {
      didClose = true;
      yes();
    });
  });
  const controlsClosed = Promise.all(
    [child.stdio[3], child.stdio[4]].map(
      (pipe) => new Promise<void>((yes) => (pipe?.closed ? yes() : pipe?.once('close', yes))),
    ),
  );
  return {
    child,
    holderPid,
    exited,
    closed,
    controlsClosed,
    get didClose() {
      return didClose;
    },
    async drain() {
      const pid = await holderPid;
      try {
        await vi.waitFor(async () => expect(await readFile(done, 'utf8')).toBe(String(pid)), {
          timeout: 5000,
        });
      } catch (error) {
        throw new Error(`Owned holder did not finish: ${output.join('')}`, { cause: error });
      }
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 });
      await closed;
      // This directory was created by this fixture; verify its exact boundary
      // before recursively removing only these owned completion markers.
      const target = resolve(directory);
      if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('genx-owned-browser-exit-')
      )
        throw new Error('Owned process fixture directory changed.');
      await rm(target, { recursive: true, force: true });
    },
  };
}

it('releases inherited browser log pipes only after graceful exit and explicit owner drain', async () => {
  const fixture = await inheritedPipes(0);
  const owner = releaseBrowserLogPipesAfterExit(fixture.child);
  try {
    const pid = await fixture.holderPid;
    expect(await fixture.exited).toEqual({ code: 0, signal: null });
    await fixture.controlsClosed;
    expect(fixture.didClose).toBe(false);
    expect(fixture.child.stdout?.destroyed).toBe(false);
    expect(fixture.child.stderr?.destroyed).toBe(false);
    expect(owner.released).toBe(false);
    owner.arm();
    await fixture.closed;
    expect(owner.released).toBe(true);
    expect(fixture.child.exitCode).toBe(0);
    expect(alive(pid)).toBe(true);
  } finally {
    owner.dispose();
    await fixture.drain();
  }
});

it('never releases log pipes before process exit or converts a failed process exit to success', async () => {
  const fixture = await inheritedPipes(9, false, 500);
  const owner = releaseBrowserLogPipesAfterExit(fixture.child);
  try {
    await fixture.holderPid;
    owner.arm();
    expect(fixture.child.exitCode).toBeNull();
    expect(owner.released).toBe(false);
    expect(fixture.child.stdout?.destroyed).toBe(false);
    expect(await fixture.exited).toEqual({ code: 9, signal: null });
    await fixture.controlsClosed;
    expect(owner.released).toBe(false);
    expect(fixture.didClose).toBe(false);
    expect(fixture.child.stdout?.destroyed).toBe(false);
  } finally {
    owner.dispose();
    await fixture.drain();
  }
  expect(fixture.child.exitCode).toBe(9);
});

it('keeps log pipes while an inherited browser control pipe remains open after parent exit', async () => {
  const fixture = await inheritedPipes(0, true);
  const owner = releaseBrowserLogPipesAfterExit(fixture.child);
  try {
    await fixture.holderPid;
    expect(await fixture.exited).toEqual({ code: 0, signal: null });
    owner.arm();
    expect(fixture.child.stdio[3]?.closed).toBe(false);
    expect(fixture.child.stdio[4]?.closed).toBe(false);
    expect(owner.released).toBe(false);
    expect(fixture.child.stdout?.destroyed).toBe(false);
  } finally {
    await fixture.drain();
    owner.dispose();
  }
});
