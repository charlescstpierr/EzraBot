import type { Missions } from './missions.js';

const excerpt = (text: string | null | undefined, limit: number) => text && text.length > limit ? text.slice(0, limit) + '… [extrait]' : text ?? null;

/** Read at claim time, before composing and hashing Mino's exact model input. No registered project directories or raw command output are added. */
export function buildMissionChatContext(missions: Pick<Missions, 'view' | 'detail'>) {
  try {
    const view = missions.view();
    const roots = view.missions.filter(m => m.parentId === null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const recent = roots.slice(0, 3).map(m => {
      const detail = missions.detail(m.id);
      if (!detail) throw new Error('Mission absente');
      const last = detail.attempts.at(-1);
      return {
        id: m.id, originMessageId: m.originMessageId, project: excerpt(view.projects.find(p => p.id === m.projectId)?.name, 100),
        title: excerpt(m.title, 160), status: detail.status, goalRevision: detail.goalRev,
        goal: excerpt(detail.goals.at(-1)?.text, 600), updatedAt: m.updatedAt,
        waiting: excerpt(detail.waiting, 300), budget: detail.tree ?? { used: detail.attemptsUsed, max: detail.maxAttempts },
        acceptBlocked: excerpt(detail.acceptBlocked, 400),
        steps: detail.children.map(c => ({ id: c.id, title: excerpt(c.title, 120), status: c.status })).slice(-6),
        lastAttempt: last ? {
          kind: last.kind, state: last.state, goalRevision: last.goalRev, error: excerpt(last.errorMessage, 300),
          report: excerpt(last.finalText, 800),
          check: last.check ? { command: last.check.command, exitCode: last.check.exitCode, error: excerpt(last.check.error, 200) } : null,
        } : null,
        allowed: Object.entries(detail.can).filter(([, allowed]) => Boolean(allowed)).map(([action]) => action),
      };
    });
    const projects = view.projects.filter(p => !p.archived);
    return {
      state: 'available' as const, observedAt: new Date().toISOString(),
      projects: projects.slice(0, 8).map(p => ({ id: p.id, name: excerpt(p.name, 100) })), projectsOmitted: Math.max(0, projects.length - 8),
      omitted: Math.max(0, roots.length - recent.length), missions: recent,
    };
  } catch {
    return { state: 'unavailable' as const };
  }
}

export type MissionChatContext = ReturnType<typeof buildMissionChatContext>;
