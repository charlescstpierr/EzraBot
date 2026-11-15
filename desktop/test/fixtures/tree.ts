// A runtime that grows a process tree on demand. Each process it creates is reported, with its start
// time, to the report file before anything waits on it, so a test knows every identity it must find gone.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, readdirSync, readFileSync, readlinkSync, writeSync } from 'node:fs';

const [scenario = 'serve', report = '/dev/null'] = process.argv.slice(2);

const startOf = (pid: number) => {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return text.slice(text.lastIndexOf(')') + 2).split(' ')[19] ?? '';
};
const note = (role: string, pid: number) => appendFileSync(report, JSON.stringify({ role, pid, start: startOf(pid) }) + '\n');
const sleeper = (extra = '') => spawn(process.execPath, ['-e', `${extra};setInterval(() => {}, 1e9)`], { stdio: 'ignore' });

function doubleFork(): void {
  const code = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { detached: true, stdio: 'ignore' });
require('node:fs').writeSync(1, String(c.pid)); process.exit(0);`;
  const mid = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  mid.stdout.on('data', chunk => { out += chunk; });
  mid.on('exit', () => note('daemon', Number(out)));
}

note('runtime', process.pid);
appendFileSync(report, JSON.stringify({ role: 'fds', fds: readdirSync('/proc/self/fd').map(fd => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return ''; } }) }) + '\n');
try {
  writeSync(3, JSON.stringify({ kind: 'ready', pid: process.pid }) + '\n');
  closeSync(3);
} catch { /* no ready channel given */ }

if (scenario === 'ignore-term') process.on('SIGTERM', () => {});
else if (scenario === 'birth-on-term') process.on('SIGTERM', () => { const late = sleeper(); note('born-on-term', late.pid ?? 0); setTimeout(() => process.exit(0), 50); });
else process.on('SIGTERM', () => process.exit(0));

if (scenario === 'late' || scenario === 'crash') {
  const worker = sleeper();
  note('worker', worker.pid ?? 0);
  doubleFork();
  setTimeout(() => {
    const late = sleeper();
    note('late', late.pid ?? 0);
    if (scenario === 'crash') setTimeout(() => process.exit(3), 100);
  }, 300);
}
setInterval(() => {}, 1e9);
