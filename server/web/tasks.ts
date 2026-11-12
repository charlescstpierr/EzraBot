import type { TaskEventView, TaskStatus, TaskStep, TaskView } from '../src/protocol.js';

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: 'En attente',
  running: 'En cours',
  stopped: 'Interrompu',
  goal_changed: 'Objectif modifié',
  needs_decision: 'À arbitrer',
  reviewer_unavailable: 'Relecture impossible',
  info_waiting: 'Précision en attente',
  finished: 'Prêt à valider',
  validated: 'Validé',
  cancelled: 'Annulé',
};

export const TASK_STATUS_HINTS: Record<TaskStatus, string> = {
  queued: 'La prochaine étape va démarrer.',
  running: 'Un appel est en cours. Vous pouvez continuer à discuter dans le fil.',
  stopped: 'L’appel s’est arrêté. Rien ne repart sans vous.',
  goal_changed: 'Le résultat obtenu suivait l’ancien objectif. Lancez une nouvelle passe ou gardez le document actuel.',
  needs_decision: 'Une proposition du bot attend votre choix : adoptez-la ou écartez-la.',
  reviewer_unavailable: 'Le relecteur choisi a été supprimé. Le brouillon reste ici et modifiable ; aucune relecture n’a eu lieu.',
  info_waiting: 'Une précision n’a été reçue par aucun appel. Une nouvelle passe peut l’appliquer.',
  finished: 'Le document est prêt. Relisez-le, modifiez-le ou validez-le.',
  validated: 'Document validé.',
  cancelled: 'Travail annulé. Le document et vos brouillons restent disponibles.',
};

export const STEP_LABELS: Record<TaskStep, string> = { draft: 'Rédaction', review: 'Avis', synthesis: 'Synthèse', revise: 'Nouvelle passe' };

export const CONTINUE_LABELS: Partial<Record<TaskStatus, string>> = {
  stopped: 'Relancer l’étape interrompue',
  goal_changed: 'Nouvelle passe avec l’objectif modifié',
  info_waiting: 'Appliquer les précisions',
  finished: 'Demander une nouvelle passe',
};

export const ATTENTION: ReadonlySet<TaskStatus> = new Set(['finished', 'needs_decision', 'goal_changed', 'stopped', 'reviewer_unavailable', 'info_waiting']);

export function isActive(task: TaskView): boolean {
  return task.status === 'running' || task.status === 'queued';
}

export function deliveryLabel(event: TaskEventView, botName: (id: string) => string): string {
  const delivery = event.delivery;
  switch (delivery.state) {
    case 'sent':
      return `Transmise à ${botName(delivery.botId)} (${STEP_LABELS[delivery.step].toLowerCase()}, appel ${delivery.attemptN}) : Codex a accepté ce tour.`;
    case 'prepared':
      return `Préparée pour ${botName(delivery.botId)} (${STEP_LABELS[delivery.step].toLowerCase()}), pas encore transmise.`;
    case 'waiting':
      return delivery.notSent
        ? `Non transmise : ${delivery.notSent > 1 ? `${delivery.notSent} appels se sont arrêtés` : 'un appel s’est arrêté'} avant d’être accepté. Elle attend la prochaine passe.`
        : 'Arrivée après le départ de l’appel en cours : elle attend la prochaine passe.';
    case 'applied':
      return 'Appliquée tout de suite par Mino.';
    case 'superseded':
      return `Remplacé par l’objectif de révision ${delivery.byRevision}. Aucun tour accepté pour cet objectif.`;
  }
}

export function planLabel(task: TaskView, botName: (id: string) => string): string {
  const author = botName(task.authorBotId);
  if (task.plan === 'solo') return `${author} rédige seul · ${task.maxCalls} appel${task.maxCalls > 1 ? 's' : ''} au plus`;
  return `${author} rédige, ${botName(task.reviewerBotId ?? '')} donne son avis, ${author} fait la synthèse · ${task.maxCalls} appels au plus`;
}

const CREATION_VERBS = /^(?:s[’']il te pla[iî]t,?\s+)?(?:r[ée]dige|[ée]cris|pr[ée]pare|cr[ée]e|fais|fait|g[ée]n[èe]re|compose|[ée]labore)(?![\p{L}])/iu;
const DOCUMENT_NOUNS = /(?<![\p{L}])(?:plan|document|lettre|note|rapport|article|page|texte|courriel|e-?mail|mail|pr[ée]sentation|liste|guide|proposition|cv|compte[- ]rendu|r[ée]sum[ée]|programme|discours|invitation|annonce|fiche|proc[ée]dure|brief|cahier des charges|newsletter|billet|devis|contrat|charte|mode d[’']emploi|checklist)s?(?![\p{L}])/iu;

/**
 * A local hint, never an order: an imperative creation request naming a document. Questions are left to the chat.
 * The person still chooses; nothing is sent to a model to decide.
 */
export function looksLikeDocumentRequest(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 12 || trimmed.endsWith('?')) return false;
  return CREATION_VERBS.test(trimmed) && DOCUMENT_NOUNS.test(trimmed);
}
