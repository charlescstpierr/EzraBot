import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Real Codex, no model call, throwaway folder. Usage: node tools/verify-stop-real.mjs <build root>
 * With `--relay <codex>`, this file instead sits between Mino and `codex app-server` and answers every
 * `sh` command/exec, after 800 ms, with an unreadable result, while Codex keeps running the command.
 */
if (process.argv[2] === '--relay') {
  const codex = spawn(process.argv[3], process.argv.slice(4), { stdio: ['pipe', 'pipe', 'inherit'] });
  const execIds = new Set();
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'command/exec' && message.params.command[0] === 'sh') {
      execIds.add(message.id);
      setTimeout(() => process.stdout.write(JSON.stringify({ id: message.id, result: { unreadable: true } }) + '\n'), 800);
    }
    codex.stdin.write(line + '\n');
  }).on('close', () => codex.stdin.end());
  createInterface({ input: codex.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id !== undefined && message.method === undefined && execIds.has(message.id)) return;
    process.stdout.write(line + '\n');
  });
  codex.on('exit', code => process.exit(code ?? 1));
} else {
  const build = resolve(process.argv[2] ?? '.');
  const codexBin = process.env.MINO_CODEX_BIN ?? 'codex';
  const { createAgentEngine } = await import(join(build, 'dist/src/agent-engine.js'));
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mino-stop-real-')));
  const project = join(base, 'project');
  mkdirSync(project);
  const signal = new AbortController().signal;
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const result = { build, codex: execFileSync(codexBin, ['--version'], { encoding: 'utf8' }).trim(), steps: [] };
  const engines = [];
  try {
    const plain = createAgentEngine({ command: codexBin, tmpDir: join(base, 'tmp-plain'), clientVersion: 'verify-stop' });
    engines.push(plain);
    await plain.catalog();
    const idle = await plain.exec({ cwd: project, argv: ['true'], sandbox: 'read-only', signal });
    result.steps.push({ step: 'idle Codex answers a command', outcome: idle.kind });

    const stopMark = join(project, 'late-stop.txt');
    const stopper = new AbortController();
    const pending = plain.exec({ cwd: project, argv: ['sh', '-c', `sleep 3; touch '${stopMark}'`], sandbox: 'workspace-write', signal: stopper.signal });
    await pause(800);
    const t0 = Date.now();
    stopper.abort();
    const stopped = await pending;
    const stopMs = Date.now() - t0;
    await pause(3500);
    result.steps.push({ step: 'stop of a running check', outcome: stopped.kind, message: stopped.message ?? null, answeredMs: stopMs, lateFileWritten: existsSync(stopMark) });
    const after = await plain.exec({ cwd: project, argv: ['true'], sandbox: 'read-only', signal });
    result.steps.push({ step: 'next command after the stop', outcome: after.kind });

    const relayed = createAgentEngine({ command: process.execPath, args: [fileURLToPath(import.meta.url), '--relay', codexBin], tmpDir: join(base, 'tmp-relay'), clientVersion: 'verify-stop' });
    engines.push(relayed);
    const lostMark = join(project, 'late-lost.txt');
    const t1 = Date.now();
    const lost = await relayed.exec({ cwd: project, argv: ['sh', '-c', `sleep 3; touch '${lostMark}'`], sandbox: 'workspace-write', signal });
    const lostMs = Date.now() - t1;
    await pause(3500);
    result.steps.push({ step: 'unreadable answer, no stop asked', outcome: lost.kind, message: lost.message ?? null, answeredMs: lostMs, lateFileWritten: existsSync(lostMark) });
    const next = await relayed.exec({ cwd: project, argv: ['true'], sandbox: 'read-only', signal });
    result.steps.push({ step: 'next command after the ambiguous close', outcome: next.kind });
  } finally {
    for (const engine of engines) await engine.close();
    rmSync(base, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
