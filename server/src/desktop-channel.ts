import { closeSync, writeSync } from 'node:fs';

/** The descriptor on which the desktop application waits for this very process to say it serves. */
const READY_FD = 3;

export class DesktopChannelError extends Error {
  constructor() {
    super('MINO_DESKTOP_GENERATION est invalide. Lancez EzraBot depuis son application de bureau.');
  }
}

/**
 * Removes the variables that only concern this process, so no engine inherits them: the Electron runtime
 * switch, and the launch generation of the desktop application. Null outside the desktop application.
 */
export function takeDesktopChannel(env: NodeJS.ProcessEnv): string | null {
  const generation = env.MINO_DESKTOP_GENERATION;
  delete env.MINO_DESKTOP_GENERATION;
  delete env.ELECTRON_RUN_AS_NODE;
  if (generation === undefined) return null;
  if (!/^[0-9a-f]{32}$/.test(generation)) throw new DesktopChannelError();
  return generation;
}

/** Written once, after the port is bound and the stores recovered; then the descriptor is closed so no child inherits it. */
export function announceReady(generation: string, ready: { url: string; dataDir: string }, fd = READY_FD): void {
  try {
    writeSync(fd, JSON.stringify({ kind: 'ready', generation, pid: process.pid, ...ready }) + '\n');
  } finally {
    closeSync(fd);
  }
}
