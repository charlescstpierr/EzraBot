import type { AgentsView, MissionStatus } from '../src/agent-protocol.js';

/** PC-only: choosing which folders an executor may write in never happens from a phone. */

const STATUS: Record<MissionStatus, string> = {
  queued: 'En attente', running: 'En cours', stopping: 'Arrêt demandé', review: 'À examiner', outdated: 'Objectif modifié',
  interrupted: 'Résultat inconnu', failed: 'Échec', stopped: 'Arrêtée', accepted: 'Validée', waiting: 'Décision requise',
};

type Context = { csrf(): string; refreshSession(): Promise<void>; toast(text: string): void };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountProjects(context: Context): () => void {
  const open = el('button', 'work-toggle', 'Projets');
  open.id = 'projects-nav';
  open.type = 'button';
  open.title = 'Dossiers confiés aux exécutants et leurs missions';
  document.querySelector('.top-right')?.prepend(open);

  const dialog = el('dialog', 'creations-drawer projects-drawer');
  dialog.setAttribute('aria-labelledby', 'projects-title');
  const heading = el('div', 'creations-heading');
  const titles = el('div');
  const title = el('h2', '', 'Projets');
  title.id = 'projects-title';
  titles.append(title, el('p', '', 'Les dossiers où Mino peut confier une mission à un exécutant Codex.'));
  const close = el('button', '', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Fermer');
  close.onclick = () => dialog.close();
  heading.append(titles, close);
  const body = el('div', 'projects-body');
  dialog.append(heading, body);
  document.body.append(dialog);

  let view: AgentsView | null = null;
  let polling: AbortController | null = null;
  let editing: string | null = null;

  async function post(command: Record<string, unknown>): Promise<boolean> {
    const send = () => fetch('/api/agents/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mino-csrf': context.csrf() },
      body: JSON.stringify({ ...command, requestId: crypto.randomUUID() }),
    });
    try {
      let response = await send();
      if (response.status === 403) { await context.refreshSession(); response = await send(); }
      const value = await response.json() as { ok: boolean; message?: string; view?: AgentsView };
      if (value.view) { view = value.view; render(); }
      if (!value.ok) context.toast(value.message ?? 'Mino a refusé cette action.');
      return value.ok;
    } catch {
      context.toast('Mino ne répond pas. La demande est peut-être arrivée : rouvre Projets pour vérifier.');
      return false;
    }
  }

  async function poll(signal: AbortSignal): Promise<void> {
    let after: number | null = null;
    while (!signal.aborted) {
      try {
        const response = await fetch(`/api/agents/view${after === null ? '' : `?after=${after}`}`, { signal });
        if (!response.ok) throw new Error('indisponible');
        view = await response.json() as AgentsView;
        after = view.rev;
        render();
      } catch {
        if (signal.aborted) return;
        await new Promise(resolve => setTimeout(resolve, 3000));
        after = null;
      }
    }
  }

  function render(): void {
    if (!view) { body.replaceChildren(el('p', 'projects-muted', 'Chargement…')); return; }
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && body.contains(active)) return;
    const parts: HTMLElement[] = [];
    if (view.engine.state === 'unavailable') parts.push(el('p', 'projects-warning', view.engine.message ?? 'Codex est indisponible.'));

    const list = el('div', 'projects-list');
    const projects = view.projects.filter(p => !p.archived);
    if (!projects.length) list.append(el('p', 'projects-muted', 'Aucun dossier pour le moment. Ajoute le dossier d’un projet ci-dessous.'));
    for (const project of projects) {
      const card = el('section', 'projects-card');
      const missions = view.missions.filter(m => m.projectId === project.id);
      card.append(el('strong', '', project.name), el('p', 'projects-path', project.path));
      card.append(el('p', 'projects-muted', project.checkCommand ? `Contrôle après chaque essai : ${project.checkCommand.join(' ')}` : 'Sans commande de contrôle'));
      if (!project.git) card.append(el('p', 'projects-muted', 'Pas un dépôt git : Mino ne pourra pas lister les fichiers changés.'));
      if (editing === project.id) {
        const input = el('input', 'projects-input');
        input.value = project.checkCommand?.join(' ') ?? '';
        input.placeholder = 'npm test';
        input.setAttribute('aria-label', 'Commande de contrôle');
        const save = el('button', 'projects-button solid', 'Enregistrer');
        save.type = 'button';
        save.onclick = () => void post({ type: 'project.update', projectId: project.id, checkCommand: input.value }).then(ok => { if (ok) { editing = null; render(); } });
        card.append(input, save);
      }
      const actions = el('div', 'projects-actions');
      const edit = el('button', 'projects-button', editing === project.id ? 'Annuler' : 'Contrôle…');
      edit.type = 'button';
      edit.onclick = () => { editing = editing === project.id ? null : project.id; render(); };
      const remove = el('button', 'projects-button', 'Retirer');
      remove.type = 'button';
      remove.onclick = () => { if (confirm(`Retirer « ${project.name} » de Mino ? Le dossier et ses fichiers ne sont pas touchés.`)) void post({ type: 'project.archive', projectId: project.id }); };
      actions.append(edit, remove);
      card.append(actions);
      for (const mission of missions.slice(0, 5)) {
        const row = el('div', 'projects-mission');
        row.append(el('span', '', mission.title), el('span', `projects-pill ${['review', 'outdated', 'interrupted', 'failed'].includes(mission.status) ? 'strong' : ''}`, STATUS[mission.status]));
        if (mission.status === 'running' || mission.status === 'queued') {
          const stop = el('button', 'projects-button', 'Arrêter');
          stop.type = 'button';
          stop.onclick = () => void post({ type: 'mission.stop', missionId: mission.id });
          row.append(stop);
        }
        card.append(row);
      }
      list.append(card);
    }
    parts.push(list);

    const form = el('form', 'projects-form');
    form.append(el('h3', '', 'Confier un dossier'));
    const path = el('input', 'projects-input');
    path.name = 'path'; path.required = true; path.placeholder = '/home/vous/projets/site'; path.setAttribute('aria-label', 'Chemin complet du dossier');
    const name = el('input', 'projects-input');
    name.name = 'name'; name.placeholder = 'Nom affiché (facultatif)'; name.setAttribute('aria-label', 'Nom affiché');
    const check = el('input', 'projects-input');
    check.name = 'check'; check.placeholder = 'Commande de contrôle, ex. npm test (facultatif)'; check.setAttribute('aria-label', 'Commande de contrôle');
    const submit = el('button', 'projects-button solid', 'Confier ce dossier');
    submit.type = 'submit';
    form.append(path, name, check, submit,
      el('p', 'projects-muted', 'L’exécutant pourra modifier ce dossier et y lancer des commandes, sans Internet ni autorisation supplémentaire. Il peut lire d’autres fichiers de l’ordinateur, sans pouvoir les modifier. Les missions se confient et se suivent dans Mino sur ton téléphone.'));
    form.onsubmit = event => {
      event.preventDefault();
      submit.disabled = true;
      void post({ type: 'project.add', path: path.value.trim(), name: name.value.trim(), checkCommand: check.value.trim() }).then(ok => {
        submit.disabled = false;
        if (ok) form.reset();
      });
    };
    parts.push(form);
    body.replaceChildren(...parts);
  }

  const show = () => {
    render();
    if (!dialog.open) dialog.showModal();
    polling?.abort();
    polling = new AbortController();
    void poll(polling.signal);
  };
  open.onclick = show;
  dialog.addEventListener('close', () => { polling?.abort(); polling = null; });
  return show;
}
