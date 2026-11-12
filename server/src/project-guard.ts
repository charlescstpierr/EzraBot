import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { AGENT_LIMITS, type ObservedView } from './agent-protocol.js';
import { clip, type ExecOutcome } from './agent-engine.js';

export type PathVerdict = { ok: true; path: string; git: boolean } | { ok: false; message: string };

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * A project folder is where an executor may write. It must be an existing, writable, real directory
 * that holds neither Mino itself, its data, the Codex account, nor private configuration.
 */
export function checkProjectPath(input: string, guarded: { minoRoot: string; dataDir: string; home?: string }): PathVerdict {
  const home = guarded.home ?? homedir();
  if (!isAbsolute(input)) return { ok: false, message: 'Indiquez le chemin complet du dossier, par exemple /home/vous/projets/site.' };
  const wanted = resolve(input);
  let real: string;
  try {
    real = realpathSync(wanted);
  } catch {
    return { ok: false, message: 'Ce dossier n’existe pas sur cet ordinateur.' };
  }
  if (real !== wanted) return { ok: false, message: 'Ce chemin passe par un lien symbolique. Indiquez le dossier réel.' };
  try {
    if (!statSync(real).isDirectory()) return { ok: false, message: 'Ce chemin n’est pas un dossier.' };
    accessSync(real, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    return { ok: false, message: 'Mino ne peut pas lire et écrire dans ce dossier.' };
  }
  if (real === sep || inside(home, real)) return { ok: false, message: 'Choisissez un dossier de projet précis, pas la racine ni votre dossier personnel entier.' };
  const privateRoots = ['.codex', '.ssh', '.gnupg', '.config', '.aws', '.kube', '.docker', join('.local', 'share', 'mino')].map(name => join(home, name));
  if (privateRoots.some(root => inside(real, root) || inside(root, real))) return { ok: false, message: 'Ce dossier contient des réglages ou des accès privés. Mino ne le confie pas à un exécutant.' };
  for (const [root, label] of [[guarded.dataDir, 'les données de Mino'], [guarded.minoRoot, 'l’application Mino en service']] as const) {
    let guardedReal = root;
    try { guardedReal = realpathSync(root); } catch { /* missing: compare as given */ }
    if (inside(real, guardedReal) || inside(guardedReal, real)) {
      return { ok: false, message: `Ce dossier contient ${label}. Pour améliorer Mino, créez une copie de travail séparée (git worktree add ../mino-travail) et ajoutez ce dossier.` };
    }
  }
  return { ok: true, path: real, git: existsSync(join(real, '.git')) };
}

const SHELL_SYNTAX = /[;&|<>`$(){}\\'"*?~!#]/;

/** The check command is an argv run without a shell. */
export function parseCheckCommand(value: string): { ok: true; argv: string[] | null } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, argv: null };
  if (SHELL_SYNTAX.test(trimmed)) return { ok: false, message: 'La commande de contrôle est lancée sans shell : utilisez des mots simples, par exemple « npm test » ou « node --test ».' };
  const argv = trimmed.split(/\s+/);
  if (argv.length > 20) return { ok: false, message: 'La commande de contrôle est trop longue.' };
  return { ok: true, argv };
}

/** Runs git in the project folder. Mino passes a runner that executes inside the read-only Codex sandbox. */
export type GitExec = (argv: string[], env: Record<string, string | null>) => Promise<ExecOutcome>;

/**
 * Repository settings can make git start programs while it only reads: an fsmonitor hook, an external diff
 * or textconv driver, a submodule's own settings. These are switched off here. Filter drivers cannot be named
 * in advance, so the read-only sandbox, without network, is what contains them.
 */
const GIT_SAFE = ['-c', 'core.fsmonitor=false', '--no-optional-locks'];
const GIT_ENV: Record<string, string | null> = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
  GIT_EXTERNAL_DIFF: null, GIT_DIR: null, GIT_WORK_TREE: null, GIT_INDEX_FILE: null, GIT_PAGER: 'cat', PAGER: 'cat',
};

/** What Mino itself sees in the folder, independently of what the executor reports. */
export async function observeProject(path: string, baseline: string[] | null, now: () => string, exec: GitExec): Promise<ObservedView> {
  const at = now();
  if (!existsSync(join(path, '.git'))) {
    return { git: false, head: null, status: [], diffStat: '', at, error: 'Ce dossier n’est pas un dépôt git : Mino ne peut pas lister les fichiers changés.', changedDuringAttempt: [] };
  }
  const git = async (args: string[]) => {
    const outcome = await exec(['git', ...GIT_SAFE, ...args], GIT_ENV);
    return outcome.kind === 'exited' && outcome.exitCode === 0 ? { ok: true, out: outcome.stdout, cut: false } : { ok: false, out: '', cut: outcome.kind === 'cancelled' };
  };
  const [status, head, diff] = await Promise.all([
    git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all']),
    git(['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(['diff', '--stat', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', 'HEAD']),
  ]);
  if (status.cut) return { git: true, head: null, status: [], diffStat: '', at, error: 'Constat arrêté avant sa fin.', changedDuringAttempt: [] };
  if (!status.ok) return { git: true, head: null, status: [], diffStat: '', at, error: 'git status a échoué dans ce dossier, lancé par Mino dans le bac à sable en lecture seule.', changedDuringAttempt: [] };
  const lines = status.out.split('\n').filter(Boolean).slice(0, 500);
  const before = new Set(baseline ?? []);
  return {
    git: true,
    head: head.ok ? head.out.trim() || null : null,
    status: lines,
    diffStat: clip(diff.ok ? diff.out.trim() : '', AGENT_LIMITS.observedChars),
    at,
    error: null,
    changedDuringAttempt: baseline === null ? [] : lines.filter(line => !before.has(line)),
  };
}
