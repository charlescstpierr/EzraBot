import { AGENT_LIMITS, type AgentCommand, type AgentsView, type MissionDetail, type MissionMode, type MissionStatus } from '../src/agent-protocol.js';
import type { BotView, MessageView } from '../src/protocol.js';

type Body<T> = T extends unknown ? Omit<T, 'requestId'> : never;
type Command = Body<AgentCommand>;
type Context = { csrf(): string; refreshSession(): Promise<void>; bots(): BotView[]; messages(): MessageView[]; projects(): void };
type Draft = { projectId: string; projectChosen: boolean; goal: string; mode: MissionMode; leadBotId: string };
type Card = {
  root: HTMLElement; message: MessageView; status: HTMLElement; content: HTMLElement; editor: HTMLElement; error: HTMLElement;
  draft: Draft; busy: boolean; uncertain: boolean; signature: string; mission: MissionDetail | null;
  editing: 'continue' | 'revise' | null; note: string; revision: string; start: boolean; details: boolean; targetMissionId: string | null; selectedChild: Card | null; pending: { requestId: string; command: Command } | null;
};
const STATUS: Record<MissionStatus, string> = {
  queued: 'Je garde cette mission en attente.', running: 'Je suis le travail en cours.', stopping: 'J’ai demandé l’arrêt. J’attends sa confirmation.',
  review: 'Le travail est prêt à examiner.', outdated: 'L’objectif a changé. Le résultat précédent est périmé.',
  accepted: 'Tu as validé ce travail.', failed: 'L’essai a échoué. Le détail reste consultable.',
  stopped: 'L’arrêt est confirmé.', interrupted: 'Le résultat est inconnu. Vérifie le dossier avant de reprendre.', waiting: 'J’attends ta décision.',
};
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label: string, run: () => void, busy = false): HTMLButtonElement {
  const node = el('button', 'projects-button', label);
  node.type = 'button'; node.disabled = busy; node.onclick = run;
  return node;
}
function label(text: string, control: HTMLElement): HTMLLabelElement {
  const node = el('label', 'chat-mission-field', text); node.append(control); return node;
}

/** One refresh loop for mounted cards; mission details are read only for cards in the viewport. */
export function createChatMissions(context: Context) {
  const cards = new Set<Card>();
  const inViewport = new Set<Element>();
  const savedCards = new Map<string, Card>();
  let view: AgentsView | null = null;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let suspended = false;
  let refreshing = false;
  let refreshAgain = false;
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) inViewport.add(entry.target);
      else inViewport.delete(entry.target);
    }
    void refresh();
  }, { rootMargin: '200px' });

  function mounted(): Card[] { return [...cards].filter(card => card.root.isConnected && !card.root.closest('[hidden]')); }
  function fail(card: Card, text: string): void {
    card.error.textContent = text; card.error.hidden = !text;
    if (card.pending && !card.busy) card.error.append(' ', button('Réessayer la confirmation', () => {
      const pending = card.pending; if (pending) void post(card, pending.command, true);
    }));
  }
  function renderProposal(card: Card): void {
    if (!view) return;
    const projects = view.projects.filter(project => !project.archived);
    const candidates = context.bots().filter(bot => bot.id !== 'mino');
    const signature = JSON.stringify([projects, candidates.map(bot => [bot.id, bot.name]), card.busy, card.uncertain, Boolean(card.pending)]);
    if (signature === card.signature) return;
    card.signature = signature;
    card.status.textContent = 'Je peux confier ça';
    const form = el('form', 'chat-mission-form');
    form.append(el('p', '', card.message.handoff?.why ?? ''));
    if (!projects.length) {
      form.append(el('p', '', 'Ajoute un dossier dans Projets, puis reviens confirmer ici.'), button('Choisir les dossiers autorisés', context.projects));
      card.content.replaceChildren(form); return;
    }
    if (!projects.some(project => project.id === card.draft.projectId)) { card.draft.projectId = ''; card.draft.projectChosen = false; }
    if (!card.draft.projectChosen) card.draft.projectId = projects.length === 1 ? projects[0]?.id ?? '' : '';
    const project = el('select'); project.setAttribute('aria-label', 'Dossier de la mission'); project.required = true;
    const placeholder = el('option', '', 'Choisir un dossier'); placeholder.value = ''; project.append(placeholder);
    for (const item of projects) { const option = el('option', '', item.name); option.value = item.id; project.append(option); }
    project.value = card.draft.projectId;
    const chooseLead = () => {
      const preferred = projects.find(item => item.id === card.draft.projectId)?.leadBotId;
      card.draft.leadBotId = candidates.find(bot => bot.id === preferred)?.id ?? candidates[0]?.id ?? '';
    };
    if (!candidates.some(bot => bot.id === card.draft.leadBotId)) chooseLead();
    const goal = el('textarea'); goal.rows = 3; goal.maxLength = AGENT_LIMITS.goalChars; goal.required = true;
    goal.value = card.draft.goal; goal.setAttribute('aria-label', 'Objectif à confier');
    goal.oninput = () => { card.draft.goal = goal.value; };
    const advanced = el('details', 'chat-mission-details'); advanced.append(el('summary', '', 'Réglages facultatifs'));
    const mode = el('select'); mode.setAttribute('aria-label', 'Organisation de la mission');
    for (const [value, text] of [['direct', 'Un exécutant'], ['coordinated', 'Avec un responsable']]) {
      const option = el('option', '', text); option.value = value ?? ''; mode.append(option);
    }
    mode.value = card.draft.mode;
    const lead = el('select'); lead.setAttribute('aria-label', 'Responsable de la mission');
    for (const bot of candidates) { const option = el('option', '', bot.name); option.value = bot.id; lead.append(option); }
    lead.value = card.draft.leadBotId;
    const leadLabel = label('Responsable', lead); leadLabel.hidden = card.draft.mode !== 'coordinated';
    lead.onchange = () => { card.draft.leadBotId = lead.value; };
    project.onchange = () => { card.draft.projectId = project.value; card.draft.projectChosen = Boolean(project.value); chooseLead(); lead.value = card.draft.leadBotId; submit.disabled = cannotConfirm(); };
    advanced.append(label('Organisation', mode), leadLabel);
    const submit = el('button', 'projects-button solid', card.uncertain ? 'Vérifier avant de confier' : 'Confier la mission'); submit.type = 'submit';
    const cannotConfirm = () => card.busy || !card.draft.projectId || (card.draft.mode === 'coordinated' && !candidates.length);
    submit.disabled = cannotConfirm();
    mode.onchange = () => {
      card.draft.mode = mode.value === 'coordinated' ? 'coordinated' : 'direct';
      leadLabel.hidden = card.draft.mode !== 'coordinated'; submit.disabled = cannotConfirm();
    };
    if (!candidates.length) advanced.append(el('p', '', 'Crée un autre bot pour choisir un responsable.'));
    for (const control of [project, goal, mode, lead]) control.disabled = card.busy || Boolean(card.pending);
    form.append(label('Dossier', project), label('Ce que je vais confier', goal), advanced,
      el('p', 'chat-mission-muted', 'Je lancerai le travail dans ce dossier après ta confirmation.'), submit);
    form.onsubmit = event => {
      event.preventDefault();
      if (card.uncertain) { void refresh(); return; }
      if (cannotConfirm()) return;
      card.draft.projectChosen = true;
      const command: Command = { type: 'mission.create', projectId: card.draft.projectId, goal: card.draft.goal.trim(),
        mode: card.draft.mode, model: null, effort: null, origin: { messageId: card.message.id },
        ...(card.draft.mode === 'coordinated' ? { leadBotId: card.draft.leadBotId } : {}) };
      void post(card, command);
    };
    card.content.replaceChildren(form);
  }

  function renderEditor(card: Card): void {
    card.editor.replaceChildren();
    const mission = card.mission;
    if (!mission || !card.editing) return;
    const editing = card.editing;
    const form = el('form', 'chat-mission-form');
    const text = el('textarea'); text.rows = 3; text.required = editing === 'revise';
    text.maxLength = editing === 'revise' ? AGENT_LIMITS.goalChars : AGENT_LIMITS.noteChars;
    text.value = editing === 'revise' ? card.revision : card.note;
    text.setAttribute('aria-label', editing === 'revise' ? 'Nouvel objectif' : 'Précision pour Mino');
    text.oninput = () => { if (editing === 'revise') card.revision = text.value; else card.note = text.value; };
    form.append(label(editing === 'revise' ? 'Nouvel objectif' : 'Ta précision', text));
    if (editing === 'revise') {
      const start = el('input'); start.type = 'checkbox'; start.checked = card.start;
      start.onchange = () => { card.start = start.checked; }; form.append(label('Relancer après enregistrement', start));
    }
    const submit = el('button', 'projects-button solid', editing === 'revise' ? 'Enregistrer l’objectif' : 'Envoyer la précision'); submit.type = 'submit';
    submit.disabled = card.busy || (editing === 'revise' ? !mission.can.revise : !mission.can.continue);
    form.append(submit, button('Annuler', () => {
      if (editing === 'revise') card.revision = ''; else card.note = '';
      card.editing = null; renderEditor(card);
    }, card.busy));
    form.onsubmit = event => {
      event.preventDefault();
      const current = card.mission;
      if (!current || card.busy || card.uncertain) return;
      if (editing === 'revise' && current.can.revise) void post(card, { type: 'mission.revise', missionId: current.id, goal: card.revision.trim(), start: card.start });
      if (editing === 'continue' && current.can.continue) void post(card, { type: 'mission.continue', missionId: current.id, note: card.note.trim() });
    };
    card.editor.append(form);
  }

  function renderMission(card: Card): void {
    const m = card.mission;
    if (!m) return;
    card.root.dataset.missionId = m.id; card.root.dataset.status = m.status;
    card.status.textContent = STATUS[m.status];
    const budget = m.tree ?? { used: m.attemptsUsed, max: m.maxAttempts };
    const content: HTMLElement[] = [el('p', '', m.title), el('p', 'chat-mission-muted', `${view?.projects.find(p => p.id === m.projectId)?.name ?? 'Dossier'} · ${budget.used}/${budget.max} essais`)];
    if (m.waiting) content.push(el('p', '', `J’ai besoin de ta réponse : ${m.waiting}`));
    if (m.synthesis) {
      content.push(el('p', '', `Synthèse du travail : ${m.synthesis.summary}`));
      if (m.synthesis.limits) content.push(el('p', '', `Limites signalées : ${m.synthesis.limits}`));
    }
    if (m.acceptBlocked) content.push(el('p', 'chat-mission-muted', `Je ne peux pas encore valider : ${m.acceptBlocked}`));
    const actions = el('div', 'chat-mission-actions');
    const act = (text: string, command: Command) => actions.append(button(text, () => void post(card, command), card.busy || card.uncertain));
    if (m.can.stop) act('Arrêter', { type: 'mission.stop', missionId: m.id });
    if (m.can.resume) act('Reprendre avec Mino après vérification', { type: 'mission.resume', missionId: m.id });
    if (m.can.continue) actions.append(button('Préciser à Mino', () => { card.editing = 'continue'; renderEditor(card); }, card.busy || card.uncertain));
    if (m.can.revise && m.status !== 'accepted') actions.append(button('Modifier l’objectif', () => {
      card.editing = 'revise'; card.revision ||= m.goals.at(-1)?.text ?? ''; renderEditor(card);
    }, card.busy || card.uncertain));
    if (m.can.review) act('Demander une relecture', { type: 'mission.review', missionId: m.id });
    if (m.can.budget && m.status !== 'accepted') act(`Accorder ${m.mode === 'coordinated' ? AGENT_LIMITS.coordinatedStep : AGENT_LIMITS.budgetStep} essais`, { type: 'mission.budget', missionId: m.id });
    if (m.can.accept && !m.parentId) act(m.mode === 'coordinated' ? 'Valider la synthèse' : 'Valider ce résultat', { type: 'mission.accept', missionId: m.id, attemptId: m.can.accept });
    content.push(actions);
    const details = el('details', 'chat-mission-details'); details.open = card.details;
    details.ontoggle = () => { card.details = details.open; };
    details.append(el('summary', '', 'Détails du travail'));
    if (m.lead) details.append(el('p', '', `Responsable interne : ${m.lead.name}`));
    if (m.origin) details.append(el('p', '', `Ta demande d’origine : ${m.origin.text}`));
    details.append(el('p', '', `Objectif actuel : ${m.goals.at(-1)?.text ?? m.title}`));
    for (const child of m.children) details.append(button(`Consulter l’étape : ${child.title}`, () => {
      if (card.selectedChild?.targetMissionId !== child.id) card.selectedChild = createCard(card.message, child.id);
      card.details = true; renderMission(card); void refresh();
    }));
    if (card.selectedChild) {
      cards.add(card.selectedChild); observer.observe(card.selectedChild.root);
      details.append(card.selectedChild.root);
    }
    for (const decision of m.decisions) {
      const item = el('details'); item.append(el('summary', '', `Décision interne ${decision.n} · ${decision.outcome === 'applied' ? 'appliquée' : 'refusée'}`), el('pre', '', decision.raw));
      if (decision.refusal) item.append(el('p', '', decision.refusal)); details.append(item);
    }
    for (const attempt of m.attempts) {
      const item = el('details'); item.append(el('summary', '', `Essai ${attempt.n} · ${attempt.state}`));
      if (attempt.threadId) item.append(el('p', '', `Fil de l’exécutant : ${attempt.threadId}`));
      if (attempt.finalText) item.append(el('pre', '', attempt.finalText));
      if (attempt.errorMessage) item.append(el('p', '', attempt.errorMessage));
      if (attempt.check) item.append(el('pre', '', `Contrôle : ${attempt.check.command.join(' ')}\nCode de sortie : ${attempt.check.exitCode ?? 'inconnu'}\n${attempt.check.output}\n${attempt.check.error ?? ''}`));
      if (attempt.observed) item.append(el('pre', '', `Constaté par Mino dans le dossier\n${attempt.observed.status.join('\n')}\n${attempt.observed.diffStat}\n${attempt.observed.error ?? ''}`));
      if (attempt.input) { const input = el('details'); input.append(el('summary', '', 'Consigne transmise'), el('pre', '', attempt.input)); item.append(input); }
      details.append(item);
    }
    if (m.live) details.append(el('pre', '', m.live.text));
    content.push(details);
    card.content.replaceChildren(...content);
    for (const control of card.editor.querySelectorAll('button,input,textarea')) {
      if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)
        control.disabled = card.busy || card.uncertain || (card.editing === 'revise' ? !m.can.revise : !m.can.continue);
    }
  }

  async function post(card: Card, command: Command, retry = false): Promise<void> {
    if (card.busy || (card.uncertain && !retry)) return;
    card.pending ??= { requestId: crypto.randomUUID(), command };
    const { requestId, command: recordedCommand } = card.pending;
    card.busy = true; fail(card, ''); render(card);
    const send = () => fetch('/api/agents/commands', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mino-csrf': context.csrf() }, body: JSON.stringify({ ...recordedCommand, requestId }) });
    try {
      let response = await send();
      if (response.status === 403) { await context.refreshSession(); response = await send(); }
      const result = await response.json() as { ok: boolean; message?: string };
      card.pending = null; card.uncertain = false;
      if (!result.ok) fail(card, result.message ?? 'Je n’ai pas pu appliquer cette action.');
      else {
        if (recordedCommand.type === 'mission.continue' && card.note.trim() === (recordedCommand.note ?? '')) {
          card.note = ''; if (card.editing === 'continue') card.editing = null;
        }
        if (recordedCommand.type === 'mission.revise' && card.revision.trim() === recordedCommand.goal) {
          card.revision = ''; if (card.editing === 'revise') card.editing = null;
        }
        renderEditor(card);
      }
    } catch {
      card.uncertain = true;
      fail(card, 'Je n’ai pas reçu la confirmation du PC. Je vérifie l’état avant une nouvelle action.');
    } finally {
      card.busy = false;
      if (card.pending) fail(card, 'Je n’ai pas reçu la confirmation du PC. Tu peux la redemander sans doubler la commande.');
      render(card); await refresh();
    }
  }
  function render(card: Card): void {
    if (card.mission) renderMission(card);
    else if (!card.targetMissionId) renderProposal(card);
  }

  async function refresh(): Promise<void> {
    if (!active || !mounted().length) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const response = await fetch('/api/agents/view', { signal });
      if (!response.ok) throw new Error('indisponible');
      view = await response.json() as AgentsView;
      for (const card of mounted()) {
        const summary = view.missions.find(mission => mission.originMessageId === card.message.id && mission.parentId === null);
        const missionId = card.targetMissionId ?? summary?.id;
        if (missionId && inViewport.has(card.root)) {
          try {
            const detail = await fetch(`/api/agents/missions/${encodeURIComponent(missionId)}`, { signal });
            if (!detail.ok) throw new Error('indisponible');
            const page = await detail.json() as { mission: MissionDetail };
            const signature = JSON.stringify(page.mission);
            card.mission = page.mission;
            const wasUncertain = card.uncertain;
            if (card.pending?.command.type === 'mission.create') card.pending = null;
            card.uncertain = Boolean(card.pending);
            if (wasUncertain && !card.uncertain) fail(card, '');
            if (signature !== card.signature || wasUncertain) { card.signature = signature; renderMission(card); }
          } catch (error) {
            if (signal.aborted) throw error;
            card.uncertain = true; fail(card, 'Je ne peux pas actualiser ce travail. Les actions reprendront à la reconnexion.'); render(card);
          }
        } else if (!missionId) {
          const wasUncertain = card.uncertain; card.uncertain = Boolean(card.pending);
          if (wasUncertain && !card.uncertain) fail(card, '');
          renderProposal(card);
        } else if (!card.mission && summary && !card.targetMissionId) {
          card.status.textContent = STATUS[summary.status];
          card.content.replaceChildren(el('p', '', summary.title));
        }
      }
    } catch {
      if (!signal.aborted) for (const card of mounted()) {
        card.uncertain = true; fail(card, 'Je ne peux pas joindre le PC. Je garde la demande ici et je réessaie.'); render(card);
      }
    } finally {
      refreshing = false;
      if (active) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; void refresh(); }, refreshAgain ? 0 : 1800);
      }
      refreshAgain = false;
    }
  }
  function sync(enabled: boolean): void {
    const existing = new Set(context.messages().map(message => message.id));
    for (const [key, card] of savedCards) if (!existing.has(card.message.id)) {
      observer.unobserve(card.root); inViewport.delete(card.root); cards.delete(card); savedCards.delete(key);
    }
    for (const card of cards) if (!card.root.isConnected) { observer.unobserve(card.root); inViewport.delete(card.root); cards.delete(card); }
    active = enabled && !suspended && mounted().length > 0;
    if (!active) { controller?.abort(); if (timer) clearTimeout(timer); timer = null; return; }
    if (!timer && !refreshing) void refresh();
  }
  function createCard(message: MessageView, targetMissionId: string | null): Card {
    const key = JSON.stringify([message.id, targetMissionId]);
    const saved = savedCards.get(key);
    if (saved) {
      saved.message = message; saved.signature = '';
      cards.add(saved); observer.observe(saved.root); render(saved);
      return saved;
    }
    const root = el('section', `mission-handoff ${targetMissionId ? 'chat-mission-step' : 'chat-mission'}`); root.setAttribute('aria-label', targetMissionId ? 'Étape suivie par Mino' : 'Mission avec Mino');
    if (targetMissionId) root.dataset.missionId = targetMissionId; else root.dataset.originMessageId = message.id;
    const status = el('strong', '', targetMissionId ? 'Chargement de l’étape…' : 'Je prépare les dossiers disponibles…');
    const content = el('div'); const editor = el('div'); const error = el('p', 'chat-mission-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const draft: Draft = { projectId: '', projectChosen: false, goal: message.handoff?.goal ?? '', mode: message.handoff?.coordinated ? 'coordinated' : 'direct', leadBotId: '' };
    const state: Card = { root, message, status, content, editor, error, draft, busy: false, uncertain: false, signature: '', mission: null,
      editing: null, note: '', revision: '', start: false, details: false, targetMissionId, selectedChild: null, pending: null };
    root.append(status, content, editor, error); cards.add(state); observer.observe(root);
    savedCards.set(key, state);
    return state;
  }
  function card(message: MessageView): HTMLElement { return createCard(message, null).root; }
  window.addEventListener('pagehide', () => {
    suspended = true; active = false; controller?.abort();
    if (timer) clearTimeout(timer);
    timer = null; observer.disconnect();
  });
  window.addEventListener('pageshow', () => {
    suspended = false;
    for (const card of cards) observer.observe(card.root);
    sync(mounted().length > 0);
  });
  return { card, sync };
}
