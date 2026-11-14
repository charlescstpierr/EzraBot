import type { WorkNext, WorkState } from './protocol.js';

export function workNext(facts: { task: boolean; botPresent: boolean; hasExecution: boolean; state: WorkState }): WorkNext {
  if (facts.task) return { kind: 'document', reason: 'Ce travail documentaire se reprend avec « Reprendre », qui compte dans sa limite d’appels.' };
  if (!facts.botPresent) return { kind: 'none', reason: 'Ce bot a été supprimé : ce travail ne peut pas être relancé.' };
  if (facts.hasExecution) return { kind: 'new_request', reason: 'Ce travail a déjà une action de service approuvée. Il ne se relance pas : faites une nouvelle demande.' };
  if (facts.state === 'failed' || facts.state === 'cancelled') return { kind: 'retry' };
  if (facts.state === 'pending' || facts.state === 'running') return { kind: 'wait', reason: 'Un appel est en attente ou en cours. Attendez sa fin ou arrêtez-le.' };
  return { kind: 'none', reason: 'Ce travail ne peut pas changer d’état de cette façon maintenant.' };
}
