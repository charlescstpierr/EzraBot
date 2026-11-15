import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type Identity = { pid: number; start: string };

export type BackendSpec = {
  guardian: string;
  runtime: string;
  serverEntry: string;
  lifecycleDir: string;
  dataDir: string;
  origin: string;
  generation: string;
  env: Record<string, string>;
  log: number;
  afterUnconfirmed: boolean;
  startupMs?: number;
  stopTimings?: { coopMs: number; termMs: number; killMs: number };
};

/** How a launch ended before or at readiness. Only `serving` lets the window load the origin. */
export type Start =
  | { kind: 'serving'; origin: string; server: Identity }
  | { kind: 'refused'; reason: 'busy' | 'previous-unconfirmed' | 'guardian-error' }
  | { kind: 'failed'; reason: 'exited' | 'timeout' | 'stopped' | 'channel' };

/** `clean` only when the guardian itself wrote that its tree is empty. */
export type End = { cleanup: 'clean' | 'unconfirmed'; left: Identity[]; code: number | null; signal: number | null };

export type OwnedBackend = {
  readonly started: Promise<Start>;
  readonly ended: Promise<End>;
  stop(): Promise<End>;
};

type GuardianEvent =
  | { event: 'spawned'; guardian: number; guardianStart: string; pid: number; start: string }
  | { event: 'exited'; pid: number; code: number; signal: number }
  | { event: 'cleanup'; result: 'clean' | 'unconfirmed'; left: Identity[]; runtimeCode: number; runtimeSignal: number }
  | { event: 'busy' } | { event: 'previous-unconfirmed' } | { event: 'error'; step: string }
  | { event: 'stopping' | 'receipt-error' };

type Ready = { kind: 'ready'; generation: string; pid: number; url: string; dataDir: string };

function parseReady(line: string): Ready | null {
  try {
    const value = JSON.parse(line) as Partial<Ready>;
    return value.kind === 'ready' && typeof value.generation === 'string' && typeof value.pid === 'number'
      && typeof value.url === 'string' && typeof value.dataDir === 'string' ? value as Ready : null;
  } catch {
    return null;
  }
}

/**
 * Starts the server under its guardian. Readiness counts only when it comes through the private
 * descriptor of the process the guardian reports it started, with this launch's generation, address and data.
 */
export function launchOwnedBackend(spec: BackendSpec): OwnedBackend {
  const timings = spec.stopTimings;
  const child = spawn(spec.guardian, [
    '--lock', join(spec.lifecycleDir, 'guardian.lock'), '--receipt', join(spec.lifecycleDir, 'guardian.receipt'),
    ...(spec.afterUnconfirmed ? ['--after-unconfirmed'] : []),
    ...(timings ? ['--coop-ms', String(timings.coopMs), '--term-ms', String(timings.termMs), '--kill-ms', String(timings.killMs)] : []),
    '--', spec.runtime, spec.serverEntry,
  ], { env: spec.env, cwd: spec.dataDir, stdio: ['pipe', 'pipe', spec.log, 'pipe'] });
  const control = child.stdin!;
  const events = child.stdout!;
  control.on('error', () => {});

  let settleStart!: (start: Start) => void;
  let settleEnd!: (end: End) => void;
  let startSettled = false;
  const started = new Promise<Start>(resolve => { settleStart = start => { if (!startSettled) { startSettled = true; resolve(start); } }; });
  const ended = new Promise<End>(resolve => { settleEnd = resolve; });
  let spawned: Identity | null = null;
  let stopRequested = false;

  const stop = () => {
    if (!stopRequested) {
      stopRequested = true;
      settleStart({ kind: 'failed', reason: 'stopped' });
      control.end('stop\n');
    }
    return ended;
  };

  const timer = setTimeout(() => { if (!startSettled) { settleStart({ kind: 'failed', reason: 'timeout' }); void stop(); } }, spec.startupMs ?? 30_000);
  void started.then(() => clearTimeout(timer));

  createInterface({ input: events }).on('line', line => {
    let event: GuardianEvent;
    try { event = JSON.parse(line) as GuardianEvent; } catch { return; }
    switch (event.event) {
      case 'spawned': spawned = { pid: event.pid, start: event.start }; check(); break;
      case 'exited': settleStart({ kind: 'failed', reason: 'exited' }); break;
      case 'busy': settleStart({ kind: 'refused', reason: 'busy' }); break;
      case 'previous-unconfirmed': settleStart({ kind: 'refused', reason: 'previous-unconfirmed' }); break;
      case 'error': settleStart({ kind: 'refused', reason: 'guardian-error' }); break;
      case 'cleanup': settleEnd({ cleanup: event.result, left: event.left, code: event.runtimeCode < 0 ? null : event.runtimeCode, signal: event.runtimeSignal || null }); break;
    }
  });

  let readyLine: string | null = null;
  function check(): void {
    if (readyLine === null || !spawned) return;
    const ready = parseReady(readyLine);
    if (!ready || ready.pid !== spawned.pid || ready.generation !== spec.generation || ready.url !== spec.origin || ready.dataDir !== spec.dataDir) {
      settleStart({ kind: 'failed', reason: 'channel' });
      void stop();
    } else if (!stopRequested) settleStart({ kind: 'serving', origin: ready.url, server: spawned });
  }
  const readyPipe = child.stdio[3] as NodeJS.ReadableStream;
  createInterface({ input: readyPipe }).once('line', line => { readyLine = line; check(); });
  readyPipe.on('error', () => {});

  const drained = new Promise<void>(resolve => events.on('end', resolve));
  child.on('exit', () => {
    void drained.then(() => {
      settleStart({ kind: 'refused', reason: 'guardian-error' });
      settleEnd({ cleanup: 'unconfirmed', left: spawned ? [spawned] : [], code: null, signal: null });
    });
  });
  return { started, ended, stop };
}

export type Receipt = { state: string; guardian: Identity | null; owned: Identity[] };

/** The guardian's last word about the previous launch; absent before the first one. */
export function readReceipt(lifecycleDir: string): Receipt | null {
  let text: string;
  try { text = readFileSync(join(lifecycleDir, 'guardian.receipt'), 'utf8'); } catch { return null; }
  const receipt: Receipt = { state: 'unreadable', guardian: null, owned: [] };
  const lines = text.split('\n');
  if (lines[0] !== 'ezrabot-guardian-receipt 1') return receipt;
  for (const line of lines.slice(1)) {
    const [key, a, b] = line.split(' ');
    if (key === 'state' && a) receipt.state = a;
    else if ((key === 'guardian' || key === 'owned') && a && b) {
      const id = { pid: Number(a), start: b };
      if (key === 'guardian') receipt.guardian = id; else receipt.owned.push(id);
    }
  }
  return receipt;
}
