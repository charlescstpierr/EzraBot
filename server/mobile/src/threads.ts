import type { MobileBot, MobileSnapshot } from './generated/mobile-protocol';
import type { MissionStatus, MissionSummary, ProjectView } from './generated/agent-protocol';

type WorkState = MobileSnapshot['works'][number]['state'];
export type ThreadFilter = 'all' | 'attention' | 'working' | 'done';
export type ThreadStatus = {
  state: WorkState | MissionStatus | 'idle';
  label: string;
  group: Exclude<ThreadFilter, 'all'> | 'quiet';
};
export type ThreadParticipant = { id: string; name: string };
type CommonRow = {
  key: string;
  title: string;
  updatedAt: string | null;
  status: ThreadStatus;
};
export type ConversationRow = CommonRow & {
  kind: 'conversation';
  botId: string;
  bot: Pick<MobileBot, 'id' | 'name' | 'shape' | 'color'>;
  primary: boolean;
  project: null;
  preview: string | null;
  participants: ThreadParticipant[];
};
export type MissionRow = CommonRow & {
  kind: 'mission';
  missionId: string;
  projectId: string;
  goalRev: number;
  project: Pick<ProjectView, 'id' | 'name'> | null;
  projectLabel: string;
  preview: null;
  participants: null;
};
export type ThreadRow = ConversationRow | MissionRow;
export type ThreadSnapshot = {
  bots: Pick<MobileBot, 'id' | 'name' | 'shape' | 'color'>[];
  messages: Pick<MobileSnapshot['messages'][number], 'id' | 'threadBotId' | 'botId' | 'role' | 'text' | 'createdAt'>[];
  works: Pick<MobileSnapshot['works'][number], 'id' | 'threadBotId' | 'state' | 'updatedAt'>[];
};
export type ThreadAgents = {
  projects: Pick<ProjectView, 'id' | 'name'>[];
  missions: Pick<MissionSummary, 'id' | 'projectId' | 'goalRev' | 'title' | 'status' | 'updatedAt'>[];
};

const conversationStatus: Record<WorkState, Omit<ThreadStatus, 'state'>> = {
  review: { label: 'Votre avis attendu', group: 'attention' },
  running: { label: 'Travail en cours', group: 'working' },
  pending: { label: 'En attente', group: 'working' },
  failed: { label: 'Échoué', group: 'attention' },
  cancelled: { label: 'Annulé', group: 'quiet' },
  done: { label: 'Terminé', group: 'done' },
};
const workPriority: WorkState[] = ['review', 'running', 'pending'];
const missionStatus: Record<MissionStatus, Omit<ThreadStatus, 'state'>> = {
  queued: { label: 'En attente', group: 'working' },
  running: { label: 'Travail en cours', group: 'working' },
  stopping: { label: 'Arrêt demandé', group: 'working' },
  review: { label: 'Votre avis attendu', group: 'attention' },
  outdated: { label: 'Objectif modifié', group: 'attention' },
  accepted: { label: 'Validée', group: 'done' },
  failed: { label: 'Échoué', group: 'attention' },
  stopped: { label: 'Arrêtée', group: 'quiet' },
  interrupted: { label: 'Résultat inconnu', group: 'attention' },
  waiting: { label: 'Décision requise', group: 'attention' },
};
const timestamp = (value: string | null) => value === null ? 0 : Date.parse(value) || 0;
const normalized = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr').trim();

export function projectThreads(snapshot: ThreadSnapshot, agents: ThreadAgents | null = null): ThreadRow[] {
  const bots = new Map(snapshot.bots.map(bot => [bot.id, bot]));
  const conversations: ConversationRow[] = snapshot.bots.map(bot => {
    const messages = snapshot.messages.filter(message => message.threadBotId === bot.id);
    const works = snapshot.works.filter(work => work.threadBotId === bot.id);
    const newest = [...messages].sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt)).at(-1);
    const dates = [...messages.map(message => message.createdAt), ...works.map(work => work.updatedAt)];
    const updatedAt = dates.sort((a, b) => timestamp(b) - timestamp(a))[0] ?? null;
    const participants = new Map<string, ThreadParticipant>([[bot.id, { id: bot.id, name: bot.name }]]);
    for (const message of messages) {
      if (message.role !== 'assistant' || participants.has(message.botId)) continue;
      participants.set(message.botId, { id: message.botId, name: bots.get(message.botId)?.name ?? 'Bot supprimé' });
    }
    const state = workPriority.find(state => works.some(work => work.state === state))
      ?? [...works].sort((a, b) => timestamp(a.updatedAt) - timestamp(b.updatedAt)).at(-1)?.state;
    return {
      kind: 'conversation', key: `conversation:${bot.id}`, botId: bot.id,
      bot: { id: bot.id, name: bot.name, shape: bot.shape, color: bot.color },
      title: bot.name, primary: bot.id === 'mino', project: null,
      preview: newest?.text.replace(/\s+/gu, ' ').trim() || null,
      updatedAt, participants: [...participants.values()],
      status: state ? { state, ...conversationStatus[state] } : { state: 'idle', label: 'Aucun travail', group: 'quiet' },
    };
  });
  const projects = new Map(agents?.projects.map(project => [project.id, project]) ?? []);
  const missions: MissionRow[] = agents?.missions.map(mission => {
    const project = projects.get(mission.projectId);
    return {
      kind: 'mission', key: `mission:${mission.id}`, missionId: mission.id, projectId: mission.projectId,
      goalRev: mission.goalRev, title: mission.title, updatedAt: mission.updatedAt,
      project: project ? { id: project.id, name: project.name } : null,
      projectLabel: project?.name ?? 'Projet indisponible',
      preview: null, participants: null,
      status: { state: mission.status, ...missionStatus[mission.status] },
    };
  }) ?? [];
  return [...conversations, ...missions].sort((a, b) => {
    const primaryA = a.kind === 'conversation' && a.primary;
    const primaryB = b.kind === 'conversation' && b.primary;
    return Number(primaryB) - Number(primaryA) || timestamp(b.updatedAt) - timestamp(a.updatedAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}

export function filterThreads(rows: readonly ThreadRow[], query: string, filter: ThreadFilter = 'all'): ThreadRow[] {
  const needle = normalized(query);
  return rows.filter(row => {
    if (filter !== 'all' && row.status.group !== filter) return false;
    const searchable = row.kind === 'conversation'
      ? [row.title, row.preview ?? '', ...row.participants.map(person => person.name)]
      : [row.title, row.projectLabel];
    return !needle || searchable.some(text => normalized(text).includes(needle));
  });
}
