import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { MissionDrafts } from './client';
import { createMissionFollowups } from './followup-state';

export function useMissionFollowup(drafts: MissionDrafts | undefined, id: string) {
  const fallback = useMemo(createMissionFollowups, []);
  const owner = drafts?.followups ?? fallback;
  const snapshot = useCallback(() => owner.get(id), [owner, id]);
  const value = useSyncExternalStore(owner.subscribe, snapshot, snapshot);
  return {
    note: value.note, goalDraft: value.goal,
    busy: value.busy, message: value.message,
    begin: () => owner.begin(id),
    finish: (message: string) => owner.finish(id, message),
    setNote: (note: string) => owner.edit(id, { note }),
    setGoalDraft: (goal: string | null) => owner.edit(id, { goal }),
    clearSentNote: (sent: string) => owner.sentNote(id, sent),
    clearSentGoal: (sent: string | null) => owner.sentGoal(id, sent),
  };
}
export type MissionFollowup = ReturnType<typeof useMissionFollowup>;
