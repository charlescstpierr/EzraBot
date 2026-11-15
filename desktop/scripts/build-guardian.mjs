import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(`${here}/dist`, { recursive: true });
for (const [source, binary] of [['guardian.c', 'ezrabot-guardian'], ['codex-exec.c', 'ezrabot-codex']]) {
  execFileSync(process.env.CC ?? 'cc', [
    '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong', '-fPIE', '-pie',
    '-Wl,-z,relro,-z,now', '-o', `${here}/dist/${binary}`, `${here}/guardian/${source}`,
  ], { stdio: 'inherit' });
}
