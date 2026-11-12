import { AGENT_LIMITS, type AgentEventView, type AttemptView, type DecisionKind, type DecisionView, type MissionDetail, type MissionStatus, type MissionSummary } from '../generated/agent-protocol';

export const STATUS: Record<MissionStatus, { label: string; tone: 'busy' | 'attention' | 'done' | 'quiet' }> = {
  queued: { label: 'En attente', tone: 'busy' },
  running: { label: 'En cours', tone: 'busy' },
  stopping: { label: 'Arrêt demandé', tone: 'busy' },
  review: { label: 'À examiner', tone: 'attention' },
  outdated: { label: 'Objectif modifié', tone: 'attention' },
  interrupted: { label: 'Résultat inconnu', tone: 'attention' },
  failed: { label: 'Échec', tone: 'attention' },
  stopped: { label: 'Arrêtée', tone: 'quiet' },
  accepted: { label: 'Validée', tone: 'done' },
  waiting: { label: 'Décision requise', tone: 'attention' },
};

const KIND: Record<AttemptView['kind'], string> = { start: 'Premier essai', continue: 'Suite', resume: 'Reprise après vérification', review: 'Relecture', lead: 'Décision du responsable', final: 'Contrôle final de Mino' };
export const attemptTitle = (a: AttemptView) => `Essai ${a.n} · ${KIND[a.kind]}`;

/** What Mino says about the mission, in the voice of the coordinator, never more than what was observed. */
export function minoSays(m: MissionDetail, project: string): string {
  const work = [...m.attempts].reverse().find(a => a.kind !== 'review');
  switch (m.status) {
    case 'queued': return `J’ai confié la mission. L’exécutant commence dès qu’il est libre, dans « ${project} ».`;
    case 'running': return m.attempts.at(-1)?.state === 'verifying'
      ? 'L’exécutant a fini son tour. Je lance le contrôle et je regarde le dossier avant de te montrer le résultat.'
      : `L’exécutant travaille dans « ${project} ». Je note tout ce qu’il fait.`;
    case 'stopping': return 'J’ai demandé l’arrêt. J’attends que Codex le confirme.';
    case 'review': if (m.acceptBlocked) return m.acceptBlocked;
      return work?.check
      ? work.check.exitCode === 0 ? 'C’est terminé et le contrôle passe. Regarde les changements avant de valider.' : 'C’est terminé, mais le contrôle échoue. Tu peux demander une suite.'
      : 'C’est terminé. Regarde ce qui a changé avant de valider.';
    case 'outdated': return `Tu as changé l’objectif. Ce résultat répond à la version ${work?.goalRev ?? '?'}, pas à la version ${m.goalRev}.`;
    case 'interrupted': return 'Le travail s’est arrêté sans confirmation. Des fichiers ont pu changer : vérifie ce que j’ai constaté avant de reprendre.';
    case 'failed': return 'L’essai a échoué. Le détail est ci-dessous.';
    case 'stopped': return 'Arrêt confirmé. Ce qui était déjà fait reste dans le dossier.';
    case 'accepted': return 'Tu as validé ce résultat.';
    case 'waiting': return m.waiting ?? 'Le responsable attend ta décision.';
  }
}

export type Line = { key: string; icon: string; text: string; detail?: string; mono?: boolean; strong?: boolean };

/** One readable line per recorded event. A command seen starting but never ending stays visibly unfinished. */
export function lines(events: AgentEventView[], attemptId: string, ended: boolean): Line[] {
  const own = events.filter(e => e.attemptId === attemptId);
  const finished = new Set(own.filter(e => e.kind === 'command').map(e => String(e.data.itemId)));
  const out: Line[] = [];
  for (const e of own) {
    const d = e.data;
    const command = typeof d.command === 'string' ? d.command.replace(/^\/bin\/(?:ba)?sh -lc ['"]?|['"]$/g, '') : '';
    switch (e.kind) {
      case 'agent_message': out.push({ key: e.id, icon: '', text: plain(String(d.text ?? '')) }); break;
      case 'command_started':
        if (!finished.has(String(d.itemId))) out.push({ key: e.id, icon: ended ? '?' : '…', text: command, detail: ended ? 'Commencée, fin non observée' : 'En cours', mono: true });
        break;
      case 'command': {
        const ok = d.exitCode === 0;
        out.push({ key: e.id, icon: ok ? '✓' : d.status === 'declined' ? '⊘' : '✗', text: command, detail: ok ? undefined : d.exitCode === null ? 'Refusée' : `Code ${String(d.exitCode)}`, mono: true });
        break;
      }
      case 'file_change': {
        const changes = Array.isArray(d.changes) ? d.changes as { path: string; kind: string }[] : [];
        for (const [i, c] of changes.entries()) out.push({ key: `${e.id}-${i}`, icon: c.kind === 'add' ? '+' : c.kind === 'delete' ? '−' : '✎', text: c.path.split('/').slice(-2).join('/'), mono: true });
        break;
      }
      case 'plan': out.push({ key: e.id, icon: '☰', text: String(d.text ?? '') }); break;
      case 'approval_declined': out.push({ key: e.id, icon: '⊘', text: 'Autorisation refusée par Mino', detail: typeof d.command === 'string' ? d.command : undefined, strong: true }); break;
      case 'blocked_tool': out.push({ key: e.id, icon: '⊘', text: 'Outil non autorisé, tour arrêté', strong: true }); break;
      case 'error': out.push({ key: e.id, icon: '!', text: String(d.message ?? 'Erreur'), detail: d.willRetry ? 'Codex réessaie' : undefined }); break;
      case 'stop_requested': out.push({ key: e.id, icon: '■', text: 'Arrêt demandé' }); break;
      default: break;
    }
  }
  return out;
}

export const latestWork = (m: MissionDetail) => [...m.attempts].reverse().find(a => a.kind !== 'review');
export const latestReview = (m: MissionDetail) => { const last = m.attempts.at(-1); return last?.kind === 'review' ? last : undefined; };

export function tokens(a: AttemptView): string {
  return a.usage ? `${a.usage.total.toLocaleString('fr-FR')} jetons` : 'Consommation non fournie';
}

export function group(missions: MissionSummary[]): { title: string; items: MissionSummary[] }[] {
  const attention = missions.filter(m => STATUS[m.status].tone === 'attention');
  const busy = missions.filter(m => STATUS[m.status].tone === 'busy');
  const rest = missions.filter(m => STATUS[m.status].tone === 'done' || STATUS[m.status].tone === 'quiet');
  return [{ title: 'À regarder', items: attention }, { title: 'En cours', items: busy }, { title: 'Terminées', items: rest }].filter(g => g.items.length);
}

/** Executor reports are Markdown; the thread shows them as plain readable text without inventing formatting. */
export function plain(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ');
}

/** The shared budget of a coordinated tree, with the usage Codex reported and how many attempts did not report it. */
export function budgetLine(m: Pick<MissionDetail, 'tree' | 'tokens'>): string {
  if (!m.tree) return '';
  const missing = m.tokens.unknownAttempts;
  return `${m.tree.used} / ${m.tree.max} essais · ${m.tokens.total.toLocaleString('fr-FR')} jetons${missing ? ` (non fournie pour ${missing} essai${missing > 1 ? 's' : ''})` : ''}`;
}

const DECISION: Record<DecisionKind, string> = {
  delegate: 'Confie une étape', continue: 'Demande une suite', review: 'Demande une relecture', ask: 'Pose une question', finish: 'Propose la synthèse',
};
export const decisionTitle = (d: DecisionView) => `Décision ${d.n} · ${d.kind ? DECISION[d.kind] : 'Illisible'}`;
export const decisionWhy = (d: DecisionView) => typeof d.decision?.why === 'string' ? d.decision.why : null;
export const decisionOutcome = (d: DecisionView) => d.outcome === 'applied' ? 'Appliquée par Mino' : `Refusée par Mino : ${d.refusal ?? ''}`;

export type CoordinationAction = 'accept' | 'stop' | 'continue' | 'resume' | 'revise' | 'budget';
/** The buttons of a coordinated mission, exactly those the PC would admit now. */
export function coordinationActions(m: MissionDetail): { id: CoordinationAction; label: string }[] {
  const out: { id: CoordinationAction; label: string }[] = [];
  if (m.can.accept) out.push({ id: 'accept', label: 'Valider la synthèse' });
  if (m.can.stop) out.push({ id: 'stop', label: 'Arrêter tout' });
  if (m.can.continue) out.push({ id: 'continue', label: 'Préciser au responsable' });
  if (m.can.resume) out.push({ id: 'resume', label: 'Réveiller le responsable' });
  if (m.can.revise && m.status !== 'accepted') out.push({ id: 'revise', label: 'Modifier l’objectif' });
  if (m.can.budget && m.status !== 'accepted' && m.tree && m.tree.used >= m.tree.max) out.push({ id: 'budget', label: `Accorder ${AGENT_LIMITS.coordinatedStep} essais` });
  return out;
}

/** What the lead says about its mission, never more than the registry recorded. */
export function leadSays(m: MissionDetail): string {
  switch (m.status) {
    case 'queued': return 'Je regarde le dossier et je choisis la première étape.';
    case 'running': return m.children.some(c => c.status === 'running' || c.status === 'stopping') ? 'Une étape est en cours chez un exécutant. Je décide la suite quand Mino l’a contrôlée.' : 'Je lis le dossier et je décide la prochaine étape.';
    case 'stopping': return 'Arrêt demandé. J’attends que Codex le confirme pour chaque étape en cours.';
    case 'review': return m.acceptBlocked ?? (m.synthesis?.final?.checkCommand ? 'Synthèse prête. Mino a contrôlé le dossier intégré : regarde les preuves avant de valider.' : 'Synthèse prête. Aucun contrôle n’est configuré pour ce projet : aucun succès de test n’est affirmé.');
    case 'outdated': return `Tu as changé l’objectif. Cette synthèse répond à une version précédente, pas à la version ${m.goalRev}.`;
    case 'waiting': return m.waiting ?? 'J’attends ta décision.';
    case 'interrupted': return 'Arrêté, avec une étape au résultat inconnu. Vérifie ce que Mino a constaté avant de la reprendre.';
    case 'stopped': return 'Arrêté. Ce qui a été fait reste dans le dossier ; rien ne repart sans toi.';
    case 'accepted': return 'Tu as validé la synthèse et les étapes citées.';
    case 'failed': return 'Le travail a échoué.';
  }
}

/** Where « retour » leads: a step goes back to its coordinated mission, anything else to the list. */
export const backTarget = (m: Pick<MissionDetail, 'parent'>): { kind: 'list' } | { kind: 'mission'; id: string } => m.parent ? { kind: 'mission', id: m.parent.id } : { kind: 'list' };

/** A goal draft is kept per Mino proposal, or for a new mission; never mixed with a chat draft. */
export const draftKey = (messageId: string | null) => `mission-draft:${messageId ?? 'new'}`;

export function defaultLead(leads: { id: string }[], remembered: string | null | undefined): string {
  const eligible = leads.filter(l => l.id !== 'mino');
  return eligible.find(l => l.id === remembered)?.id ?? eligible[0]?.id ?? '';
}

export function linkedMission<T extends { originMessageId: string | null; parentId: string | null }>(missions: T[], messageId: string): T | undefined {
  return missions.find(m => m.parentId === null && m.originMessageId === messageId);
}

/** The main chat always speaks as Mino, including when a lead is doing the work. */
export function minoCoordinationSays(m: Pick<MissionDetail, 'status' | 'waiting' | 'acceptBlocked' | 'goalRev'>): string {
  switch (m.status) {
    case 'queued': return 'J’ai confié la mission. Le responsable commence dès qu’il est libre.';
    case 'running': return 'Je suis le travail du responsable et des exécutants. Je te montre leur résultat après les contrôles.';
    case 'stopping': return 'J’ai demandé l’arrêt de toute la mission. J’attends sa confirmation.';
    case 'review': return m.acceptBlocked ?? 'La synthèse est prête. Regarde les preuves et le contrôle final avant de valider.';
    case 'waiting': return m.waiting ?? 'Le responsable attend une décision. Tu peux me donner une précision ici.';
    case 'outdated': return `Tu as changé l’objectif. La synthèse précédente ne prouve pas la version ${m.goalRev}.`;
    case 'interrupted': return 'Une étape a un résultat inconnu. Vérifie les constats avant de reprendre.';
    case 'stopped': return 'Arrêt confirmé. Les fichiers déjà modifiés restent dans le dossier.';
    case 'accepted': return 'Tu as validé la synthèse et les étapes citées.';
    case 'failed': return 'La mission a échoué. Tu peux consulter les détails enregistrés.';
  }
}

/** Shown only because `codex resume --help` of the installed Codex 0.167 confirms `codex resume [SESSION_ID]`. */
