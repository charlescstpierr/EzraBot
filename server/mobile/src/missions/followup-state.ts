export type FollowupState = Readonly<{ note: string; goal: string | null; busy: boolean; message: string }>;
const empty: FollowupState = Object.freeze({ note: '', goal: null, busy: false, message: '' });

/** Owned by the space-scoped mission drafts, so collapsing a card never owns the text's lifetime. */
export function createMissionFollowups() {
  const values = new Map<string, FollowupState>();
  const listeners = new Set<() => void>();
  const get = (id: string) => values.get(id) ?? empty;
  const update = (id: string, patch: Partial<FollowupState>) => {
    const old = get(id), next = { ...old, ...patch };
    if (next.note === old.note && next.goal === old.goal && next.busy === old.busy && next.message === old.message) return;
    values.set(id, next);
    for (const listener of listeners) listener();
  };
  return {
    get,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit(id: string, patch: Partial<Pick<FollowupState, 'note' | 'goal'>>) { update(id, patch); },
    begin(id: string) {
      if (get(id).busy) return false;
      update(id, { busy: true, message: '' });
      return true;
    },
    finish(id: string, message: string) { update(id, { busy: false, message }); },
    sentNote(id: string, sent: string) { if (get(id).note === sent) update(id, { note: '' }); },
    sentGoal(id: string, sent: string | null) { if (get(id).goal === sent) update(id, { goal: null }); },
  };
}
