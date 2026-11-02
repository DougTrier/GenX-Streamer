// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from 'node:child_process';

/** Windows Crashpad can inherit browser log pipes after the browser exits.
 * Arm only after all page/context/native owners have actually drained. This
 * closes no process or control pipe and never treats a failed exit as success.
 */
export function releaseBrowserLogPipesAfterExit(process: ChildProcess) {
  let armed = false;
  let released = false;
  const controlPipes = [process.stdio[3], process.stdio[4]];
  const closed = controlPipes.map((pipe) => !!pipe && pipe.closed);
  const release = () => {
    if (
      !armed ||
      released ||
      process.exitCode !== 0 ||
      process.signalCode !== null ||
      process.stdio.length < 5 ||
      !closed.every(Boolean)
    )
      return;
    released = true;
    process.stdout?.destroy();
    process.stderr?.destroy();
  };
  const listeners = controlPipes.map((pipe, index) => {
    const listener = () => {
      closed[index] = true;
      release();
    };
    pipe?.once('close', listener);
    return listener;
  });
  process.on('exit', release);
  return {
    arm() {
      armed = true;
      release();
    },
    get released() {
      return released;
    },
    dispose() {
      process.off('exit', release);
      controlPipes.forEach((pipe, index) => pipe?.off('close', listeners[index]!));
    },
  };
}
