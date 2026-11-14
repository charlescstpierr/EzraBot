import { mentionQuery, insertMention, rebase, trimForSend, type MentionSpan } from './mentions.js';
import type {
  AppView,
  BotChoice,
  BotView,
  CatalogModel,
  Command,
  CommandResult,
  MessageView,
  ProposalView,
  PublicationView,
  TaskStep,
  TaskView,
  VersionView,
  WorkState,
  WorkView,
} from '../src/protocol.js';
import { LIMITS, type ContextSize, type ReplyStyle } from '../src/constants.js';
import { openDrafts, type Capture, type DraftFile, type KeyValueStorage } from './drafts.js';
import { htmlDocument } from '../src/html-artifact.js';
import { renderMarkdownHtml } from './markdown.js';
import { mountProjects } from './projects.js';
import { createChatMissions } from './chat-missions.js';
import { fold, forgetSearch, searchThread, type Hit } from './search.js';
import { ATTENTION, CONTINUE_LABELS, STEP_LABELS, TASK_STATUS_HINTS, TASK_STATUS_LABELS, deliveryLabel, isActive, looksLikeDocumentRequest, planLabel } from './tasks.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Draft = DistributiveOmit<Command, 'requestId'>;
type Mascots = { shapes: { id: string; label: string; defaultColor: string }[]; colors: string[] };
type Sent = { ok: true; result: CommandResult } | { ok: false; message: string };

const STATE_LABELS: Record<WorkState, string> = {
  pending: 'En attente', running: 'En cours', review: 'À valider', done: 'Terminé', failed: 'Échoué', cancelled: 'Annulé',
};
const STATE_CLASSES: Record<WorkState, string> = {
  pending: 'needs_input', running: 'working', review: 'needs_review', done: 'completed', failed: 'error', cancelled: 'cancelled',
};
const STAGE_LABELS = { starting: 'Démarrage de Codex…', thinking: 'Réflexion…', writing: 'Rédaction…' } as const;
const EFFORT_LABELS: Record<string, string> = {
  none: 'Sans raisonnement', minimal: 'Minimal', low: 'Léger', medium: 'Équilibré', high: 'Élevé', xhigh: 'Très élevé', max: 'Maximum', ultra: 'Ultra',
};
const ROLE_TITLES: Record<string, { title: string; shape: string }> = {
  general: { title: 'Général', shape: 'sprout' },
  design: { title: 'Design', shape: 'turnip' },
  explain: { title: 'Code', shape: 'broccoli' },
  ideas: { title: 'Écriture', shape: 'radish' },
};
const REPLY_STYLE_LABELS: Record<ReplyStyle, string> = { concise: 'Concises', normal: 'Normales', detailed: 'Détaillées' };
const CONTEXT_SIZE_LABELS: Record<ContextSize, string> = { short: 'Court', standard: 'Standard', long: 'Long' };
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|html?|xml|ya?ml|log|ini|toml|js|ts|css|py)$/i;
const MAX_FILE_BYTES = 512_000;

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Élément manquant: ${id}`);
  return element;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const element = make('button', className, label);
  element.type = 'button';
  element.onclick = event => {
    event.stopPropagation();
    onClick();
  };
  return element;
}

function escapeMarkup(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function mascot(bot: BotView, className = ''): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 90');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  svg.style.setProperty('--bot-color', bot.color);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#profile-${bot.shape}`);
  svg.append(use);
  return svg;
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const scrollBehavior = (): ScrollBehavior => (reducedMotion.matches ? 'auto' : 'smooth');

function markdown(text: string): HTMLDivElement {
  const holder = make('div', 'md');
  const template = document.createElement('template');
  template.innerHTML = renderMarkdownHtml(text);
  holder.append(template.content);
  return holder;
}

type Presence = 'pending' | 'starting' | 'thinking' | 'writing';

function botPresence(botId: string): Presence | null {
  const works = view?.works.filter(w => w.botId === botId && w.threadBotId === activeId) ?? [];
  const running = works.find(w => w.state === 'running');
  if (running) return running.attempt?.stage ?? 'starting';
  return works.some(w => w.state === 'pending') ? 'pending' : null;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' });
}

const promptEl = byId('prompt', HTMLTextAreaElement);
const messagesEl = byId('messages', HTMLDivElement);
const welcomeEl = byId('welcome', HTMLDivElement);
const fan = byId('bot-fan', HTMLDivElement);
const trigger = byId('bot-trigger', HTMLButtonElement);
const wheel = byId('bot-wheel', HTMLDivElement);
const actions = byId('fan-actions', HTMLDivElement);
const playDialog = byId('play-dialog', HTMLDialogElement);
const playContent = byId('play-dialog-content', HTMLDivElement);
const workDrawer = byId('work-drawer', HTMLDialogElement);
const creationsDrawer = byId('creations-drawer', HTMLDialogElement);
const newBotDialog = byId('new-bot-dialog', HTMLDialogElement);
const newBotForm = byId('new-bot-form', HTMLFormElement);
const newBotName = byId('new-bot-name', HTMLInputElement);

function storageOrNull(read: () => Storage): KeyValueStorage | null {
  try {
    return read();
  } catch {
    return null;
  }
}

const drafts = openDrafts({ local: storageOrNull(() => window.localStorage), session: storageOrNull(() => window.sessionStorage) });

let csrf = document.querySelector('meta[name="mino-csrf"]')?.getAttribute('content') ?? '';
let view: AppView | null = null;
let mascots: Mascots = { shapes: [], colors: [] };
let activeId = '';
let toastTimer: number | undefined;

function toast(text: string): void {
  const el = byId('toast', HTMLDivElement);
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), 3600);
}

function isAppView(value: unknown): value is AppView {
  return typeof value === 'object' && value !== null && 'rev' in value && typeof value.rev === 'number'
    && 'bots' in value && Array.isArray(value.bots) && 'messages' in value && Array.isArray(value.messages)
    && 'works' in value && Array.isArray(value.works) && 'engine' in value;
}

function readBody(value: unknown): { ok: boolean; message: string; result: unknown; view: AppView | null } {
  if (typeof value !== 'object' || value === null) return { ok: false, message: 'Réponse inattendue de Mino.', result: null, view: null };
  return {
    ok: 'ok' in value && value.ok === true,
    message: 'message' in value && typeof value.message === 'string' ? value.message : 'Mino a refusé cette action.',
    result: 'result' in value ? value.result : null,
    view: 'view' in value && isAppView(value.view) ? value.view : null,
  };
}

async function refreshSession(): Promise<void> {
  const html = await (await fetch('/')).text();
  const match = /name="mino-csrf" content="([0-9a-f]+)"/.exec(html);
  if (match?.[1]) csrf = match[1];
}

const uncertainSends = new Map<string, { payload: string; body: string }>();
async function dispatch(draft: Draft): Promise<Sent> {
  const protectedWorkId = draft.type === 'work.accept' || draft.type === 'publication.propose' ? draft.workId
    : draft.type === 'publication.approve' ? view?.works.find(work => work.proposals.some(proposal => proposal.id === draft.proposalId))?.id
      : undefined;
  const savedVersion = protectedWorkId ? drafts.read({ kind: 'version', workId: protectedWorkId }) : null;
  const liveVersion = protectedWorkId ? workById(protectedWorkId)?.versions.at(-1) : null;
  const dirtySaved = savedVersion && liveVersion && (savedVersion.baseVersionId !== liveVersion.id || savedVersion.title !== liveVersion.title || savedVersion.body !== liveVersion.body);
  if (protectedWorkId && (dirtySaved || [...messagesEl.querySelectorAll<HTMLElement>('[data-work-id]')]
    .some(element => element.dataset.workId === protectedWorkId && element.dataset.keepDraft === 'true'))) {
    const message = 'Enregistrez vos modifications avant de valider ou de publier.';
    toast(message);
    return { ok: false, message };
  }
  const payload = JSON.stringify(draft);
  const uncertain = draft.type === 'message.send' ? uncertainSends.get(draft.botId) : undefined;
  const body = uncertain?.payload === payload ? uncertain.body : JSON.stringify({ ...draft, requestId: crypto.randomUUID() });
  if (draft.type === 'message.send') uncertainSends.set(draft.botId, { payload, body });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mino-csrf': csrf },
        body,
      });
      if (response.status === 403 && attempt === 0) {
        await refreshSession();
        continue;
      }
      const parsed = readBody(await response.json());
      if (draft.type === 'message.send') uncertainSends.delete(draft.botId);
      if (parsed.view) applyView(parsed.view);
      if (!parsed.ok) {
        toast(parsed.message);
        return { ok: false, message: parsed.message };
      }
      return { ok: true, result: isResult(parsed.result) ? parsed.result : { kind: 'bot', botId: '' } };
    } catch {
      await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  const message = 'Mino ne répond pas. Vérifiez que le serveur est lancé.';
  toast(message);
  return { ok: false, message };
}

function isResult(value: unknown): value is CommandResult {
  return typeof value === 'object' && value !== null && 'kind' in value && typeof value.kind === 'string';
}

function bots(): BotView[] {
  return view?.bots ?? [];
}

function botById(id: string): BotView | undefined {
  return bots().find(bot => bot.id === id);
}

function currentBot(): BotView | undefined {
  return botById(activeId) ?? bots()[0];
}

const DELETED_BOT_NAME = 'Bot supprimé';

function isRetired(id: string): boolean {
  return !botById(id) && (view?.retiredBotIds.includes(id) ?? false);
}

/** Who signed a message or a work: a live bot, or « Bot supprimé » for kept contributions of a deleted one. */
function botName(id: string, fallback = 'Bot'): string {
  return botById(id)?.name ?? (isRetired(id) ? DELETED_BOT_NAME : fallback);
}

function models(): CatalogModel[] {
  return view?.engine.state === 'ready' ? view.engine.models : [];
}

function choiceLabel(choice: BotChoice): string {
  const list = models();
  const model = choice.model === null ? list.find(m => m.isDefault) : list.find(m => m.id === choice.model);
  const name = model?.displayName ?? choice.model ?? 'Codex';
  const effort = choice.effort ?? model?.defaultEffort ?? null;
  const speed = choice.speed === 'standard' ? '' : ' · ' + (model?.speeds.find(s => s.id === choice.speed)?.name ?? choice.speed);
  return `${name}${effort ? ' · ' + (EFFORT_LABELS[effort] ?? effort) : ''}${speed}`;
}

function stampLabel(stamp: NonNullable<MessageView['stamp']>): string {
  const model = models().find(m => m.id === stamp.model);
  const speed = stamp.speed === 'standard' ? 'Standard' : model?.speeds.find(s => s.id === stamp.speed)?.name ?? stamp.speed;
  return `${model?.displayName ?? stamp.model} · ${EFFORT_LABELS[stamp.effort] ?? stamp.effort} · ${speed}`;
}

function download(path: string): void {
  const anchor = make('a');
  anchor.href = path;
  anchor.download = '';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

// Picker: geometry, hold, drag and keyboard are carried over from the prototype unchanged in their numbers.
let items: BotView[] = [];
let cursor = 0;
let drag: { id: number; x: number; start: number; moved: boolean; lastX: number; lastTime: number; velocity: number } | null = null;
let suppressClick = false;
let pickerSignature = '';

function selectBot(id: string): void {
  if (id === activeId) return;
  savePane();
  activeId = id;
  applyBotIdentity();
  renderThread();
  renderIndicators();
  void dispatch({ type: 'bot.select', botId: id });
}

function applyBotIdentity(): void {
  const bot = currentBot();
  if (!bot) return;
  byId('picker-label', HTMLSpanElement).textContent = bot.name;
  const model = byId('model-button', HTMLButtonElement);
  model.textContent = choiceLabel(bot.choice);
  model.setAttribute('aria-label', `Modèle, effort et vitesse de ${bot.name}`);
  showComposerFor(bot.id);
  renderDocOptions();
  renderMentions();
}

function layout(): void {
  const n = items.length;
  if (!n) return;
  const open = fan.classList.contains('is-open');
  const radius = Math.min(133, wheel.clientWidth / 2 - 21);
  [...actions.children].forEach((child, i) => {
    if (!(child instanceof HTMLButtonElement)) return;
    const item = items[i];
    if (!item) return;
    const d = ((i - cursor + n / 2) % n + n) % n - n / 2;
    const angle = d * 48 * Math.PI / 180;
    const selected = item.id === activeId;
    const visible = open ? Math.abs(d) < 1.75 : selected;
    child.style.setProperty('--x', (open ? Math.sin(angle) * radius : 0) + 'px');
    child.style.setProperty('--y', (open ? -(1 - Math.cos(angle)) * 90 : 0) + 'px');
    child.style.setProperty('--scale', String(open ? 1.12 - Math.min(Math.abs(d), 2) * 0.49 : selected ? 1.12 : 0.3));
    child.style.opacity = visible ? String(1 - Math.min(Math.abs(d), 2) * 0.33) : '0';
    child.style.visibility = visible ? 'visible' : 'hidden';
    child.tabIndex = visible && (selected || open) ? 0 : -1;
    child.setAttribute('aria-hidden', String(!visible));
    child.setAttribute('aria-pressed', String(selected));
    if (selected) {
      child.setAttribute('aria-expanded', String(open));
      child.setAttribute('aria-controls', 'fan-actions');
      child.setAttribute('aria-label', `Personnaliser ${item.name} ; maintenir pour changer de bot`);
    } else {
      child.removeAttribute('aria-expanded');
      child.removeAttribute('aria-controls');
      child.setAttribute('aria-label', `Choisir ${item.name}`);
    }
    child.style.zIndex = String(10 - Math.round(Math.abs(d) * 2));
  });
}

function populate(): void {
  items = [...bots()];
  actions.replaceChildren();
  for (const bot of items) {
    const element = make('button', 'wheel-bot');
    element.type = 'button';
    element.dataset.botId = bot.id;
    element.append(mascot(bot), make('span', '', bot.name));
    element.onclick = () => {
      if (suppressClick) return;
      if (bot.id === activeId) {
        showBotSettings();
        return;
      }
      selectBot(bot.id);
      cursor = items.findIndex(x => x.id === bot.id);
      toggleFan(false);
    };
    wireBotGesture(element, bot.id);
    actions.append(element);
  }
  if (!drag) cursor = Math.max(0, items.findIndex(b => b.id === activeId));
  layout();
}

function toggleFan(open: boolean): void {
  if (!open) cursor = Math.max(0, items.findIndex(b => b.id === activeId));
  fan.classList.toggle('is-open', open);
  messagesEl.classList.toggle('picker-open', open);
  trigger.setAttribute('aria-expanded', String(open));
  trigger.setAttribute('aria-label', open ? 'Fermer le choix des bots' : 'Choisir un autre bot');
  wheel.tabIndex = open ? 0 : -1;
  layout();
}

function settle(): void {
  cursor = Math.round(cursor);
  const i = ((cursor % items.length) + items.length) % items.length;
  const item = items[i];
  if (item) selectBot(item.id);
  layout();
}

function finishDrag(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.id) return;
  const moved = drag.moved;
  const velocity = performance.now() - drag.lastTime < 100 ? drag.velocity : 0;
  drag = null;
  wheel.classList.remove('dragging');
  if (moved) {
    suppressClick = true;
    cursor -= Math.max(-0.65, Math.min(0.65, velocity * 0.22));
    settle();
    setTimeout(() => { suppressClick = false; }, 250);
  }
}

function wireBotGesture(element: HTMLButtonElement, botId: string): void {
  let timer: number | null = null;
  let origin: { x: number; y: number; id: number } | null = null;
  let held = false;
  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  element.addEventListener('pointerdown', e => {
    if (e.button !== 0 || botId !== activeId || fan.classList.contains('is-open')) return;
    origin = { x: e.clientX, y: e.clientY, id: e.pointerId };
    held = false;
    document.addEventListener('pointerup', () => {
      cancel();
      if (held) {
        held = false;
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 350);
      }
      origin = null;
    }, { once: true });
    timer = window.setTimeout(() => {
      timer = null;
      if (!origin) return;
      held = true;
      suppressClick = true;
      toggleFan(true);
      drag = { id: origin.id, x: origin.x, start: cursor, moved: false, lastX: origin.x, lastTime: performance.now(), velocity: 0 };
      try { wheel.setPointerCapture(origin.id); } catch { /* pointer already released */ }
    }, 460);
  });
  element.addEventListener('pointermove', e => {
    if (origin && Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 9 && !held) cancel();
  });
  element.addEventListener('pointerup', () => {
    cancel();
    origin = null;
    if (held) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 350);
    }
  });
  element.addEventListener('pointercancel', () => {
    cancel();
    origin = null;
  });
  element.addEventListener('contextmenu', e => e.preventDefault());
  element.addEventListener('pointerleave', () => {
    if (!held) cancel();
  });
}

trigger.onclick = () => toggleFan(!fan.classList.contains('is-open'));
wheel.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !fan.classList.contains('is-open')) return;
  drag = { id: e.pointerId, x: e.clientX, start: cursor, moved: false, lastX: e.clientX, lastTime: performance.now(), velocity: 0 };
  suppressClick = false;
});
wheel.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  if (Math.abs(dx) > 5 && !drag.moved) {
    drag.moved = true;
    wheel.setPointerCapture(e.pointerId);
    wheel.classList.add('dragging');
  }
  if (drag.moved) {
    const now = performance.now();
    const dt = Math.max(1, now - drag.lastTime);
    drag.velocity = drag.velocity * 0.45 + ((e.clientX - drag.lastX) / dt) * 0.55;
    drag.lastX = e.clientX;
    drag.lastTime = now;
    cursor = drag.start - dx / 85;
    layout();
  }
});
wheel.addEventListener('pointerup', finishDrag);
wheel.addEventListener('pointercancel', finishDrag);
wheel.addEventListener('lostpointercapture', finishDrag);
wheel.addEventListener('keydown', e => {
  if (!fan.classList.contains('is-open')) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      toggleFan(true);
    }
    return;
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    cursor += e.key === 'ArrowRight' ? 1 : -1;
    settle();
  }
  if (e.key === 'Enter' && e.target === wheel) {
    e.preventDefault();
    const i = ((Math.round(cursor) % items.length) + items.length) % items.length;
    const child = actions.children[i];
    if (child instanceof HTMLButtonElement) child.click();
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !newBotDialog.open && fan.classList.contains('is-open')) {
    toggleFan(false);
    const pressed = actions.querySelector('[aria-pressed="true"]');
    if (pressed instanceof HTMLElement) pressed.focus();
  }
});
document.addEventListener('click', e => {
  if (e.target instanceof Node && !fan.contains(e.target) && !newBotDialog.contains(e.target) && !newBotDialog.open) toggleFan(false);
});
window.addEventListener('resize', layout);

function renderPicker(): void {
  const signature = JSON.stringify(bots().map(b => [b.id, b.name, b.shape, b.color]));
  if (signature !== pickerSignature && !drag) {
    pickerSignature = signature;
    populate();
  } else {
    layout();
  }
  for (const child of actions.children) {
    if (!(child instanceof HTMLElement) || !child.dataset.botId) continue;
    const presence = botPresence(child.dataset.botId);
    if (presence) child.dataset.presence = presence;
    else delete child.dataset.presence;
  }
  applyBotIdentity();
}

// Dialogs.
function openPlay(title: string, body: string, setup?: () => void, sheetClass?: string): void {
  if (playDialog.open) playDialog.close();
  playContent.innerHTML = `<div class="play-heading"><h2>${escapeMarkup(title)}</h2><button type="button" class="play-close" aria-label="Fermer">×</button></div>${body}`;
  const close = playContent.querySelector('.play-close');
  if (close instanceof HTMLButtonElement) close.onclick = () => playDialog.close();
  playDialog.className = 'bot-dialog play-dialog' + (sheetClass ? ' ' + sheetClass : '');
  delete playDialog.dataset.botId;
  delete playDialog.dataset.workId;
  setup?.();
  playDialog.showModal();
}

function openActions(title: string, list: [string, () => void][]): void {
  openPlay(title, '<div class="action-list">' + list.map(([label], i) => `<button type="button" data-play-action="${i}">${escapeMarkup(label)}</button>`).join('') + '</div>', () => {
    playContent.querySelectorAll<HTMLButtonElement>('[data-play-action]').forEach(b => {
      b.onclick = () => {
        playDialog.close();
        list[Number(b.dataset.playAction)]?.[1]();
      };
    });
  });
}

function q<T extends HTMLElement>(selector: string, type: new () => T): T {
  const element = playContent.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`Élément manquant: ${selector}`);
  return element;
}

let renameTimer: number | undefined;

function showBotSettings(botId = activeId): void {
  toggleFan(false);
  const bot = botById(botId);
  if (!bot) return;
  const colorButtons = mascots.colors.map(c => `<button type="button" class="character-swatch" data-character-color="${c}" style="--swatch:${c}" aria-label="Couleur ${c}"></button>`).join('');
  const shapeButtons = mascots.shapes.map(s => `<button type="button" class="shape-choice" data-character-shape="${escapeMarkup(s.id)}" aria-label="Forme ${escapeMarkup(s.label)}"><svg aria-hidden="true" viewBox="0 0 100 90"><use href="#profile-${escapeMarkup(s.id)}"/></svg></button>`).join('');
  openPlay('Personnaliser le bot', `<div class="character-nav"><button type="button" id="character-back" class="character-round" aria-label="Retour à la conversation">‹</button><span>Votre bot</span><button type="button" id="character-more" class="character-round" aria-label="Options du bot">···</button></div>
<div class="character-portrait" id="character-portrait"><svg id="character-svg" viewBox="0 0 100 90" aria-hidden="true"><use/></svg></div>
<div class="character-group character-identity"><input id="character-name" aria-label="Nom du bot" maxlength="24" placeholder="Nom du bot"><input id="character-title" aria-label="Titre du bot, facultatif" maxlength="60" placeholder="Titre, facultatif"></div>
<label class="character-section">Personnage</label>
<div class="character-group"><div class="character-colors">${colorButtons}</div><div class="character-shapes">${shapeButtons}</div><button type="button" id="character-reset" class="character-reset">Rétablir par défaut</button></div>
<button type="button" class="character-row character-group" id="character-ai"><span class="character-row-icon"><svg aria-hidden="true"><use href="#sliders"/></svg></span><span>Intelligence</span><span class="character-row-note" id="character-ai-note"></span><span class="character-chevron">›</span></button>
<button type="button" class="character-row character-group" id="character-replies"><span>Réponses</span><span class="character-row-note" id="character-replies-note"></span><span class="character-chevron">›</span></button>
<button type="button" class="character-row character-group bot-memory-row" id="character-memory"><span>Mémoire</span><span class="character-row-note" id="character-memory-note"></span><span class="character-chevron">›</span></button>
<p class="character-save-note" id="character-save-note">Enregistrement automatique</p>`, () => {
    const nameInput = q('#character-name', HTMLInputElement);
    const titleInput = q('#character-title', HTMLInputElement);
    nameInput.value = bot.name;
    titleInput.value = bot.title;
    const save = (patch: { name?: string; title?: string; shape?: string; color?: string; reset?: true }) => {
      void dispatch({ type: 'bot.update', botId, ...patch }).then(() => refreshCharacter(botId));
    };
    const saveText = () => {
      clearTimeout(renameTimer);
      const name = nameInput.value.trim();
      const current = botById(botId);
      if (!current) return;
      const patch: { name?: string; title?: string } = {};
      if (name && name !== current.name) patch.name = name;
      if (titleInput.value.trim() !== current.title) patch.title = titleInput.value.trim();
      if (patch.name !== undefined || patch.title !== undefined) save(patch);
    };
    nameInput.oninput = titleInput.oninput = () => {
      clearTimeout(renameTimer);
      renameTimer = window.setTimeout(saveText, 500);
    };
    nameInput.onblur = () => {
      saveText();
      nameInput.value = nameInput.value.trim() || (botById(botId)?.name ?? '');
    };
    titleInput.onblur = saveText;
    playContent.querySelectorAll<HTMLButtonElement>('[data-character-color]').forEach(b => {
      b.onclick = () => save({ color: b.dataset.characterColor ?? '' });
    });
    playContent.querySelectorAll<HTMLButtonElement>('[data-character-shape]').forEach(b => {
      const shape = mascots.shapes.find(s => s.id === b.dataset.characterShape);
      if (shape) b.onclick = () => save({ shape: shape.id, color: shape.defaultColor });
    });
    q('#character-reset', HTMLButtonElement).onclick = () => {
      save({ reset: true });
      toast('Personnage réinitialisé');
    };
    q('#character-back', HTMLButtonElement).onclick = () => playDialog.close();
    q('#character-ai', HTMLButtonElement).onclick = () => showModelSheet(botId);
    q('#character-memory', HTMLButtonElement).onclick = () => showMemory(botId);
    q('#character-replies', HTMLButtonElement).onclick = () => showReplySettings(botId);
    q('#character-more', HTMLButtonElement).onclick = () => {
      openActions(bot.name, [
        ['Revenir à la personnalisation', () => showBotSettings(botId)],
        ['Choisir un autre bot', () => { toggleFan(true); wheel.focus(); }],
        ['Créer un nouveau bot', openNewBot],
        ['Supprimer définitivement…', () => showDeleteBot(botId)],
      ]);
      playDialog.dataset.botId = botId;
    };
    refreshCharacter(botId);
  }, 'character-sheet');
  playDialog.dataset.botId = botId;
}

function refreshCharacter(botId: string): void {
  const bot = botById(botId);
  const svg = playContent.querySelector('#character-svg');
  if (!bot || !(svg instanceof SVGSVGElement)) return;
  svg.style.setProperty('--bot-color', bot.color);
  svg.querySelector('use')?.setAttribute('href', `#profile-${bot.shape}`);
  playContent.querySelectorAll<HTMLButtonElement>('[data-character-color]').forEach(b => {
    const on = b.dataset.characterColor === bot.color;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-pressed', String(on));
  });
  playContent.querySelectorAll<HTMLButtonElement>('[data-character-shape]').forEach(b => {
    const on = b.dataset.characterShape === bot.shape;
    b.classList.toggle('selected', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const aiNote = playContent.querySelector('#character-ai-note');
  if (aiNote) aiNote.textContent = choiceLabel(bot.choice);
  const memoryNote = playContent.querySelector('#character-memory-note');
  if (memoryNote) {
    memoryNote.textContent = bot.memoryScope ? `Honcho · ${bot.memoryScope.label}`
      : `${bot.memories.length} souvenir${bot.memories.length > 1 ? 's' : ''}${bot.memoryChars > LIMITS.memoryTotalChars ? ' · trop longue' : ''}`;
  }
  const repliesNote = playContent.querySelector('#character-replies-note');
  if (repliesNote) repliesNote.textContent = `${REPLY_STYLE_LABELS[bot.replyStyle]} · contexte ${CONTEXT_SIZE_LABELS[bot.contextSize].toLocaleLowerCase('fr')}${bot.instructions ? ' · consignes' : ''}`;
}

function showMemory(botId: string): void {
  const bot = botById(botId);
  if (!bot) return;
  if (bot.memoryScope) {
    openPlay(`Mémoire de ${bot.name}`, `<p>${escapeMarkup(bot.name)} utilise la mémoire Honcho, projet « ${escapeMarkup(bot.memoryScope.label)} ». Ses souvenirs locaux ne sont plus envoyés.</p>
<p class="secondary-note">Ses déclarations, leur correction, l’exclusion et l’oubli se gèrent dans l’interface principale d’EzraBot, sur cet ordinateur, dans la page du personnage.</p>
<div class="dialog-buttons"><button id="memory-back" type="button">Retour au bot</button></div>`, () => {
      q('#memory-back', HTMLButtonElement).onclick = () => showBotSettings(botId);
    });
    return;
  }
  const rows = bot.memories.length
    ? bot.memories.map(m => `<div><input data-memory-id="${escapeMarkup(m.id)}" maxlength="500" aria-label="Souvenir" value="${escapeMarkup(m.text)}"><button type="button" data-forget="${escapeMarkup(m.id)}" aria-label="Oublier ce souvenir">×</button></div>`).join('')
    : '<p class="secondary-note">Par exemple : « Je préfère des réponses courtes. »</p>';
  openPlay(`Mémoire de ${bot.name}`, `<p>Ce que ${escapeMarkup(bot.name)} garde pour vos prochaines demandes. Les autres bots ne la voient pas.</p>
<div class="memory-list">${rows}</div>
<p class="secondary-note${bot.memoryChars > LIMITS.memoryTotalChars ? ' memory-over' : ''}">${bot.memoryChars} / ${LIMITS.memoryTotalChars} caractères${bot.memoryChars > LIMITS.memoryTotalChars ? '. Cette mémoire dépasse la limite : tout est encore envoyé, mais il faut raccourcir ou retirer un souvenir avant d’en ajouter.' : ''}</p>
<form class="memory-add" id="memory-add"><input id="memory-new" maxlength="500" placeholder="Ajouter un souvenir…" aria-label="Nouveau souvenir"><button type="submit">Retenir</button></form>
<p class="secondary-note">Un changement vaut pour les prochaines demandes. Les réponses déjà écrites et un appel en cours ne changent pas.</p>
<div class="dialog-buttons"><button id="memory-back" type="button">Retour au bot</button></div>`, () => {
    q('#memory-back', HTMLButtonElement).onclick = () => showBotSettings(botId);
    q('#memory-add', HTMLFormElement).onsubmit = e => {
      e.preventDefault();
      const text = q('#memory-new', HTMLInputElement).value.trim();
      if (!text) return;
      void dispatch({ type: 'memory.create', botId, text }).then(sent => { if (sent.ok) showMemory(botId); });
    };
    playContent.querySelectorAll<HTMLInputElement>('[data-memory-id]').forEach(input => {
      input.onchange = () => {
        const text = input.value.trim();
        const memoryId = input.dataset.memoryId ?? '';
        if (!text) {
          input.value = botById(botId)?.memories.find(m => m.id === memoryId)?.text ?? '';
          return;
        }
        void dispatch({ type: 'memory.update', botId, memoryId, text }).then(sent => { if (sent.ok) toast('Souvenir mis à jour'); });
      };
    });
    playContent.querySelectorAll<HTMLButtonElement>('[data-forget]').forEach(b => {
      b.onclick = () => {
        void dispatch({ type: 'memory.delete', botId, memoryId: b.dataset.forget ?? '' }).then(sent => { if (sent.ok) showMemory(botId); });
      };
    });
  });
  playDialog.dataset.botId = botId;
}

function segmented<T extends string>(holder: HTMLElement, labels: Record<T, string>, current: () => T, pick: (value: T) => void): void {
  const values = Object.keys(labels).filter((key): key is T => key in labels);
  holder.replaceChildren(...values.map(value => {
    const b = button(labels[value], () => {
      pick(value);
      segmented(holder, labels, current, pick);
    });
    b.setAttribute('aria-pressed', String(value === current()));
    return b;
  }));
}

function showReplySettings(botId: string): void {
  const bot = botById(botId);
  if (!bot) return;
  const draft = { instructions: bot.instructions, replyStyle: bot.replyStyle, contextSize: bot.contextSize };
  openPlay('Ses réponses', `<div class="ai-head"><button type="button" class="ai-back" id="replies-back" aria-label="Retour">‹</button><span id="replies-mascot"></span><strong>${escapeMarkup(bot.name)}</strong></div>
<label class="ai-label" for="replies-instructions">Consignes permanentes</label>
<textarea id="replies-instructions" maxlength="${LIMITS.botInstructionsChars}" placeholder="Ex. Tutoie-moi et utilise des exemples."></textarea>
<p class="ai-note" id="replies-count"></p>
<label class="ai-label" id="replies-style-label">Longueur des réponses</label><div class="ai-pace" id="replies-style" role="group" aria-labelledby="replies-style-label"></div>
<p class="ai-note">Concises : directes, sans formules. Un contenu demandé reste complet.</p>
<label class="ai-label" id="replies-size-label">Contexte</label><div class="ai-pace" id="replies-size" role="group" aria-labelledby="replies-size-label"></div>
<p class="ai-note">Échanges passés relus à chaque demande. Les coupes sont signalées.</p>
<button type="button" id="replies-save" class="ai-main">Enregistrer</button>`, () => {
    q('#replies-mascot', HTMLElement).append(mascot(bot));
    q('#replies-back', HTMLButtonElement).onclick = () => showBotSettings(botId);
    const instructions = q('#replies-instructions', HTMLTextAreaElement);
    const count = q('#replies-count', HTMLParagraphElement);
    instructions.value = draft.instructions;
    const counter = () => { count.textContent = `${instructions.value.length} / ${LIMITS.botInstructionsChars} caractères · propres à ce bot.`; };
    instructions.oninput = () => {
      draft.instructions = instructions.value;
      counter();
    };
    counter();
    segmented(q('#replies-style', HTMLDivElement), REPLY_STYLE_LABELS, () => draft.replyStyle, value => { draft.replyStyle = value; });
    segmented(q('#replies-size', HTMLDivElement), CONTEXT_SIZE_LABELS, () => draft.contextSize, value => { draft.contextSize = value; });
    const save = q('#replies-save', HTMLButtonElement);
    save.onclick = () => {
      save.disabled = true;
      void dispatch({ type: 'bot.update', botId, instructions: draft.instructions.trim(), replyStyle: draft.replyStyle, contextSize: draft.contextSize }).then(sent => {
        save.disabled = false;
        if (!sent.ok) return;
        toast('Réglage enregistré pour les prochaines demandes');
        showBotSettings(botId);
      });
    };
  }, 'ai-sheet');
  playDialog.dataset.botId = botId;
}

function showModelSheet(botId: string): void {
  const bot = botById(botId);
  if (!bot) return;
  const engine = view?.engine;
  const list = models();
  const draft: BotChoice = { ...bot.choice };
  openPlay('Son intelligence.', `<div class="ai-head"><button type="button" class="ai-back" id="ai-back" aria-label="Retour">‹</button><span id="ai-mascot"></span><strong>${escapeMarkup(bot.name)}</strong></div>
<p class="ai-lede">Codex sur cet ordinateur, avec votre session ChatGPT. Aucune clé API.</p>
<label class="ai-label" for="ai-model">Modèle</label><select id="ai-model"></select>
<label class="ai-label" for="ai-effort">Effort de raisonnement</label><select id="ai-effort"></select>
<label class="ai-label">Vitesse</label><div class="ai-pace" id="ai-pace"></div>
<div class="ai-preview"><small>RÉGLAGE ENREGISTRÉ</small><strong id="ai-result-model"></strong><p id="ai-result-reason">Codex annonce ces options. Seule une vraie réponse confirme que votre compte y a accès ; Mino ne change jamais de modèle à votre place.</p></div>
<p id="ai-test-status" class="ai-note" role="status">${engine?.state === 'unavailable' ? escapeMarkup(engine.message) : engine?.state === 'starting' ? 'Connexion à Codex…' : ''}</p>
<button type="button" id="ai-save" class="ai-text-button">Enregistrer ce réglage</button>`, () => {
    q('#ai-mascot', HTMLElement).append(mascot(bot));
    q('#ai-back', HTMLButtonElement).onclick = () => showBotSettings(botId);
    const modelSelect = q('#ai-model', HTMLSelectElement);
    const effortSelect = q('#ai-effort', HTMLSelectElement);
    const pace = q('#ai-pace', HTMLDivElement);
    const saveButton = q('#ai-save', HTMLButtonElement);
    const fallback = list.find(m => m.isDefault);
    modelSelect.append(new Option(`Par défaut de Codex${fallback ? ' · ' + fallback.displayName : ''}`, ''));
    for (const model of list) modelSelect.append(new Option(model.displayName, model.id));
    if (draft.model && !list.some(m => m.id === draft.model)) modelSelect.append(new Option(`${draft.model} (plus proposé)`, draft.model));
    modelSelect.value = draft.model ?? '';
    const sync = () => {
      const model = draft.model === null ? fallback : list.find(m => m.id === draft.model);
      effortSelect.replaceChildren(new Option(`Par défaut du modèle${model ? ' · ' + (EFFORT_LABELS[model.defaultEffort] ?? model.defaultEffort) : ''}`, ''));
      for (const effort of model?.efforts ?? []) effortSelect.append(new Option(EFFORT_LABELS[effort] ?? effort, effort));
      if (draft.effort && !model?.efforts.includes(draft.effort)) draft.effort = null;
      effortSelect.value = draft.effort ?? '';
      const speeds = [{ id: 'standard', name: 'Standard', description: 'Vitesse habituelle' }, ...(model?.speeds ?? [])];
      if (!speeds.some(s => s.id === draft.speed)) draft.speed = 'standard';
      pace.replaceChildren(...speeds.map(speed => {
        const b = button(speed.name, () => { draft.speed = speed.id; sync(); });
        b.title = speed.description;
        b.setAttribute('aria-pressed', String(speed.id === draft.speed));
        return b;
      }));
      q('#ai-result-model', HTMLElement).textContent = choiceLabel(botById(botId)?.choice ?? draft);
      const ready = engine?.state === 'ready';
      modelSelect.disabled = effortSelect.disabled = saveButton.disabled = !ready;
    };
    modelSelect.onchange = () => {
      draft.model = modelSelect.value || null;
      draft.effort = null;
      sync();
    };
    effortSelect.onchange = () => {
      draft.effort = effortSelect.value || null;
    };
    saveButton.onclick = () => {
      void dispatch({ type: 'bot.configure', botId, model: draft.model, effort: draft.effort, speed: draft.speed }).then(sent => {
        if (!sent.ok) return;
        toast('Réglage enregistré pour les prochaines demandes');
        sync();
      });
    };
    sync();
  }, 'ai-sheet');
  playDialog.dataset.botId = botId;
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Lists exactly what goes and what stays, from the counters the server will check again. */
function showDeleteBot(botId: string, notice = '', typed = ''): void {
  const bot = botById(botId);
  if (!bot) return;
  const c = bot.deletion;
  const busy = view?.works.some(w => (w.botId === botId || w.threadBotId === botId) && w.state === 'running') ?? false;
  const erased = [
    `Sa conversation : ${plural(c.messages, 'message', 'messages')}, ${plural(c.files, 'fichier joint', 'fichiers joints')}, ${plural(c.deliverables, 'livrable', 'livrables')} avec toutes leurs versions et ${plural(c.publications, 'publication', 'publications')} du Carnet issues de ce fil, y compris les réponses des invités.`,
    `Sa mémoire (${plural(c.memories, 'souvenir', 'souvenirs')}), ses consignes, son apparence et ses réglages.`,
    ...(c.waiting ? [`${plural(c.waiting, 'demande en attente sera annulée', 'demandes en attente seront annulées')}.`] : []),
    'Les brouillons de cette conversation dans ce navigateur, y compris dans vos autres onglets ouverts.',
    'La sauvegarde automatique faite par Mino lors de sa dernière mise à jour. Elle contient tout votre espace, pas seulement ce bot.',
  ];
  const kept = [
    ...(c.keptReplies || c.keptDeliverables ? [`${plural(c.keptReplies, 'réponse', 'réponses')} et ${plural(c.keptDeliverables, 'livrable', 'livrables')} donnés comme invité dans d’autres conversations restent identiques, signés « ${DELETED_BOT_NAME} ».`] : []),
    ...(c.keptMentions ? [`Dans ${plural(c.keptMentions, 'message envoyé', 'messages envoyés')} ailleurs, la mention @${bot.name} reste en texte, inactive.`] : []),
  ];
  const items = (list: string[]) => '<ul class="delete-list">' + list.map(item => `<li>${escapeMarkup(item)}</li>`).join('') + '</ul>';
  openPlay('Supprimer définitivement', `<div class="delete-head"><span id="delete-mascot"></span><span><strong>${escapeMarkup(bot.name)}</strong><small>${escapeMarkup(bot.title ? bot.title + ' · ' : '')}#${escapeMarkup(bot.id.slice(-6))}</small></span></div>
<p class="delete-lede">Après confirmation, rien ne pourra être restauré.</p>
<h3 class="delete-section">Effacé</h3>${items(erased)}
<h3 class="delete-section">Conservé ailleurs</h3>${kept.length ? items(kept) : '<p class="secondary-note">Rien : ce bot n’a pas participé à d’autres conversations.</p>'}
<p class="secondary-note">Mino ne peut pas effacer ce qui a déjà été envoyé au service d’IA, ni vos exports et copies hors de Mino. L’effacement physique du disque n’est pas garanti.</p>
<label for="delete-confirm">Pour confirmer, tapez son nom : <strong>${escapeMarkup(bot.name)}</strong></label>
<input id="delete-confirm" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="60">
<p id="delete-status" class="delete-status" role="status"></p>
<div class="dialog-buttons"><button type="button" id="delete-cancel">Annuler</button><button type="button" id="delete-go" class="confirm">Supprimer définitivement</button></div>`, () => {
    q('#delete-mascot', HTMLElement).append(mascot(bot));
    const input = q('#delete-confirm', HTMLInputElement);
    const go = q('#delete-go', HTMLButtonElement);
    const status = q('#delete-status', HTMLParagraphElement);
    status.textContent = busy ? 'Un appel lié à ce bot est en cours. Arrêtez-le et attendez la fin avant de supprimer.' : notice;
    input.value = typed;
    const sync = () => { go.disabled = busy || input.value.trim() !== bot.name; };
    input.oninput = sync;
    sync();
    q('#delete-cancel', HTMLButtonElement).onclick = () => showBotSettings(botId);
    go.onclick = () => {
      go.disabled = true;
      status.textContent = 'Suppression et nettoyage en cours…';
      void dispatch({ type: 'bot.delete', botId, confirmName: input.value.trim(), expected: c }).then(sent => {
        if (sent.ok && sent.result.kind === 'botDeleted') {
          if (playDialog.open && playDialog.dataset.botId === botId) playDialog.close();
          toast(sent.result.erased ? `${bot.name} est supprimé définitivement.` : `${bot.name} est supprimé, mais le nettoyage des copies de Mino n’est pas terminé.`);
          return;
        }
        if (!botById(botId)) return;
        showDeleteBot(botId, sent.ok ? '' : sent.message, input.value);
      });
    };
    requestAnimationFrame(() => input.focus());
  }, 'delete-sheet');
  playDialog.dataset.botId = botId;
}

function openNewBot(): void {
  newBotForm.reset();
  newBotDialog.showModal();
}

byId('fixed-create', HTMLButtonElement).onclick = openNewBot;
byId('empty-create', HTMLButtonElement).onclick = openNewBot;
byId('cancel-bot', HTMLButtonElement).onclick = () => newBotDialog.close();
newBotName.oninput = () => newBotName.setCustomValidity('');
newBotForm.onsubmit = e => {
  e.preventDefault();
  const name = newBotName.value.trim();
  if (!name) {
    newBotName.setCustomValidity('Choisissez un nom.');
    newBotName.reportValidity();
    return;
  }
  const role = ROLE_TITLES[byId('new-bot-role', HTMLSelectElement).value] ?? { title: '', shape: 'sprout' };
  const color = byId('new-bot-color', HTMLInputElement).value.toLowerCase();
  void dispatch({ type: 'bot.create', name, title: role.title, shape: role.shape, color }).then(sent => {
    if (!sent.ok || sent.result.kind !== 'bot') return;
    newBotDialog.close();
    selectBot(sent.result.botId);
    renderPicker();
    toggleFan(true);
    wheel.focus();
    toast('Bot créé');
  });
};

// Thread.
function workById(id: string): WorkView | undefined {
  return view?.works.find(w => w.id === id);
}

function currentVersion(work: WorkView): VersionView | undefined {
  return work.versions[work.versions.length - 1];
}

function intro(bot: BotView | undefined, detail: string, botId = ''): HTMLDivElement {
  const element = make('div', 'intro');
  if (bot) element.append(mascot(bot, 'bot-inline'));
  element.append(make('strong', '', bot?.name ?? botName(botId)), make('span', '', detail));
  return element;
}

function userElement(message: MessageView): HTMLElement {
  const element = make('div', 'user-message');
  element.dataset.role = 'user';
  const bot = botById(message.botId);
  element.setAttribute('aria-label', `Votre message à ${bot?.name ?? 'un bot'}`);
  const text = make('span', 'message-text');
  let at = 0;
  for (const span of message.mentions) {
    const tag = message.text.slice(span.start, span.end);
    const inert = make('span', 'mention-tag mention-retired', tag);
    inert.title = `${DELETED_BOT_NAME} · mention inactive`;
    text.append(message.text.slice(at, span.start), botById(span.botId) ? button(tag, () => showBotSettings(span.botId), 'mention-tag') : inert);
    at = span.end;
  }
  text.append(message.text.slice(at));
  element.append(text);
  element.title = formatDate(message.createdAt);
  if (message.attachments.length) {
    const grid = make('div', 'sent-assets');
    for (const file of message.attachments) {
      const chip = make('span', 'sent-asset');
      chip.append(make('span', 'sent-asset-icon', '¶'), make('span', '', file.name));
      chip.title = `${file.chars} caractères envoyés à ${bot?.name ?? 'ce bot'}`;
      grid.append(chip);
    }
    element.append(grid);
  }
  return element;
}

const htmlModes = new Map<string, 'preview' | 'code'>();
playDialog.addEventListener('close', () => {
  if (!playDialog.open) playContent.querySelectorAll('iframe').forEach(frame => frame.remove());
});

function htmlFrame(resource: string, title: string): HTMLIFrameElement {
  const frame = make('iframe', 'html-preview');
  frame.title = `Aperçu de ${title}`;
  frame.sandbox.add('allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  frame.loading = 'lazy';
  frame.src = `${resource}/preview`;
  return frame;
}

function openHtml(resource: string, title: string, workId?: string): void {
  openPlay(title, '<div id="html-large"></div><p class="secondary-note">Aperçu local : les connexions et ressources externes sont désactivées.</p>', () => {
    q('#html-large', HTMLDivElement).append(htmlFrame(resource, title));
  }, 'html-sheet');
  if (workId) playDialog.dataset.workId = workId;
}

function htmlView(options: { resource: string; title: string; source: HTMLElement; key: string; workId?: string; onPreview?: () => void }): HTMLElement {
  const holder = make('div', 'html-artifact-view');
  const toolbar = make('div', 'html-toolbar');
  const tabs = make('div', 'html-tabs');
  tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Affichage du document HTML');
  const previewPanel = make('div', 'html-preview-panel');
  const codePanel = make('div', 'html-code-panel'); codePanel.append(options.source);
  const preview = button('Aperçu', () => show('preview', true), 'html-tab');
  const code = button('Code', () => show('code'), 'html-tab');
  function show(mode: 'preview' | 'code', requested = false): void {
    htmlModes.set(options.key, mode);
    previewPanel.hidden = mode !== 'preview'; codePanel.hidden = mode !== 'code';
    preview.setAttribute('aria-pressed', String(mode === 'preview')); code.setAttribute('aria-pressed', String(mode === 'code'));
    if (mode === 'preview') {
      if (!previewPanel.childElementCount) previewPanel.append(htmlFrame(options.resource, options.title));
      if (requested) options.onPreview?.();
    }
  }
  tabs.append(preview, code);
  const actions = make('div', 'html-tools');
  actions.append(button('Agrandir', () => openHtml(options.resource, options.title, options.workId)),
    button('Télécharger HTML', () => download(`${options.resource}/download`)));
  toolbar.append(tabs, actions);holder.append(toolbar, previewPanel, codePanel);
  show(htmlModes.get(options.key) ?? 'preview');
  return holder;
}

function assistantElement(message: MessageView): HTMLElement {
  const bot = botById(message.botId);
  const element = make('div', 'assistant-message');
  element.dataset.role = 'assistant';
  element.setAttribute('aria-label', `Message de ${botName(message.botId, 'votre bot')}`);
  element.append(intro(bot, '', message.botId));
  if (message.taskStep) element.append(stepTag(message.taskStep, message.workId));
  const work = workById(message.workId);
  if (htmlDocument(message.text) && !work?.versions.some(v => htmlDocument(v.body))) {
    element.append(htmlView({resource:`/api/messages/${message.id}`,title:'la création HTML',source:markdown(message.text),key:`message:${message.id}`,workId:message.workId}));
  } else element.append(markdown(message.text));
  if (message.handoff && message.botId === 'mino' && message.threadBotId === 'mino') {
    element.append(chatMissions.card(message));
  }
  element.title = formatDate(message.createdAt);
  const actions = make('div', 'message-actions');
  actions.append(button('Copier', () => {
    void navigator.clipboard.writeText(message.text).then(() => toast('Copié'),
      () => toast('Copie impossible ici : sélectionnez le texte pour le copier.'));
  }, 'message-copy'));
  if (message.stamp) {
    const details = make('details', 'message-details');
    const stamp = make('small', 'ai-resolved', stampLabel(message.stamp));
    stamp.title = `Fil Codex ${message.stamp.threadId} · tour ${message.stamp.turnId}`;
    element.dataset.model = message.stamp.model;
    element.dataset.threadId = message.stamp.threadId;
    element.dataset.turnId = message.stamp.turnId;
    details.append(make('summary', '', 'Détails'), stamp);
    actions.append(details);
  }
  element.append(actions);
  return element;
}

function statusElement(work: WorkView): HTMLElement {
  const bot = botById(work.botId);
  const element = make('div', 'assistant-message run-status');
  element.dataset.workState = work.state;
  const controls = make('div', 'run-actions');
  if (work.state === 'pending' || work.state === 'running') {
    const busyElsewhere = work.state === 'pending' && view?.works.some(w => w.state === 'running' && w.id !== work.id);
    const detail = work.state === 'running'
      ? STAGE_LABELS[work.attempt?.stage ?? 'starting']
      : busyElsewhere ? 'En attente · un autre travail passe avant' : 'En attente';
    element.dataset.presence = work.state === 'pending' ? 'pending' : work.attempt?.stage ?? 'starting';
    const dots = make('span', 'presence-dots');
    dots.setAttribute('aria-hidden', 'true');
    dots.append(make('i'), make('i'), make('i'));
    element.append(intro(bot, detail, work.botId), dots);
    element.setAttribute('aria-label', `${botName(work.botId, 'Votre bot')} : ${detail}`);
    controls.append(button(work.state === 'running' ? 'Arrêter' : 'Annuler', () => void dispatch({ type: 'work.cancel', workId: work.id })));
  } else if (work.state === 'failed') {
    element.classList.add('run-failed');
    element.append(intro(bot, 'Échec', work.botId), make('span', '', work.attempt?.error ?? 'L’appel a échoué.'));
    if (bot) controls.append(button('Relancer', () => void dispatch({ type: 'work.retry', workId: work.id })));
  } else {
    element.classList.add('run-cancelled');
    element.append(intro(bot, 'Annulé', work.botId), make('span', '', bot ? 'Arrêté à votre demande. Aucune réponse n’a été enregistrée.'
      : 'Ce bot a été supprimé. Aucune réponse n’a été enregistrée et ce travail ne peut plus être relancé.'));
    if (bot) controls.append(button('Relancer', () => void dispatch({ type: 'work.retry', workId: work.id })));
  }
  element.append(controls);
  return element;
}

function hashLabel(hash: string): string {
  return `${hash.slice(0, 12)}…${hash.slice(-6)}`;
}

function proposalCallout(proposal: ProposalView): HTMLElement {
  const callout = make('div', 'approval-callout');
  callout.append(make('strong', '', 'Publier cette version dans le Carnet local ?'));
  const facts = make('dl', 'approval-facts');
  const fact = (term: string, value: string) => facts.append(make('dt', '', term), make('dd', '', value));
  fact('Action exacte', 'Publier une copie figée de ce livrable');
  fact('Destination', 'Carnet local de Mino, sur cet ordinateur. Rien n’est envoyé.');
  fact('Version', `Version ${proposal.versionN}`);
  fact('Empreinte', hashLabel(proposal.payloadSha256));
  facts.lastElementChild?.setAttribute('title', proposal.payloadSha256);
  callout.append(facts, make('small', '', 'Contenu intégral'), make('div', 'approval-content', `${proposal.title}\n\n${proposal.body}`));
  callout.append(make('small', '', 'Une modification ou une restauration annule cette proposition.'));
  callout.dataset.proposalId = proposal.id;
  return callout;
}

function cardElement(work: WorkView): HTMLElement {
  const version = currentVersion(work);
  const bot = botById(work.botId);
  const element = make('div', 'assistant-message artifact-message');
  if (!version) return element;
  element.dataset.workId = work.id;
  const article = make('article', 'natural-card');
  const html = htmlDocument(version.body);
  const heading = make('div', 'natural-card-heading', html ? 'Page HTML' : 'Livrable');
  heading.append(make('span', `work-card-status status-${STATE_CLASSES[work.state]}`, STATE_LABELS[work.state]));
  const content = make('div', 'natural-card-content');
  const title = make('input', 'card-title-input');
  title.value = version.title;
  title.maxLength = 200;
  title.setAttribute('aria-label', 'Titre du livrable');
  const editor = make('textarea', 'draft-editor');
  editor.value = version.body;
  editor.setAttribute('aria-label', 'Livrable modifiable');
  let base = version;
  let saving = false;
  let queued = false;
  let blocked = false;
  const scope = { kind: 'version', workId: work.id } as const;
  const saveNotice = make('div', 'card-note');
  saveNotice.hidden = true;
  const differs = () => title.value.trim() !== base.title || editor.value.trim() !== base.body;
  const keepDraft = () => {
    element.dataset.keepDraft = String(saving || blocked || differs());
  };
  const remember = (): Capture => {
    const capture = drafts.write(scope, { baseVersionId: base.id, title: title.value, body: editor.value });
    if (!differs() && !blocked) drafts.discard(scope);
    renderDraftStatus();
    return capture;
  };
  title.oninput = editor.oninput = () => {
    remember();
    keepDraft();
  };
  const saveEdit = () => {
    queued = true;
    if (saving || blocked) return;
    saving = true;
    keepDraft();
    void (async () => {
      try {
        while (queued && !blocked) {
          queued = false;
          const newTitle = title.value.trim();
          const newBody = editor.value.trim();
          if (!newTitle || !newBody) {
            blocked = true;
            showSaveRefusal('Le titre et le contenu sont nécessaires. Votre saisie reste ici.');
            break;
          }
          if (newTitle === base.title && newBody === base.body) continue;
          const capture = remember();
          const sent = await dispatch({ type: 'version.edit', workId: work.id, baseVersionId: base.id, title: newTitle, body: newBody });
          if (sent.ok && sent.result.kind === 'version') {
            base = { ...base, id: sent.result.versionId, n: sent.result.n, title: newTitle, body: newBody };
            if (!drafts.acknowledge(capture)) remember();
            saveNotice.hidden = true;
            toast(`Version ${base.n} enregistrée`);
          } else {
            blocked = true;
            showSaveRefusal(sent.ok ? 'Enregistrement non confirmé.' : sent.message);
          }
        }
      } finally {
        saving = false;
        keepDraft();
        renderThread();
      }
    })();
  };
  function showSaveRefusal(message: string): void {
    saveNotice.hidden = false;
    saveNotice.replaceChildren(make('p', '', `${message} Votre saisie n’est pas enregistrée et reste dans cette carte.`),
      button('Enregistrer ma saisie en nouvelle version', () => {
        const latestWork = workById(work.id);
        const latest = latestWork ? currentVersion(latestWork) : undefined;
        if (!latest) return;
        base = latest;
        blocked = false;
        remember();
        saveEdit();
      }),
      button('Abandonner ma saisie', () => {
        drafts.discard(scope);
        blocked = false;
        rebuildCard(element);
      }));
  }
  const restored = drafts.read(scope);
  if (restored && (restored.title !== version.title || restored.body !== version.body || restored.baseVersionId !== version.id)) {
    title.value = restored.title;
    editor.value = restored.body;
    blocked = true;
    const from = work.versions.find(v => v.id === restored.baseVersionId);
    showSaveRefusal(restored.baseVersionId === version.id
      ? 'Brouillon repris après rechargement.'
      : `Votre brouillon partait de la version ${from?.n ?? 'précédente'} ; la version ${version.n} est actuelle.`);
  }
  const othersNotice = make('div', 'card-note');
  const renderOthers = () => {
    const [other] = drafts.others(scope);
    othersNotice.hidden = !other;
    if (!other) return;
    const resume = button('Reprendre ce brouillon', () => {
      const adopted = drafts.adopt(scope, other.id);
      if (!adopted) return;
      title.value = adopted.title;
      editor.value = adopted.body;
      blocked = true;
      const from = work.versions.find(v => v.id === adopted.baseVersionId);
      showSaveRefusal(adopted.baseVersionId === base.id ? 'Brouillon repris d’un autre onglet.' : `Ce brouillon partait de la version ${from?.n ?? 'précédente'} ; la version ${base.n} est actuelle.`);
      keepDraft();
      renderOthers();
    });
    resume.disabled = differs() || blocked;
    if (resume.disabled) resume.title = 'Enregistrez ou abandonnez d’abord votre saisie.';
    othersNotice.replaceChildren(make('p', '', `Un autre onglet garde un brouillon de ce livrable (${formatTime(other.savedAt)}).`), resume,
      button('Ignorer', () => {
        drafts.dismiss(scope, other.id);
        renderOthers();
      }));
  };
  renderOthers();
  element.addEventListener('drafts-changed', renderOthers);
  title.onchange = saveEdit;
  editor.onchange = saveEdit;
  content.append(title);
  if (html) {
    editor.classList.add('html-code-editor');
    const previewNote = make('p', 'card-note');
    previewNote.hidden = !differs();
    previewNote.textContent = 'Aperçu de la version enregistrée. Enregistrez votre saisie pour actualiser le résultat.';
    content.append(htmlView({resource:`/api/versions/${base.id}`,title:base.title,source:editor,key:`work:${work.id}`,workId:work.id,
      onPreview:() => { previewNote.hidden = !differs(); if (differs() && !blocked) saveEdit(); }}), previewNote);
  } else content.append(editor);
  content.append(saveNotice, othersNotice);
  article.append(heading, content);
  const open = work.proposals.find(p => p.state === 'open');
  const actionsRow = make('div', 'natural-card-actions');
  if (open) {
    article.append(proposalCallout(open));
    actionsRow.append(
      button('Refuser', () => void dispatch({ type: 'publication.reject', proposalId: open.id })),
      button('Approuver la publication', () => void dispatch({
        type: 'publication.approve', proposalId: open.id, action: open.action, destination: open.destination,
        versionId: open.versionId, payloadSha256: open.payloadSha256,
      }).then(sent => { if (sent.ok) toast('Publié dans le Carnet local'); }), 'primary'),
    );
  } else {
    if (work.state === 'review') actionsRow.append(button('Valider', () => void dispatch({ type: 'work.accept', workId: work.id }), 'primary'));
    const published = view?.carnet.some(p => p.versionId === version.id);
    if (!published) {
      actionsRow.append(button('Proposer au Carnet', () => void dispatch({
        type: 'publication.propose', workId: work.id, versionId: base.id, destination: 'carnet',
      })));
    }
    if (!html) actionsRow.append(button('Télécharger', () => download(`/api/versions/${base.id}/download`)));
  }
  article.append(actionsRow);
  const last = work.proposals[work.proposals.length - 1];
  if (!open && last?.state === 'stale') {
    article.append(make('small', 'card-note', last.staleReason === 'restored'
      ? 'Proposition annulée : une ancienne version a été restaurée.'
      : last.staleReason === 'edited' ? 'Proposition annulée : le livrable a été modifié.' : 'Proposition remplacée.'));
  } else if (!open && last?.state === 'rejected') {
    article.append(make('small', 'card-note', 'Publication refusée. Rien n’a été publié.'));
  }
  for (const publication of view?.carnet.filter(p => p.workId === work.id) ?? []) {
    const note = make('small', 'card-note', `Publié dans le Carnet · version ${publication.versionN} · ${formatDate(publication.createdAt)} `);
    const link = make('a', '', 'Télécharger');
    link.href = `/api/publications/${publication.id}/download`;
    note.append(link);
    article.append(note);
  }
  const footer = make('div', 'work-card-footer');
  footer.append(make('span', '', botName(work.botId, 'Votre bot')));
  if (work.versions.length > 1) footer.append(button(`Version ${version.n} · Historique`, () => showVersions(work.id), 'version-trigger'));
  else footer.append(make('span', '', 'Version 1'));
  article.append(footer);
  element.append(article);
  keepDraft();
  return element;
}

function rebuildCard(element: HTMLElement): void {
  element.dataset.keepDraft = 'false';
  element.dataset.sig = '';
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && element.contains(focused)) focused.blur();
  renderThread();
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' });
}

function showVersions(workId: string): void {
  const owner = workById(workId)?.threadBotId;
  if (owner) selectBot(owner);
  const work = workById(workId);
  if (!work) return;
  const current = currentVersion(work);
  const source = (v: VersionView) => v.source === 'result' ? `Réponse de ${botName(work.botId, 'votre bot')}`
    : v.source === 'edit' ? 'Modifiée par vous' : `Restaurée depuis la version ${v.restoredFromN ?? '?'}`;
  const published = new Set(view?.carnet.filter(p => p.workId === workId).map(p => p.versionId));
  openPlay(`Versions de ${work.title}`, '<p>Restaurer crée une nouvelle version. Les publications déjà faites restent dans le Carnet.</p><div class="version-list">'
    + [...work.versions].reverse().map(v => `<button type="button" data-version="${escapeMarkup(v.id)}" ${v.id === current?.id ? 'aria-current="true"' : ''}><strong>Version ${v.n}${v.id === current?.id ? ' · actuelle' : ''}${published.has(v.id) ? ' · publiée' : ''}</strong><small>${escapeMarkup(source(v))} · ${escapeMarkup(formatDate(v.createdAt))}</small><span>${escapeMarkup((v.title + ' · ' + v.body).slice(0, 95))}</span></button>`).join('')
    + '</div>', () => {
    playContent.querySelectorAll<HTMLButtonElement>('[data-version]').forEach(b => {
      b.onclick = () => {
        const versionId = b.dataset.version ?? '';
        if (versionId === current?.id) {
          playDialog.close();
          return;
        }
        void dispatch({ type: 'version.restore', workId, versionId }).then(sent => {
          if (!sent.ok) return;
          playDialog.close();
          cardIntoView(workId);
          toast('Version restaurée en nouvelle version');
        });
      };
    });
  });
  playDialog.dataset.workId = workId;
}

function cardIntoView(workId: string): void {
  const work = workById(workId);
  if (work?.taskId) {
    openTask(work.taskId);
    return;
  }
  if (work) selectBot(work.threadBotId);
  renderThread();
  const element = messagesEl.querySelector(`[data-work-id="${CSS.escape(workId)}"]`)
    ?? messagesEl.querySelector(`[data-key="user:${CSS.escape(workById(workId)?.requestMessageId ?? '')}"]`);
  if (!(element instanceof HTMLElement)) return;
  element.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  element.classList.remove('work-pulse');
  void element.offsetWidth;
  element.classList.add('work-pulse');
}

type Entry = { key: string; sig: string; build: () => HTMLElement };

function threadEntries(threadBotId = activeId): Entry[] {
  if (!view) return [];
  const replied = new Set(view.messages.filter(m => m.role === 'assistant').map(m => m.workId));
  const entries: Entry[] = [];
  const first = view.messages.find(m => m.threadBotId === threadBotId);
  if (first) {
    const date = new Date(first.createdAt);
    const label = date.toDateString() === new Date().toDateString() ? 'Aujourd’hui' : date.toLocaleDateString('fr-CA', { dateStyle: 'long' });
    entries.push({ key: 'date', sig: label, build: () => make('div', 'thread-date', label) });
  }
  const botSig = (id: string) => JSON.stringify(botById(id) ? [botById(id)?.name, botById(id)?.shape, botById(id)?.color] : null);
  for (const message of view.messages.filter(m => m.threadBotId === threadBotId)) {
    const work = workById(message.workId);
    if (message.role === 'user') {
      entries.push({ key: `user:${message.id}`, sig: botSig(message.botId), build: () => userElement(message) });
      const task = view.tasks.find(t => t.requestMessageId === message.id);
      if (task) {
        entries.push({ key: `task:${task.id}`, sig: taskCardSig(task), build: () => taskCard(task) });
        continue;
      }
      for (const work of view.works.filter(w => w.requestMessageId === message.id)) if (!replied.has(work.id) && work.state !== 'review' && work.state !== 'done') {
        entries.push({
          key: `status:${work.id}`,
          sig: JSON.stringify([work.state, work.attempt?.stage, work.attempt?.error, botSig(work.botId), view.works.some(w => w.state === 'running')]),
          build: () => statusElement(work),
        });
      }
    } else {
      const models = view.engine.state === 'ready' ? view.engine.models.length : 0;
      entries.push({ key: `assistant:${message.id}`, sig: botSig(message.botId) + models, build: () => assistantElement(message) });
      if (work?.versions.length && !work.taskId) {
        entries.push({
          key: `card:${work.id}`,
          sig: JSON.stringify([work.state, work.versions.length, work.proposals, view.carnet.filter(p => p.workId === work.id).map(p => p.id), botSig(work.botId)]),
          build: () => cardElement(work),
        });
      }
    }
  }
  return entries;
}

function taskById(id: string): TaskView | undefined {
  return view?.tasks.find(t => t.id === id);
}

function taskOfWork(workId: string): TaskView | undefined {
  return view?.tasks.find(t => t.authorWorkId === workId || t.reviewWorkId === workId);
}

function stepTag(step: TaskStep, workId: string): HTMLElement {
  const task = taskOfWork(workId);
  const tag = make('p', 'task-step-tag');
  tag.append(`${STEP_LABELS[step]} · document`);
  if (step === 'review') tag.append(make('span', '', ' · avis sur la même source, pas une vérification indépendante'));
  if (task) tag.append(' ', button('Voir le document', () => openTask(task.id), 'task-step-open'));
  return tag;
}

function plannedSteps(task: TaskView): { step: TaskStep; botId: string; state: string }[] {
  const steps: { step: TaskStep; botId: string; state: string }[] = task.calls.map(call => ({ step: call.step, botId: call.botId, state: call.state }));
  const done = new Set(task.calls.filter(c => c.state === 'succeeded').map(c => c.step));
  const planned: TaskStep[] = task.plan === 'solo' ? ['draft'] : ['draft', 'review', 'synthesis'];
  for (const step of planned) {
    if (done.has(step) || steps.some(s => s.step === step && s.state === 'running')) continue;
    if (task.status === 'cancelled' || task.status === 'validated') continue;
    if (steps.some(s => s.step === step)) continue;
    steps.push({ step, botId: step === 'review' ? task.reviewerBotId ?? '' : task.authorBotId, state: 'planned' });
  }
  return steps;
}

const CALL_STATE_LABELS: Record<string, string> = {
  planned: 'prévu', running: 'en cours', succeeded: 'fait', failed: 'échec', cancelled: 'annulé', interrupted: 'interrompu',
};

function stepChain(task: TaskView): HTMLElement {
  const list = make('ol', 'task-steps');
  for (const step of plannedSteps(task)) {
    const item = make('li', `task-step step-${step.state}`, `${STEP_LABELS[step.step]} · ${botName(step.botId)} · ${CALL_STATE_LABELS[step.state] ?? step.state}`);
    item.dataset.state = step.state;
    list.append(item);
  }
  return list;
}

function taskTitle(task: TaskView): string {
  return workById(task.authorWorkId)?.title ?? 'Document';
}

function taskCardSig(task: TaskView): string {
  return JSON.stringify([task.status, task.calls.map(c => c.state), Boolean(task.progress), task.events.map(e => e.delivery.state),
    task.proposals.map(p => p.state), taskTitle(task), workById(task.authorWorkId)?.versions.length, task.reviewerBotId ? botName(task.reviewerBotId) : '', botName(task.authorBotId), panelTaskId === task.id]);
}

function taskCard(task: TaskView): HTMLElement {
  const element = make('div', 'assistant-message task-card');
  element.dataset.taskId = task.id;
  element.dataset.status = task.status;
  const article = make('article', 'natural-card');
  const heading = make('div', 'natural-card-heading', 'Document');
  heading.append(make('span', `work-card-status task-status status-${task.status}`, TASK_STATUS_LABELS[task.status]));
  const content = make('div', 'natural-card-content');
  content.append(make('strong', 'task-card-title', taskTitle(task)), make('p', 'task-card-plan', planLabel(task, botName)), stepChain(task));
  if (task.progress?.attemptState === 'running') content.append(make('p', 'task-card-received'), make('pre', 'task-card-stream'));
  content.append(make('p', 'task-card-hint', TASK_STATUS_HINTS[task.status]));
  const waiting = task.events.filter(e => e.delivery.state === 'waiting' || e.delivery.state === 'prepared').length;
  if (waiting) content.append(make('p', 'task-card-hint', `${waiting} précision${waiting > 1 ? 's' : ''} pas encore transmise${waiting > 1 ? 's' : ''}.`));
  const local = make('small', 'task-card-local', `Demande enregistrée par Mino sur cet ordinateur · ${formatDate(task.createdAt)}`);
  local.title = 'Confirmation locale du serveur Mino, pas une réponse du bot.';
  content.append(local);
  const actionsRow = make('div', 'natural-card-actions');
  actionsRow.append(button(panelTaskId === task.id ? 'Document ouvert' : 'Ouvrir le document', () => openTask(task.id), 'primary task-open'));
  if (isActive(task)) actionsRow.append(button('Annuler', () => void cancelTask(task.id), 'task-cancel'));
  article.append(heading, content, actionsRow);
  element.append(article);
  patchCardProgress(element, task);
  return element;
}

function patchCardProgress(card: Element, task: TaskView): void {
  const progress = task.progress;
  const facts = card.querySelector('.task-card-received');
  const stream = card.querySelector('.task-card-stream');
  if (!progress || !facts || !(stream instanceof HTMLElement)) return;
  const received = progress.body ?? progress.reply;
  facts.textContent = `${botName(progress.botId)} écrit · ${number(progress.chars)} caractères reçus`;
  stream.textContent = received.length > 220 ? '…' + received.slice(-220) : received;
  stream.hidden = !received;
}

function cancelTask(taskId: string): Promise<Sent> {
  return dispatch({ type: 'task.intent', taskId, intent: { kind: 'cancel' } }).then(sent => {
    if (sent.ok) toast('Travail annulé. Le document reste disponible.');
    return sent;
  });
}

const docPanel = byId('doc-panel', HTMLElement);
const wideLayout = window.matchMedia('(min-width: 900px)');
let panelTaskId = '';

type TaskEditor = { root: HTMLElement; sync(): void; dirty(): boolean };
const editors = new Map<string, TaskEditor>();
const intentInputs = new Map<string, HTMLTextAreaElement>();
const parts = new Map<string, { sig: string; element: HTMLElement }>();
function cachedPanelSection(taskId: string, name: string, sig: unknown, build: () => HTMLElement | null): HTMLElement | null {
  const key = `${taskId}:${name}`;
  const text = JSON.stringify(sig);
  const cached = parts.get(key);
  if (cached?.sig === text) return cached.element;
  const element = build();
  if (element) parts.set(key, { sig: text, element });
  else parts.delete(key);
  return element;
}
const streams = new Map<string, { holder: HTMLElement; heading: HTMLElement; facts: HTMLElement; pre: HTMLPreElement; html: HTMLElement }>();
const previews = new Map<string, { versionId: string; element: HTMLElement }>();

function openTask(taskId: string): void {
  const task = taskById(taskId);
  if (!task) return;
  if (task.threadBotId !== activeId) selectBot(task.threadBotId);
  panelTaskId = taskId;
  renderPanel();
  renderThread();
  renderIndicators();
  if (!wideLayout.matches) docPanel.querySelector<HTMLElement>('.doc-back')?.focus();
}

function closePanel(): void {
  const taskId = panelTaskId;
  panelTaskId = '';
  renderPanel();
  renderThread();
  renderIndicators();
  const card = messagesEl.querySelector(`[data-task-id="${CSS.escape(taskId)}"] .task-open`);
  if (card instanceof HTMLElement) card.focus();
  else promptEl.focus();
}

function versionLabel(n: number | null): string {
  return n === null ? 'un document vide' : `la version ${n}`;
}

function fromVersion(n: number | null): string {
  return n === null ? 'd’un document vide' : `de la version ${n}`;
}

function editorFor(task: TaskView): TaskEditor {
  const existing = editors.get(task.id);
  if (existing) return existing;
  const workId = task.authorWorkId;
  const scope = { kind: 'version', workId } as const;
  const root = make('div', 'doc-editor');
  const title = make('input', 'doc-editor-title');
  title.maxLength = LIMITS.versionTitleChars;
  title.setAttribute('aria-label', 'Titre du document');
  title.placeholder = 'Titre';
  const body = make('textarea', 'doc-editor-body');
  body.setAttribute('aria-label', 'Document modifiable');
  body.placeholder = 'Vous pouvez écrire ici avant que le bot ait fini : votre texte ne sera jamais remplacé.';
  const note = make('div', 'doc-editor-note');
  note.setAttribute('role', 'status');
  const save = button('Enregistrer ma version', () => void saveEdit(), 'doc-save primary');
  const discard = button('Abandonner ma saisie', () => {
    drafts.discard(scope);
    load(current());
  }, 'doc-discard');
  root.append(title, body, note, make('div', 'doc-editor-actions'));
  root.lastElementChild?.append(save, discard);
  const current = () => {
    const work = workById(workId);
    return work ? currentVersion(work) : undefined;
  };
  let base: VersionView | undefined = current();
  let saving = false;
  const baseText = () => ({ title: base?.title ?? '', body: base?.body ?? '' });
  const dirty = () => title.value.trim() !== baseText().title || body.value.trim() !== baseText().body;
  const load = (version: VersionView | undefined) => {
    base = version;
    title.value = version?.title ?? '';
    body.value = version?.body ?? '';
    sync();
  };
  const remember = () => {
    if (dirty()) drafts.write(scope, { baseVersionId: base?.id ?? null, title: title.value, body: body.value });
    else drafts.discard(scope);
    renderDraftStatus();
    renderPanel();
  };
  title.oninput = body.oninput = remember;
  async function saveEdit(): Promise<void> {
    const newTitle = title.value.trim();
    const newBody = body.value.trim();
    if (!newTitle || !newBody) {
      toast('Le titre et le contenu sont nécessaires. Votre saisie reste ici.');
      return;
    }
    if (saving || !dirty()) return;
    saving = true;
    sync();
    const capture = drafts.write(scope, { baseVersionId: base?.id ?? null, title: title.value, body: body.value });
    const sent = await dispatch({ type: 'task.edit', taskId: task.id, baseVersionId: base?.id ?? null, title: newTitle, body: newBody });
    saving = false;
    if (sent.ok && sent.result.kind === 'version') {
      drafts.acknowledge(capture);
      base = workById(workId)?.versions.find(v => v.id === (sent.ok && sent.result.kind === 'version' ? sent.result.versionId : ''))
        ?? { id: sent.result.versionId, n: sent.result.n, title: newTitle, body: newBody, source: 'edit', restoredFromN: null, createdAt: new Date().toISOString() };
      toast(`Version ${sent.result.n} enregistrée`);
    }
    sync();
  }
  function sync(): void {
    const latest = current();
    const focused = root.contains(document.activeElement);
    if (latest?.id !== base?.id && !dirty() && !focused && !saving) {
      base = latest;
      title.value = latest?.title ?? '';
      body.value = latest?.body ?? '';
    }
    const changed = dirty();
    save.disabled = saving || !changed;
    discard.hidden = !changed;
    note.replaceChildren();
    if (latest?.id !== base?.id && changed) {
      note.append(make('p', '', `Votre saisie part ${fromVersion(base?.n ?? null)} ; ${latest ? `la version ${latest.n}` : 'aucune version'} est actuelle. Rien n’est remplacé sans vous.`),
        button(`Enregistrer ma saisie comme version ${latest ? latest.n + 1 : 1}`, () => {
          base = latest;
          void saveEdit();
        }, 'doc-rebase'));
    } else if (latest?.id !== base?.id) {
      note.append(make('p', '', `${latest ? `La version ${latest.n}` : 'Une version'} est arrivée.`), button('Afficher', () => load(latest), 'doc-load'));
    } else if (changed) {
      note.append(make('p', '', saving ? 'Enregistrement…' : `Saisie non enregistrée, partie ${fromVersion(base?.n ?? null)}. Elle est gardée dans ce navigateur.`));
    }
    root.dataset.dirty = String(changed);
  }
  const restored = drafts.read(scope);
  if (restored && (restored.title !== (base?.title ?? '') || restored.body !== (base?.body ?? ''))) {
    title.value = restored.title;
    body.value = restored.body;
    const from = workById(workId)?.versions.find(v => v.id === restored.baseVersionId);
    base = restored.baseVersionId === null ? undefined : from ?? base;
  } else {
    title.value = base?.title ?? '';
    body.value = base?.body ?? '';
  }
  const editor = { root, sync, dirty };
  editors.set(task.id, editor);
  sync();
  return editor;
}

function hasUnsavedDraft(task: TaskView): boolean {
  const editor = editors.get(task.id);
  if (editor) return editor.dirty();
  const draft = drafts.read({ kind: 'version', workId: task.authorWorkId });
  const work = workById(task.authorWorkId);
  const current = work ? currentVersion(work) : undefined;
  return draft !== null && (draft.title.trim() !== (current?.title ?? '') || draft.body.trim() !== (current?.body ?? ''));
}

function streamFor(task: TaskView): HTMLElement | null {
  const progress = task.progress;
  if (!progress) {
    streams.delete(task.id);
    return null;
  }
  let live = streams.get(task.id);
  if (!live) {
    const holder = make('section', 'doc-live');
    const pre = make('pre', 'doc-stream');
    live = { holder, heading: make('h3'), facts: make('p', 'doc-live-facts'), pre, html: make('p', 'doc-live-facts', 'HTML partiel affiché comme du texte : rien n’est exécuté avant la version finale.') };
    holder.append(live.heading, live.facts, pre, live.html);
    streams.set(task.id, live);
  }
  live.heading.textContent = progress.attemptState === 'running'
    ? `${STEP_LABELS[progress.step]} par ${botName(progress.botId)} · texte reçu, non validé`
    : `${STEP_LABELS[progress.step]} par ${botName(progress.botId)} · texte partiel reçu avant l’arrêt, non validé`;
  live.facts.textContent = `${number(progress.chars)} caractères reçus${progress.readable ? '' : ' · pas encore lisibles comme réponse'}`;
  const text = progress.body ?? progress.reply;
  if (live.pre.textContent !== text) {
    const follow = live.pre.scrollHeight - live.pre.scrollTop - live.pre.clientHeight < 40;
    live.pre.textContent = text;
    if (follow) live.pre.scrollTop = live.pre.scrollHeight;
  }
  live.html.hidden = !/<(?:!doctype|html|head|body|script|style)\b/i.test(progress.body ?? '');
  live.holder.dataset.state = progress.attemptState;
  return live.holder;
}

function previewFor(task: TaskView, version: VersionView | undefined): HTMLElement | null {
  if (!version || !htmlDocument(version.body)) return null;
  const cached = previews.get(task.id);
  if (cached?.versionId === version.id) return cached.element;
  const element = make('section', 'doc-preview');
  element.append(make('h3', '', `Aperçu de la version ${version.n}`), htmlFrame(`/api/versions/${version.id}`, version.title));
  const tools = make('div', 'html-tools');
  tools.append(button('Agrandir', () => openHtml(`/api/versions/${version.id}`, version.title, task.authorWorkId)),
    button('Télécharger HTML', () => download(`/api/versions/${version.id}/download`)));
  element.append(tools);
  previews.set(task.id, { versionId: version.id, element });
  return element;
}

function proposalsFor(task: TaskView, current: VersionView | undefined): HTMLElement | null {
  const open = task.proposals.filter(p => p.state === 'open');
  const closed = task.proposals.filter(p => p.state !== 'open');
  if (!open.length && !closed.length) return null;
  const section = make('section', 'doc-proposals');
  section.append(make('h3', '', open.length ? 'Propositions à arbitrer' : 'Propositions traitées'));
  for (const proposal of open) {
    const item = make('article', 'doc-proposal');
    item.dataset.proposalId = proposal.id;
    const reason = proposal.reason === 'goal_changed'
      ? `écrite pour l’objectif de la révision ${proposal.revision} ; l’objectif actuel est la révision ${task.revision}`
      : `écrite à partir ${fromVersion(proposal.baseVersionN)} alors que ${current ? `la version ${current.n}` : 'votre texte'} est actuelle`;
    item.append(make('strong', '', `${STEP_LABELS[proposal.step]} de ${botName(proposal.botId)} : « ${proposal.title} »`), make('p', '', `Proposition ${reason}. Rien n’a été remplacé.`));
    const details = make('details', 'doc-proposal-text');
    details.append(make('summary', '', 'Voir le texte proposé'), make('pre', '', proposal.body));
    item.append(details);
    const row = make('div', 'natural-card-actions');
    row.append(button(`Adopter comme version ${current ? current.n + 1 : 1}`, () => void dispatch({
      type: 'doc.adopt', proposalId: proposal.id, seenVersionId: current?.id ?? null, seenRevision: task.revision,
    }).then(sent => { if (sent.ok) toast('Proposition adoptée en nouvelle version'); }), 'primary doc-adopt'),
    button('Écarter', () => void dispatch({ type: 'doc.dismiss', proposalId: proposal.id }), 'doc-dismiss'));
    item.append(row);
    section.append(item);
  }
  for (const proposal of closed) {
    section.append(make('p', 'doc-proposal-closed', `${STEP_LABELS[proposal.step]} de ${botName(proposal.botId)} : ${proposal.state === 'adopted' ? `adoptée (version ${proposal.versionN ?? '?'})` : 'écartée'}.`));
  }
  return section;
}

function exchangesFor(task: TaskView): HTMLElement | null {
  if (!task.handoffs.length && task.plan === 'solo') return null;
  const section = make('section', 'doc-exchanges');
  section.append(make('h3', '', 'Échanges entre bots'));
  if (!task.handoffs.length) section.append(make('p', 'doc-muted', task.status === 'reviewer_unavailable' ? 'Aucun échange : le relecteur a été supprimé avant sa relecture.' : 'Le brouillon sera transmis au relecteur quand il sera enregistré.'));
  for (const handoff of task.handoffs) {
    const to = handoff.toStep === 'review' ? task.reviewerBotId ?? '' : task.authorBotId;
    const item = make('article', 'doc-exchange');
    item.dataset.handoffId = handoff.id;
    item.append(make('strong', '', `${botName(handoff.fromBotId)} → ${botName(to)} · ${handoff.toStep === 'review' ? 'brouillon pour avis' : 'avis pour la synthèse'}`));
    item.append(make('p', 'doc-muted', handoff.readBy.length
      ? handoff.readBy.map(read => `Transmis à ${botName(read.botId)} dans un tour accepté (${STEP_LABELS[read.step].toLowerCase()}, appel ${read.n}, ${CALL_STATE_LABELS[read.state] ?? read.state})${read.contextSha256 ? ` · contexte ${read.contextSha256.slice(0, 10)}…` : ''}`).join(' · ')
      : 'En attente de transmission à un tour accepté.'));
    const message = view?.messages.find(m => m.id === handoff.messageId);
    if (message) {
      const details = make('details', 'doc-exchange-text');
      details.append(make('summary', '', 'Message enregistré'), markdown(message.text));
      item.append(details);
    }
    section.append(item);
  }
  section.append(make('p', 'doc-muted', 'Seuls les messages enregistrés et le document circulent. Les souvenirs de chaque bot et ses autres fils ne sont jamais partagés. Deux bots qui relisent la même source ne vérifient pas les faits de façon indépendante.'));
  return section;
}

const intentForms = new Map<string, HTMLElement>();

function intentsFor(task: TaskView): HTMLElement {
  const section = make('section', 'doc-intents');
  section.append(make('h3', '', 'Objectif et précisions'));
  section.append(make('p', 'doc-goal', `Objectif${task.revision > 1 ? ` (révision ${task.revision})` : ''} : ${task.goal}`));
  const list = make('ul', 'doc-intent-list');
  for (const event of task.events.filter(e => e.kind !== 'cancel')) {
    const item = make('li', `doc-intent delivery-${event.delivery.state}`);
    item.dataset.delivery = event.delivery.state;
    item.append(make('strong', '', event.kind === 'change_goal' ? `Nouvel objectif (révision ${event.revision})` : 'Précision'), make('span', '', ` « ${event.text} »`),
      make('small', '', deliveryLabel(event, botName)));
    list.append(item);
  }
  if (list.childElementCount) section.append(list);
  const closed = task.status === 'cancelled' || task.status === 'validated';
  if (!closed && !intentForms.has(task.id)) {
    let input = intentInputs.get(task.id);
    if (!input) {
      input = make('textarea', 'doc-intent-text');
      input.id = 'doc-intent-text';
      input.maxLength = LIMITS.messageChars;
      input.placeholder = 'Une précision pour ce document, ou son nouvel objectif';
      input.setAttribute('aria-label', 'Précision ou nouvel objectif pour ce document');
      intentInputs.set(task.id, input);
    }
    const field = input;
    const send = (kind: 'add_info' | 'change_goal') => {
      const text = field.value.trim();
      if (!text) return;
      void dispatch({ type: 'task.intent', taskId: task.id, intent: { kind, text } }).then(sent => {
        if (!sent.ok) return;
        field.value = '';
        toast(kind === 'add_info' ? 'Précision enregistrée pour ce document' : 'Objectif changé : l’ancien plan s’arrête');
      });
    };
    const row = make('div', 'doc-intent-actions');
    row.append(button('Ajouter une précision', () => send('add_info'), 'doc-add-info'), button('Changer l’objectif', () => send('change_goal'), 'doc-change-goal'));
    const form = make('div', 'doc-intent-form');
    form.append(field, row);
    intentForms.set(task.id, form);
  } else if (closed) intentForms.delete(task.id);
  return section;
}

function actionsFor(task: TaskView, current: VersionView | undefined): HTMLElement {
  const section = make('section', 'doc-actions');
  const row = make('div', 'natural-card-actions');
  const unsaved = hasUnsavedDraft(task);
  const continueLabel = CONTINUE_LABELS[task.status];
  if (task.canContinue && continueLabel) {
    row.append(button(`${continueLabel} (${2 - task.continuations} restante${2 - task.continuations > 1 ? 's' : ''})`, () => void dispatch({ type: 'task.continue', taskId: task.id }), 'doc-continue'));
  }
  const work = workById(task.authorWorkId);
  if (work?.state === 'review' && !isActive(task) && current) {
    const validate = button('Valider le document', () => {
      if (hasUnsavedDraft(task)) toast('Enregistrez ou abandonnez d’abord votre saisie : elle n’est pas dans la version à valider.');
      else void dispatch({ type: 'work.accept', workId: work.id });
    }, 'primary doc-validate');
    validate.disabled = unsaved;
    if (unsaved) validate.title = 'Enregistrez ou abandonnez d’abord votre saisie.';
    row.append(validate);
  }
  const openPublication = work?.proposals.find(p => p.state === 'open');
  if (work && current && !openPublication && !view?.carnet.some(p => p.versionId === current.id)) {
    const propose = button('Proposer au Carnet', () => {
      if (hasUnsavedDraft(task)) toast('Enregistrez ou abandonnez d’abord votre saisie : elle n’est pas dans la version proposée.');
      else void dispatch({ type: 'publication.propose', workId: work.id, versionId: current.id, destination: 'carnet' });
    }, 'doc-propose');
    propose.disabled = unsaved;
    if (unsaved) propose.title = 'Enregistrez ou abandonnez d’abord votre saisie.';
    row.append(propose);
  }
  if (current && !htmlDocument(current.body)) row.append(button('Télécharger', () => download(`/api/versions/${current.id}/download`)));
  if (task.status !== 'cancelled' && task.status !== 'validated') row.append(button('Annuler le travail', () => void cancelTask(task.id), 'doc-cancel'));
  if (work && work.versions.length > 1) row.append(button('Historique', () => showVersions(work.id)));
  section.append(row);
  if (openPublication && work) {
    section.append(proposalCallout(openPublication));
    const approve = make('div', 'natural-card-actions');
    approve.append(button('Refuser', () => void dispatch({ type: 'publication.reject', proposalId: openPublication.id })),
      button('Approuver la publication', () => {
        if (hasUnsavedDraft(task)) {
          toast('Enregistrez ou abandonnez d’abord votre saisie : la publication porterait sur l’ancienne version.');
          return;
        }
        void dispatch({
          type: 'publication.approve', proposalId: openPublication.id, action: openPublication.action, destination: openPublication.destination,
          versionId: openPublication.versionId, payloadSha256: openPublication.payloadSha256,
        }).then(sent => { if (sent.ok) toast('Publié dans le Carnet local'); });
      }, 'primary doc-approve'));
    section.append(approve);
  }
  return section;
}

function detailsFor(task: TaskView): HTMLElement {
  const details = make('details', 'doc-details');
  details.append(make('summary', '', `Détails · ${task.calls.length} / ${task.maxCalls} appels`));
  const list = make('ul', 'doc-calls');
  for (const call of task.calls) {
    list.append(make('li', '', `${STEP_LABELS[call.step]} · ${botName(call.botId)} · appel ${call.n}${call.continued ? ' (reprise)' : ''} · ${CALL_STATE_LABELS[call.state] ?? call.state}`
      + ` · base : ${versionLabel(call.baseVersionN)} · objectif révision ${call.taskRevision} · ${call.turnAccepted ? 'tour accepté par Codex' : 'aucun tour accepté'}${call.error ? ` · ${call.error}` : ''}`));
  }
  details.append(list, make('p', 'doc-muted', `Reprises utilisées : ${task.continuations} / 2. Chaque appel commencé compte, même interrompu. Aucun appel ne repart seul après un arrêt.`));
  return details;
}

function renderPanel(): void {
  const task = panelTaskId ? taskById(panelTaskId) : undefined;
  if (panelTaskId && !task) panelTaskId = '';
  document.querySelector('.main')?.classList.toggle('doc-open', Boolean(task));
  docPanel.hidden = !task;
  for (const card of messagesEl.querySelectorAll<HTMLElement>('.task-card')) {
    const shown = taskById(card.dataset.taskId ?? '');
    if (shown) patchCardProgress(card, shown);
  }
  if (!task) {
    docPanel.replaceChildren();
    return;
  }
  docPanel.dataset.taskId = task.id;
  docPanel.dataset.status = task.status;
  const work = workById(task.authorWorkId);
  const current = work ? currentVersion(work) : undefined;
  const editor = editorFor(task);
  editor.sync();
  const names = [task.authorBotId, task.reviewerBotId ?? '', ...task.handoffs.map(h => h.fromBotId)].map(id => botName(id));
  const head = cachedPanelSection(task.id, 'head', [task.status, task.calls.map(c => [c.step, c.state]), taskTitle(task), names, task.maxCalls], () => {
    const element = make('header', 'doc-head');
    const close = button('×', closePanel, 'doc-close');
    close.setAttribute('aria-label', 'Fermer le document');
    const titleRow = make('div', 'doc-title-row');
    titleRow.append(make('h2', '', taskTitle(task)), make('span', `work-card-status task-status status-${task.status}`, TASK_STATUS_LABELS[task.status]));
    element.append(button('← Conversation', closePanel, 'doc-back'), close, titleRow, make('p', 'doc-plan', planLabel(task, botName)), stepChain(task),
      make('p', 'doc-hint', TASK_STATUS_HINTS[task.status]));
    return element;
  });
  const proposals = cachedPanelSection(task.id, 'proposals', [task.proposals.map(p => [p.id, p.state]), current?.id, task.revision, names], () => proposalsFor(task, current));
  const documentHeading = cachedPanelSection(task.id, 'document', [current?.n], () => make('h3', 'doc-document', current ? `Document · version ${current.n}` : 'Document · aucune version encore'));
  const unsaved = hasUnsavedDraft(task);
  const actions = cachedPanelSection(task.id, 'actions', [task.status, task.canContinue, task.continuations, work?.state, current?.id, work?.proposals.map(p => [p.id, p.state]),
    view?.carnet.filter(p => p.workId === work?.id).map(p => p.id), unsaved, work?.versions.length], () => actionsFor(task, current));
  const exchanges = cachedPanelSection(task.id, 'exchanges', [task.handoffs.map(h => [h.id, h.readBy.map(r => [r.state, r.contextSha256])]), task.status, names,
    task.handoffs.map(h => view?.messages.some(m => m.id === h.messageId))], () => exchangesFor(task));
  const intents = cachedPanelSection(task.id, 'intents', [task.events.map(e => [e.id, e.delivery]), task.goal, task.revision, task.status, names], () => intentsFor(task));
  const details = cachedPanelSection(task.id, 'details', [task.calls, task.continuations], () => detailsFor(task));
  const ordered: (HTMLElement | null | undefined)[] = [head, streamFor(task), proposals, previewFor(task, current), documentHeading, editor.root,
    actions, exchanges, intents, intentForms.get(task.id), details];
  const keep = new Set<Element>(ordered.filter((element): element is HTMLElement => Boolean(element)));
  for (const child of [...docPanel.children]) if (!keep.has(child)) child.remove();
  let previous: Element | null = null;
  for (const element of ordered) {
    if (!element) continue;
    if ((previous ? previous.nextElementSibling : docPanel.firstElementChild) !== element) {
      if (previous) previous.after(element);
      else docPanel.prepend(element);
    }
    previous = element;
  }
}

function isEditing(element: HTMLElement): boolean {
  const focused = document.activeElement;
  return focused instanceof HTMLElement && element.contains(focused) && (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement);
}

const NEAR_BOTTOM_PX = 120;
let threadRendered = false;
let unseen = 0;
const jumpButton = byId('jump-bottom', HTMLButtonElement);

function distanceFromBottom(): number {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
}

function renderJump(): void {
  const away = distanceFromBottom() >= NEAR_BOTTOM_PX;
  if (!away) unseen = 0;
  jumpButton.hidden = !away;
  const label = jumpButton.querySelector('span');
  if (label) label.textContent = unseen ? `${unseen} nouveau${unseen > 1 ? 'x' : ''} message${unseen > 1 ? 's' : ''}` : 'Revenir en bas';
}

function scrollToBottom(behavior: ScrollBehavior): void {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior });
  unseen = 0;
  renderJump();
}

type Pane = { el: HTMLElement; scroll: number; follow: boolean; seen: Set<string>; unseen: number; rendered: boolean };
const panes = new Map<string, Pane>();
let mountedThread = '';
function savePane(): void {
  const pane = panes.get(mountedThread);
  if (pane) Object.assign(pane, { scroll: messagesEl.scrollTop, follow: followBottom, unseen, rendered: threadRendered });
}
function currentPane(): Pane {
  let pane = panes.get(activeId);
  if (!pane) {
    pane = { el: make('section', 'thread-pane'), scroll: 0, follow: false, seen: new Set(), unseen: 0, rendered: false };
    messagesEl.append(pane.el);
    panes.set(activeId, pane);
  }
  if (mountedThread !== activeId) {
    savePane();
    for (const [id, item] of panes) item.el.hidden = id !== activeId;
    mountedThread = activeId;
    unseen = pane.unseen; threadRendered = pane.rendered; followBottom = pane.follow;
    messagesEl.scrollTop = pane.scroll;
  }
  return pane;
}

function renderThread(): void {
  const switched = mountedThread !== activeId;
  currentPane();
  for (const [id, pane] of panes) renderPane(pane, id, switched && id === activeId);
  chatMissions.sync(activeId === 'mino');
}

function renderPane(pane: Pane, threadBotId: string, switched: boolean): void {
  const visible = threadBotId === activeId;
  const wasRendered = pane.rendered;
  const entries = threadEntries(threadBotId);
  const follow = distanceFromBottom() < NEAR_BOTTOM_PX || followBottom;
  const existing = new Map<string, HTMLElement>();
  for (const child of [...pane.el.children]) {
    if (child instanceof HTMLElement && child.dataset.key) existing.set(child.dataset.key, child);
  }
  let previous: Element | null = null;
  let changed = false;
  let arrived = 0;
  for (const entry of entries) {
    let element = existing.get(entry.key);
    existing.delete(entry.key);
    if (!element || (element.dataset.sig !== entry.sig && !isEditing(element) && element.dataset.keepDraft !== 'true')) {
      const fresh = entry.build();
      fresh.dataset.key = entry.key;
      fresh.dataset.sig = entry.sig;
      if (!pane.seen.has(entry.key)) {
        if (pane.rendered) fresh.classList.add('msg-enter');
        if (pane.rendered && !entry.key.startsWith('status:') && entry.key !== 'date') arrived += 1;
        pane.seen.add(entry.key);
      }
      if (element) element.replaceWith(fresh);
      element = fresh;
      changed = true;
    }
    if ((previous ? previous.nextElementSibling : pane.el.firstElementChild) !== element) {
      if (previous) previous.after(element);
      else pane.el.prepend(element);
      changed = true;
    }
    previous = element;
  }
  for (const stale of existing.values()) {
    stale.remove();
    changed = true;
  }
  const has = entries.length > 0;
  if (!visible) { pane.unseen += arrived; pane.rendered ||= has; return; }
  welcomeEl.classList.toggle('hidden', has);
  document.querySelector('.chat')?.classList.toggle('has-conversation', has);
  if (has) pane.rendered = true;
  if (switched && wasRendered) {
    messagesEl.scrollTop = pane.scroll;
    renderJump();
  } else if (changed && follow) {
    followBottom = false;
    scrollToBottom('auto');
  } else {
    unseen += arrived;
    renderJump();
  }
  threadRendered = pane.rendered;
  pane.unseen = unseen;
}

messagesEl.addEventListener('scroll', renderJump, { passive: true });
jumpButton.onclick = () => scrollToBottom(scrollBehavior());
messagesEl.addEventListener('animationend', e => {
  if (e.target instanceof HTMLElement) e.target.classList.remove('msg-enter', 'search-hit');
});
messagesEl.addEventListener('click', e => {
  const copy = e.target instanceof Element ? e.target.closest('.code-copy') : null;
  if (!(copy instanceof HTMLButtonElement)) return;
  e.stopPropagation();
  const code = copy.closest('.code-block')?.querySelector('code')?.textContent ?? '';
  navigator.clipboard.writeText(code).then(() => {
    copy.textContent = 'Copié';
    window.setTimeout(() => { copy.textContent = 'Copier'; }, 1400);
  }, () => toast('Copie impossible ici : sélectionnez le code pour le copier.'));
});

function showSearch(): void {
  openPlay('Rechercher', `<input id="search-input" type="search" autocomplete="off" placeholder="Un mot, un nom, une idée…" aria-label="Rechercher dans le fil">
<p class="secondary-note" id="search-note">Messages et versions actuelles des livrables, sur cet ordinateur.</p>
<div class="search-results" id="search-results" role="list"></div>`, () => {
    const input = q('#search-input', HTMLInputElement);
    const results = q('#search-results', HTMLDivElement);
    const note = q('#search-note', HTMLParagraphElement);
    const run = () => {
      const hits = view ? searchThread(view, input.value) : [];
      results.replaceChildren(...hits.map(hit => {
        const row = make('button', 'search-hit-row');
        row.type = 'button';
        row.setAttribute('role', 'listitem');
        const where = hit.target.kind === 'version' ? `livrable · version ${hit.target.n}` : hit.target.role === 'user' ? 'vous' : 'réponse';
        const head = make('small', '', `${botName(hit.botId)} · ${where} · ${formatDate(hit.createdAt)}`);
        const snippet = make('span');
        snippet.append(hit.snippet.before, make('mark', '', hit.snippet.match), hit.snippet.after);
        row.append(head, snippet);
        row.onclick = () => jumpTo(hit);
        return row;
      }));
      note.textContent = !input.value.trim() ? 'Messages et versions actuelles des livrables, sur cet ordinateur.'
        : hits.length ? `${hits.length >= 50 ? '50 premiers résultats' : `${hits.length} résultat${hits.length > 1 ? 's' : ''}`}` : 'Aucun résultat.';
    };
    input.oninput = run;
    input.onkeydown = e => {
      if (e.key === 'Enter') results.querySelector<HTMLButtonElement>('button')?.click();
    };
    requestAnimationFrame(() => input.focus());
  }, 'search-sheet');
}

function jumpTo(hit: Hit): void {
  playDialog.close();
  if (hit.threadBotId !== activeId && botById(hit.threadBotId)) {
    selectBot(hit.threadBotId);
    renderPicker();
  }
  const key = hit.target.kind === 'version' ? `card:${hit.target.workId}` : `${hit.target.role}:${hit.target.messageId}`;
  const element = messagesEl.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!(element instanceof HTMLElement)) {
    toast('Ce passage n’est plus dans le fil.');
    return;
  }
  if (hit.target.kind === 'version') {
    const work = workById(hit.target.workId);
    const current = work ? currentVersion(work) : undefined;
    if (current && current.id !== hit.target.versionId) toast(`Ce livrable a changé depuis : la version ${current.n} est affichée.`);
  }
  element.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  element.classList.remove('search-hit');
  void element.offsetWidth;
  element.classList.add('search-hit');
  if (reducedMotion.matches) window.setTimeout(() => element.classList.remove('search-hit'), 1600);
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    showSearch();
  }
});

// Indicators and drawers.
let workFilter: 'all' | 'open' | 'review' | 'done' = 'all';

function renderIndicators(): void {
  if (!view) return;
  const open = view.works.filter(w => w.state === 'pending' || w.state === 'running' || w.state === 'review');
  const review = view.works.filter(w => w.state === 'review' && w.threadBotId === activeId);
  const toggle = byId('work-toggle', HTMLButtonElement);
  toggle.textContent = 'Travaux' + (open.length ? ' · ' + open.length : '');
  toggle.setAttribute('aria-label', `${open.length} travaux ouverts, ${review.length} à valider`);
  const strip = byId('work-return', HTMLButtonElement);
  const attention = view.tasks.filter(t => t.threadBotId === activeId && ATTENTION.has(t.status) && t.id !== panelTaskId);
  strip.classList.toggle('hidden', !review.length && !attention.length);
  strip.dataset.taskId = attention[0]?.id ?? '';
  const label = strip.querySelector('span');
  if (label) {
    const first = attention[0];
    label.textContent = first
      ? `Document « ${taskTitle(first)} » : ${TASK_STATUS_LABELS[first.status].toLowerCase()}${attention.length > 1 ? ` (+${attention.length - 1})` : ''}`
      : review.length === 1 ? 'Un travail attend votre validation' : `${review.length} travaux attendent votre validation`;
  }
  const error = byId('connection-error', HTMLParagraphElement);
  error.hidden = view.engine.state !== 'unavailable';
  error.textContent = view.engine.state === 'unavailable' ? 'Connexion au moteur indisponible.' : '';
}

function renderWorkDrawer(): void {
  if (!view) return;
  const list = byId('work-list', HTMLDivElement);
  const filtered = [...view.works].reverse().filter(w => workFilter === 'all'
    || (workFilter === 'open' && (w.state === 'pending' || w.state === 'running'))
    || (workFilter === 'review' && w.state === 'review')
    || (workFilter === 'done' && w.state === 'done'));
  list.replaceChildren();
  if (!filtered.length) list.append(make('p', 'work-empty', view.works.length ? 'Aucun travail dans cette vue.' : 'Aucun travail.'));
  for (const work of filtered) {
    const row = make('article', 'work-row');
    const main = make('button', 'work-row-main');
    main.type = 'button';
    main.append(make('span', `work-state-dot state-${STATE_CLASSES[work.state]}`));
    const label = make('span');
    label.append(make('strong', '', work.title), make('small', '', `${botName(work.botId)} · ${STATE_LABELS[work.state]}${work.attempts > 1 ? ` · ${work.attempts} essais` : ''}`));
    main.append(label, make('span', 'work-row-chevron', '›'));
    const facts = attemptFacts(work);
    if (facts.length) {
      const details = make('div', 'work-row-facts');
      for (const fact of facts) details.append(make('small', '', fact));
      label.append(details);
    }
    const task = work.taskId ? taskById(work.taskId) : undefined;
    main.onclick = () => {
      workDrawer.close();
      if (task) openTask(task.id);
      else cardIntoView(work.id);
    };
    const rowActions = make('div', 'work-row-actions');
    if (task) {
      label.append(make('small', 'work-row-task', `Document · ${TASK_STATUS_LABELS[task.status]}`));
      row.append(main, rowActions);
      list.append(row);
      continue;
    }
    if ((work.state === 'failed' || work.state === 'cancelled') && botById(work.botId)) rowActions.append(button('Relancer', () => void dispatch({ type: 'work.retry', workId: work.id })));
    if (work.state === 'pending' || work.state === 'running') rowActions.append(button('Annuler', () => void dispatch({ type: 'work.cancel', workId: work.id })));
    if (work.state === 'review') rowActions.append(button('Valider', () => void dispatch({ type: 'work.accept', workId: work.id })));
    if (work.versions.length > 1) rowActions.append(button(`${work.versions.length} versions`, () => { workDrawer.close(); showVersions(work.id); }));
    row.append(main, rowActions);
    list.append(row);
  }
  byId('work-filters', HTMLDivElement).querySelectorAll<HTMLButtonElement>('button').forEach(b => b.classList.toggle('selected', b.dataset.filter === workFilter));
}

const number = (value: number) => value.toLocaleString('fr-CA');

function attemptFacts(work: WorkView): string[] {
  const attempt = work.attempt;
  if (!attempt) return [];
  const facts: string[] = [];
  const plan = attempt.plan;
  if (plan) {
    const parts = [
      plan.exchanges.full ? `${plan.exchanges.full} échange${plan.exchanges.full > 1 ? 's' : ''} récent${plan.exchanges.full > 1 ? 's' : ''}` : '',
      plan.exchanges.brief ? `${plan.exchanges.brief} abrégé${plan.exchanges.brief > 1 ? 's' : ''}` : '',
      plan.exchanges.omitted ? `${plan.exchanges.omitted} omis` : '',
      plan.deliverable.kind === 'excerpt' ? `livrable en extrait (${number(plan.deliverable.omittedChars)} caractères omis)` : plan.deliverable.kind === 'complete' ? 'livrable complet' : '',
      plan.attachments.count ? `${plan.attachments.count} fichier${plan.attachments.count > 1 ? 's' : ''} complet${plan.attachments.count > 1 ? 's' : ''}` : '',
    ].filter(Boolean);
    facts.push(`Contexte ${CONTEXT_SIZE_LABELS[plan.contextSize].toLocaleLowerCase('fr')} : ${parts.length ? parts.join(', ') : 'aucun échange précédent'} · ${number(plan.baseChars + plan.inputChars)} caractères envoyés`);
  }
  const usage = attempt.usage;
  facts.push(usage
    ? `Codex : ${number(usage.total.input)} jetons d’entrée dont ${number(usage.total.cachedInput)} en cache, ${number(usage.total.output)} de sortie dont ${number(usage.total.reasoningOutput)} de raisonnement`
    : attempt.state === 'running' ? 'Consommation : pas encore reçue' : 'Consommation : non fournie par Codex');
  return facts;
}

function showWorkDrawer(filter: typeof workFilter = 'all'): void {
  workFilter = filter;
  renderWorkDrawer();
  if (!workDrawer.open) workDrawer.showModal();
}

let creationFilter = 'all';

type Creation = { id: string; title: string; kind: 'deliverable' | 'carnet'; bot: string; date: string; text: string; meta: string };

function renderCreations(): void {
  if (!view) return;
  const search = byId('creation-search', HTMLInputElement).value.trim().toLocaleLowerCase('fr');
  const deliverables: Creation[] = view.works.flatMap(w => {
    const v = currentVersion(w);
    return v ? [{ id: w.id, title: v.title, kind: 'deliverable' as const, bot: botName(w.botId), date: v.createdAt, text: v.body, meta: `v${v.n} · ${STATE_LABELS[w.state]}` }] : [];
  });
  const carnet: Creation[] = view.carnet.map((p: PublicationView) => ({
    id: p.id, title: p.title, kind: 'carnet', bot: botName(p.botId), date: p.createdAt, text: p.body, meta: `Carnet · v${p.versionN}`,
  }));
  const all = [...deliverables, ...carnet]
    .filter(c => (creationFilter === 'all' || (creationFilter === 'deliverables' && c.kind === 'deliverable') || (creationFilter === 'carnet' && c.kind === 'carnet'))
      && (!search || `${c.title} ${c.bot}`.toLocaleLowerCase('fr').includes(search)))
    .sort((a, b) => b.date.localeCompare(a.date));
  byId('creations-count', HTMLParagraphElement).textContent = `${deliverables.length} livrable${deliverables.length > 1 ? 's' : ''} · ${carnet.length} dans le Carnet`;
  byId('creation-filters', HTMLDivElement).querySelectorAll<HTMLButtonElement>('button').forEach(b => {
    b.classList.toggle('selected', b.dataset.creationFilter === creationFilter);
    b.setAttribute('aria-selected', String(b.dataset.creationFilter === creationFilter));
  });
  const grid = byId('creation-grid', HTMLDivElement);
  grid.replaceChildren();
  if (!all.length) {
    const empty = make('div', 'creations-empty');
    empty.append(make('strong', '', search || creationFilter !== 'all' ? 'Aucun résultat' : 'Aucun livrable.'));
    grid.append(empty);
  }
  for (const c of all) {
    const card = make('button', 'creation-card');
    card.type = 'button';
    const thumb = make('span', 'creation-thumbnail');
    thumb.append(make('span', 'creation-preview-doc', c.text.slice(0, 150)));
    card.append(thumb, make('span', 'creation-card-title', c.title), make('span', 'creation-card-meta', `${c.kind === 'carnet' ? 'Carnet' : 'Livrable'} · ${c.bot}`),
      make('span', 'creation-card-date', `${formatDate(c.date)} · ${c.meta}`));
    card.onclick = () => showCreation(c);
    grid.append(card);
  }
}

function showCreation(c: Creation): void {
  creationsDrawer.close();
  const path = c.kind === 'carnet' ? `/api/publications/${c.id}/download` : `/api/versions/${workById(c.id)?.versions.at(-1)?.id ?? ''}/download`;
  const publication = view?.carnet.find(p => p.id === c.id);
  openPlay(c.title, `<p class="secondary-note">${escapeMarkup(c.kind === 'carnet' ? 'Copie figée publiée dans le Carnet local. Elle ne change pas si le livrable est modifié ou restauré.' : 'Version actuelle du livrable.')}</p>
<div class="approval-content" id="creation-body"></div>
${publication ? `<p class="secondary-note">Empreinte SHA-256 : ${escapeMarkup(publication.payloadSha256)}</p>` : ''}
<div class="creation-result-actions"><button type="button" id="creation-in-chat">Retrouver dans le fil</button><button type="button" id="creation-download">Télécharger</button></div>`, () => {
    const body = q('#creation-body', HTMLDivElement);
    if (htmlDocument(c.text)) {
      body.className = 'html-creation';
      const source = make('pre', 'html-readonly-code', c.text);
      body.append(htmlView({resource:path.replace(/\/download$/, ''),title:c.title,source,key:`creation:${c.id}`,workId:publication?.workId ?? c.id}));
    } else body.textContent = `${c.title}\n\n${c.text}`;
    q('#creation-in-chat', HTMLButtonElement).onclick = () => {
      playDialog.close();
      cardIntoView(publication?.workId ?? c.id);
    };
    q('#creation-download', HTMLButtonElement).onclick = () => download(path);
  });
  playDialog.dataset.workId = publication?.workId ?? c.id;
}

function showCreations(): void {
  if (workDrawer.open) workDrawer.close();
  creationFilter = 'all';
  byId('creation-search', HTMLInputElement).value = '';
  renderCreations();
  if (!creationsDrawer.open) creationsDrawer.showModal();
}

function showAbout(): void {
  const engine = view?.engine;
  const state = engine?.state === 'ready' ? 'Codex est connecté avec votre compte ChatGPT.'
    : engine?.state === 'unavailable' ? engine.message : 'Connexion à Codex en cours…';
  openPlay('Mino, sur cet ordinateur', `<p>${escapeMarkup(state)}</p>
<ul class="about-list">
<li>Les messages, travaux, versions, mémoires et publications sont enregistrés dans une base locale.</li>
<li>Codex transmet au service du modèle le contexte nécessaire à votre demande. Cet appel utilise Internet.</li>
<li>Le travail continue si vous fermez l’onglet. Il s’arrête si le serveur Mino s’arrête ; un appel interrompu devient « Échoué » et se relance à la main.</li>
<li>Un invité lit le fil où vous l’appelez, avec ses propres consignes et sa mémoire. Son fil personnel reste séparé.</li>
<li>Un document se rédige en arrière-plan sur une seconde connexion Codex : le fil reste libre. Avec une relecture choisie, le premier bot transmet son document enregistré au second, puis reçoit son avis : trois appels au plus, et deux reprises explicites au maximum.</li>
<li>Seuls le document et les messages enregistrés passent d’un bot à l’autre. Les mémoires et les autres fils restent séparés. Deux bots qui relisent la même source ne vérifient pas les faits de façon indépendante.</li>
<li>Les outils sont désactivés : aucune lecture de fichier, recherche web ou action externe par le bot.</li>
<li>Pièces jointes : fichiers texte seulement. Images, PDF, audio, recherche web, routines, notifications, envois et connecteurs ne sont pas disponibles.</li>
<li>Le Carnet est local : publier n’envoie rien à personne.</li>
</ul>`);
}

byId('work-toggle', HTMLButtonElement).onclick = () => showWorkDrawer();
byId('work-return', HTMLButtonElement).onclick = () => {
  const taskId = byId('work-return', HTMLButtonElement).dataset.taskId;
  if (taskId) openTask(taskId);
  else showWorkDrawer('review');
};
byId('work-drawer-close', HTMLButtonElement).onclick = () => workDrawer.close();
byId('work-filters', HTMLDivElement).querySelectorAll<HTMLButtonElement>('button').forEach(b => {
  b.onclick = () => {
    const filter = b.dataset.filter;
    if (filter === 'all' || filter === 'open' || filter === 'review' || filter === 'done') workFilter = filter;
    renderWorkDrawer();
  };
});
byId('creations-close', HTMLButtonElement).onclick = () => creationsDrawer.close();
byId('creation-search', HTMLInputElement).oninput = renderCreations;
byId('creation-filters', HTMLDivElement).querySelectorAll<HTMLButtonElement>('button').forEach(b => {
  b.onclick = () => {
    creationFilter = b.dataset.creationFilter ?? 'all';
    renderCreations();
  };
});
byId('files-nav', HTMLButtonElement).onclick = showCreations;
const showProjects = mountProjects({ csrf: () => csrf, refreshSession, toast });
const chatMissions = createChatMissions({ csrf: () => csrf, refreshSession, bots: () => view?.bots ?? [], messages: () => view?.messages ?? [], projects: showProjects });
byId('search-nav', HTMLButtonElement).onclick = showSearch;
byId('chat-nav', HTMLButtonElement).onclick = () => promptEl.focus();
byId('home-button', HTMLButtonElement).onclick = () => {
  scrollToBottom(scrollBehavior());
  promptEl.focus();
};
for (const id of ['settings-button', 'project-button']) byId(id, HTMLButtonElement).onclick = showAbout;
byId('profile-button', HTMLButtonElement).onclick = showAbout;
byId('export', HTMLButtonElement).onclick = () => download(`/api/export?threadBotId=${encodeURIComponent(activeId)}`);
const threadMenu = () => openActions('Conversation', [
  ['Rechercher dans le fil', showSearch],
  ['Vos travaux', () => showWorkDrawer()],
  ['Créations et Carnet', showCreations],
  ['Projets et missions', showProjects],
  ['Exporter le fil', () => download(`/api/export?threadBotId=${encodeURIComponent(activeId)}`)],
  ['À propos de Mino', showAbout],
]);
byId('thread-menu', HTMLButtonElement).onclick = threadMenu;
byId('more', HTMLButtonElement).onclick = threadMenu;
byId('edit-bot', HTMLButtonElement).onclick = () => showBotSettings();
byId('model-button', HTMLButtonElement).onclick = () => showModelSheet(activeId);
document.querySelectorAll<HTMLButtonElement>('.suggestion').forEach(b => {
  b.onclick = () => {
    promptEl.value = previousPrompt = b.dataset.prompt ?? '';
    pendingMentions = [];
    if (b.dataset.document === 'true') docMode = { reviewerBotId: null };
    renderMentions();
    renderDocOptions();
    if (composerBotId) rememberPrompt();
    fitPrompt();
    promptEl.focus();
  };
});

const PROMPT_MAX_PX = 220;
let followBottom = false;

function fitPrompt(): void {
  if (CSS.supports('field-sizing', 'content')) return;
  promptEl.style.height = 'auto';
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, PROMPT_MAX_PX)}px`;
}

let pendingMentions: MentionSpan[] = [];
let previousPrompt = '';
let pendingFiles: DraftFile[] = [];
let composerBotId = '';
let sending: { botId: string } | null = null;
let docMode: { reviewerBotId: string | null } | null = null;
let docHintDismissed = false;
let docOptionsSig = '';
const docModeButton = byId('doc-mode', HTMLButtonElement);
const docOptions = byId('doc-options', HTMLDivElement);

function setDocMode(next: { reviewerBotId: string | null } | null): void {
  docMode = next;
  if (composerBotId) rememberPrompt();
  renderDocOptions();
  if (next) promptEl.focus();
}
docModeButton.onclick = () => setDocMode(docMode ? null : { reviewerBotId: null });

function renderDocOptions(): void {
  const author = botById(composerBotId);
  if (docMode?.reviewerBotId && (!botById(docMode.reviewerBotId) || docMode.reviewerBotId === composerBotId)) docMode = { reviewerBotId: null };
  docModeButton.setAttribute('aria-pressed', String(Boolean(docMode)));
  docModeButton.classList.toggle('active', Boolean(docMode));
  if (author) promptEl.placeholder = docMode ? `Décrivez le document que ${author.name} doit préparer…` : `Écrire à ${author.name}…`;
  const hint = !docMode && !docHintDismissed && looksLikeDocumentRequest(promptEl.value);
  const reviewers = bots().filter(b => b.id !== composerBotId);
  const sig = JSON.stringify([docMode, hint, author?.name, reviewers.map(b => [b.id, b.name]), pendingMentions.length > 0]);
  if (sig === docOptionsSig) return;
  docOptionsSig = sig;
  form.classList.toggle('doc-mode-on', Boolean(docMode));
  if (docMode && author) {
    const select = make('select', 'doc-reviewer');
    select.id = 'doc-reviewer';
    select.setAttribute('aria-label', 'Relecture par un autre bot');
    select.append(new Option('Sans relecture · 1 appel', ''), ...reviewers.map(b => new Option(`Relecture par ${b.name} · 3 appels au plus`, b.id)));
    select.value = docMode.reviewerBotId ?? '';
    select.onchange = () => {
      docMode = { reviewerBotId: select.value || null };
      rememberPrompt();
    };
    docOptions.replaceChildren(make('span', 'doc-options-label', `Document durable : ${author.name} le rédige en arrière-plan, le fil reste libre.`), select,
      button('Quitter le mode document', () => setDocMode(null), 'doc-options-off'));
    if (pendingMentions.length) docOptions.append(make('small', 'doc-options-warning', 'Les @ ne s’appliquent pas à un document : retirez-les ou quittez ce mode.'));
    docOptions.hidden = false;
  } else if (hint) {
    docOptions.replaceChildren(make('span', 'doc-options-label', 'Cela ressemble à une demande de document.'),
      button('Préparer en document', () => setDocMode({ reviewerBotId: null }), 'doc-suggestion'),
      button('Non, discuter', () => {
        docHintDismissed = true;
        renderDocOptions();
      }, 'doc-suggestion-dismiss'));
    docOptions.hidden = false;
  } else {
    docOptions.replaceChildren();
    docOptions.hidden = true;
  }
}

const mentionMenu = make('div', 'mention-menu');
mentionMenu.setAttribute('role', 'listbox'); mentionMenu.id = 'mention-menu'; mentionMenu.hidden = true;
const recipients = make('p', 'mention-recipients'); recipients.title = 'Seules les mentions choisies dans le menu invitent un bot. Les anciens onglets doivent être rechargés pour les conserver.'; recipients.setAttribute('aria-live', 'polite');
promptEl.after(mentionMenu, recipients);
promptEl.setAttribute('aria-controls', 'mention-menu');
promptEl.setAttribute('aria-autocomplete', 'list');
promptEl.setAttribute('aria-haspopup', 'listbox');
let mentionIndex = 0;
let mentionDismissed = false;
/** References kept in a draft whose bot no longer exists. They block sending until removed; nothing is rerouted. */
function deadMentions(): MentionSpan[] {
  return view ? pendingMentions.filter(m => !botById(m.botId)) : [];
}

function renderMentions(): void {
  const ids = pendingMentions.length ? [...new Set(pendingMentions.map(m => m.botId))] : [composerBotId];
  const dead = deadMentions();
  recipients.hidden = !pendingMentions.length;
  recipients.classList.toggle('mention-blocked', dead.length > 0);
  if (dead.length) {
    const tags = [...new Set(dead.map(m => promptEl.value.slice(m.start, m.end)))].join(', ');
    recipients.replaceChildren(`${tags} ${dead.length > 1 ? 'désignent des bots supprimés' : 'désigne un bot supprimé'}. Rien ne part tant que cette mention n’est pas retirée. `,
      button('Retirer la mention', () => {
        pendingMentions = pendingMentions.filter(m => botById(m.botId));
        rememberPrompt();
        renderMentions();
        promptEl.focus();
      }));
  } else {
    recipients.textContent = `${ids.length === 1 ? 'Réponse de' : 'Réponses de'} ${ids.map(id => botById(id)?.name ?? 'Bot indisponible').join(', ')}`;
  }
  renderComposerState();
  const query = mentionQuery(promptEl.value, promptEl.selectionStart);
  const term = query ? fold(query.query) : '';
  const choices = query ? (view?.bots.filter(b => fold(b.name).includes(term)) ?? [])
    .sort((a, b) => Number(fold(b.name).startsWith(term)) - Number(fold(a.name).startsWith(term))) : [];
  mentionMenu.hidden = mentionDismissed || !query || !choices.length;
  promptEl.setAttribute('aria-expanded', String(!mentionMenu.hidden));
  mentionMenu.replaceChildren();
  promptEl.removeAttribute('aria-activedescendant');
  if (mentionMenu.hidden || !query) return;
  mentionIndex = (mentionIndex % choices.length + choices.length) % choices.length;
  choices.forEach((bot, index) => {
    const homonym = choices.some(other => other.id !== bot.id && other.name === bot.name);
    const option = button('', () => {
      const inserted = insertMention(promptEl.value, { start: query.start, caret: promptEl.selectionStart }, bot);
      pendingMentions = [...rebase(promptEl.value, inserted.text, pendingMentions), inserted.span].sort((a, b) => a.start - b.start);
      promptEl.value = previousPrompt = inserted.text;
      promptEl.setSelectionRange(inserted.caret, inserted.caret);
      mentionDismissed = true; rememberPrompt(); renderMentions(); fitPrompt(); promptEl.focus();
    });
    const label = make('span', 'mention-option-label');
    label.append(make('strong', '', bot.name), make('small', '', [bot.title, ...(homonym ? ['#' + bot.id.slice(-6)] : [])].filter(Boolean).join(' · ')));
    option.id = `mention-option-${bot.id}`;
    if (index === mentionIndex) promptEl.setAttribute('aria-activedescendant', option.id);
    option.append(mascot(bot), label); option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(index === mentionIndex));
    option.onpointerdown = e => e.preventDefault();
    mentionMenu.append(option);
  });
}
promptEl.addEventListener('click', () => { mentionDismissed = false; renderMentions(); });
promptEl.addEventListener('compositionend', renderMentions);

function promptScope(botId: string) {
  return { kind: 'prompt', botId } as const;
}

function rememberPrompt(): Capture {
  const capture = drafts.write(promptScope(composerBotId), { text: promptEl.value, files: pendingFiles, mentions: pendingMentions, ...(docMode ? { document: docMode } : {}) });
  renderDraftStatus();
  renderComposerState();
  return capture;
}

function showComposerFor(botId: string): void {
  if (composerBotId === botId) return;
  const firstBot = composerBotId === '';
  composerBotId = botId;
  const saved = drafts.read(promptScope(botId));
  if (firstBot && !saved && (promptEl.value || pendingFiles.length)) {
    rememberPrompt();
  } else {
    promptEl.value = saved?.text ?? '';
    pendingFiles = saved?.files ?? [];
    pendingMentions = saved?.mentions ?? [];
    docMode = saved?.document ?? null;
    previousPrompt = promptEl.value;
  }
  docHintDismissed = false;
  previousPrompt = promptEl.value;
  renderMentions();
  renderPendingFiles();
  renderPromptOthers();
  renderComposerState();
  fitPrompt();
}

function renderDraftStatus(): void {
  const note = byId('draft-status', HTMLParagraphElement);
  const status = drafts.status();
  note.hidden = status === 'durable';
  note.textContent = status === 'full'
    ? 'Brouillon non conservé : le stockage de ce navigateur est plein. Il reste dans cette page.'
    : status === 'unavailable' ? 'Brouillon non conservé : ce navigateur bloque le stockage local. Il reste dans cette page.' : '';
}

function renderPromptOthers(): void {
  const holder = byId('draft-others', HTMLDivElement);
  const scope = promptScope(composerBotId);
  const [other] = drafts.others(scope);
  holder.hidden = !other;
  if (!other) return;
  const preview = other.content.text.replace(/\s+/g, ' ').trim();
  holder.replaceChildren(
    make('span', '', `Autre brouillon (${formatTime(other.savedAt)}) : « ${preview.length > 48 ? preview.slice(0, 47) + '…' : preview || `${other.content.files.length} fichier(s)`} »`),
    button('Reprendre', () => {
      const current = drafts.read(scope);
      const adopted = drafts.adopt(scope, other.id);
      if (!adopted) return;
      const merged = current && (current.text || current.files.length)
        ? { text: current.text ? `${current.text}\n\n${adopted.text}` : adopted.text, files: [...current.files, ...adopted.files].slice(0, LIMITS.attachments), mentions: [...(current.mentions ?? []), ...(adopted.mentions ?? []).map(m => ({ ...m, start: m.start + (current.text ? current.text.length + 2 : 0), end: m.end + (current.text ? current.text.length + 2 : 0) }))] }
        : adopted;
      promptEl.value = merged.text;
      pendingFiles = merged.files;
      pendingMentions = merged.mentions ?? [];
      previousPrompt = merged.text;
      renderMentions();
      renderPendingFiles();
      rememberPrompt();
      renderPromptOthers();
      fitPrompt();
      promptEl.focus();
    }),
    button('Ignorer', () => {
      drafts.dismiss(scope, other.id);
      renderPromptOthers();
    }),
  );
}

function renderPendingFiles(): void {
  const holder = byId('pending-assets', HTMLDivElement);
  holder.classList.toggle('hidden', !pendingFiles.length);
  holder.replaceChildren(...pendingFiles.map((file, index) => {
    const chip = make('div', 'pending-asset');
    const label = make('span', 'pending-asset-open');
    label.append(make('span', 'asset-mini-icon', '¶'), make('span', '', file.name));
    chip.append(label, button('×', () => {
      pendingFiles = pendingFiles.filter((_, i) => i !== index);
      renderPendingFiles();
      rememberPrompt();
    }, 'remove-asset'));
    chip.lastElementChild?.setAttribute('aria-label', `Retirer ${file.name}`);
    return chip;
  }));
}

async function addFiles(files: FileList | File[]): Promise<void> {
  const botId = composerBotId;
  const added: DraftFile[] = [];
  for (const file of [...files]) {
    if (pendingFiles.length + added.length >= LIMITS.attachments) {
      toast(`${LIMITS.attachments} fichiers au maximum par message.`);
      break;
    }
    const looksText = file.type.startsWith('text/') || /json|xml|yaml|toml|javascript|typescript/.test(file.type) || TEXT_EXTENSIONS.test(file.name);
    if (!looksText) {
      toast(`« ${file.name} » n’est pas un fichier texte. Images, PDF et audio ne sont pas encore pris en charge.`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast(`« ${file.name} » dépasse 500 Ko. Il n’a pas été joint.`);
      continue;
    }
    const text = await file.text();
    if (text.includes('\u0000')) {
      toast(`« ${file.name} » ne semble pas être du texte.`);
      continue;
    }
    if (text.length > LIMITS.attachmentChars) {
      toast(`« ${file.name} » fait ${text.length} caractères : la limite est de ${LIMITS.attachmentChars}. Il n’a pas été joint ; découpez-le ou collez l’extrait utile.`);
      continue;
    }
    added.push({ name: file.name.slice(0, LIMITS.attachmentNameChars), text });
  }
  if (!added.length) return;
  if (botId !== composerBotId) {
    const saved = drafts.read(promptScope(botId)) ?? { text: '', files: [] };
    drafts.write(promptScope(botId), { ...saved, files: [...saved.files, ...added] });
    toast(`Fichier joint au brouillon de ${botById(botId)?.name ?? 'l’autre bot'}.`);
    return;
  }
  pendingFiles = [...pendingFiles, ...added];
  renderPendingFiles();
  rememberPrompt();
}

const fileInput = byId('file', HTMLInputElement);
byId('attach', HTMLButtonElement).onclick = () => fileInput.click();
fileInput.onchange = () => {
  if (fileInput.files) void addFiles(fileInput.files).then(() => { fileInput.value = ''; });
};
const form = byId('form', HTMLFormElement);
const sendButton = byId('send', HTMLButtonElement);
form.addEventListener('dragover', e => e.preventDefault());
form.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer?.files.length) void addFiles(e.dataTransfer.files);
});

function renderComposerState(): void {
  const empty = !promptEl.value.trim() || !botById(composerBotId);
  const busy = sending !== null;
  sendButton.disabled = empty || busy || deadMentions().length > 0;
  form.classList.toggle('is-sending', busy);
  sendButton.setAttribute('aria-label', busy ? 'Envoi en cours' : 'Envoyer');
}

form.onsubmit = e => {
  e.preventDefault();
  const botId = composerBotId;
  const prepared = trimForSend(promptEl.value, pendingMentions);
  const text = prepared.text;
  if (!text || !botById(botId) || sending) return;
  if (deadMentions().length) {
    toast('Retirez la mention du bot supprimé avant d’envoyer.');
    return;
  }
  if (docMode && prepared.spans.length) {
    toast('Un document est rédigé par le bot de ce fil : retirez les @ ou quittez le mode document.');
    return;
  }
  const capture = rememberPrompt();
  const attachments = pendingFiles;
  const documentMode = docMode;
  sending = { botId };
  renderComposerState();
  followBottom = true;
  void dispatch({ type: 'message.send', botId, text, attachments, mentions: prepared.spans, ...(documentMode ? { document: { reviewerBotId: documentMode.reviewerBotId } } : {}) }).then(sent => {
    sending = null;
    if (!sent.ok) {
      const pane = panes.get(botId);
      if (pane) pane.follow = false;
      if (composerBotId === botId) followBottom = false;
    }
    if (sent.ok && drafts.acknowledge(capture) && composerBotId === botId) {
      promptEl.value = '';
      previousPrompt = '';
      pendingMentions = [];
      renderMentions();
      pendingFiles = [];
      renderPendingFiles();
      docMode = null;
      docHintDismissed = false;
      renderDocOptions();
      fitPrompt();
    }
    if (sent.ok && sent.result.kind === 'message' && sent.result.taskId && wideLayout.matches) openTask(sent.result.taskId);
    renderDraftStatus();
    renderComposerState();
    if (composerBotId === botId) promptEl.focus();
  });
};
promptEl.addEventListener('input', () => {
  pendingMentions = rebase(previousPrompt, promptEl.value, pendingMentions);
  previousPrompt = promptEl.value;
  mentionDismissed = false;
  if (!promptEl.value.trim()) docHintDismissed = false;
  renderMentions();
  renderDocOptions();
  if (composerBotId) rememberPrompt();
  else renderComposerState();
  fitPrompt();
});
renderComposerState();
promptEl.addEventListener('keydown', e => {
  if (e.isComposing || e.keyCode === 229) return;
  if (!mentionMenu.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); mentionDismissed = true; renderMentions(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mentionIndex += e.key === 'ArrowDown' ? 1 : -1; renderMentions(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mentionMenu.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.click(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    form.requestSubmit();
  }
});
window.addEventListener('storage', e => {
  if (e.key !== null && !e.key.startsWith('mino.draft.') && !e.key.startsWith('mino.seen.')) return;
  renderPromptOthers();
  for (const card of messagesEl.querySelectorAll('[data-work-id]')) card.dispatchEvent(new Event('drafts-changed'));
});

const reconciled = new Set<string>();

/**
 * Drops this page's copies of what a bot deletion erased: panes, sheets, uncertain sends, search copies and
 * every tab's drafts for exactly the listed bot and work identifiers. Other drafts are left alone, even when
 * their work is absent from this view, because another database on the same origin may own them.
 */
function reconcilePurged(next: AppView): void {
  drafts.useSpace(next.spaceId);
  const botIds = next.purged.botIds.filter(id => !reconciled.has(`b:${id}`));
  const workIds = next.purged.workIds.filter(id => !reconciled.has(`w:${id}`));
  if (!botIds.length && !workIds.length) return;
  drafts.purge(next.spaceId, [
    ...botIds.map(botId => ({ kind: 'prompt', botId }) as const),
    ...workIds.map(workId => ({ kind: 'version', workId }) as const),
  ]);
  for (const id of botIds) {
    reconciled.add(`b:${id}`);
    uncertainSends.delete(id);
    panes.get(id)?.el.remove();
    panes.delete(id);
    if (mountedThread === id) mountedThread = '';
    if (composerBotId === id) {
      clearTimeout(renameTimer);
      promptEl.value = previousPrompt = '';
      pendingFiles = [];
      pendingMentions = [];
      composerBotId = '';
      renderPendingFiles();
    }
  }
  for (const id of workIds) { reconciled.add(`w:${id}`); htmlModes.delete(`work:${id}`); htmlModes.delete(`creation:${id}`); }
  for (const [taskId] of editors) {
    if (next.tasks.some(t => t.id === taskId)) continue;
    editors.delete(taskId);
    intentInputs.delete(taskId);
    intentForms.delete(taskId);
    streams.delete(taskId);
    previews.delete(taskId);
    for (const key of [...parts.keys()]) if (key.startsWith(`${taskId}:`)) parts.delete(key);
    if (panelTaskId === taskId) panelTaskId = '';
  }
  if (playDialog.open && (botIds.includes(playDialog.dataset.botId ?? '') || workIds.includes(playDialog.dataset.workId ?? ''))) playDialog.close();
  forgetSearch();
  const search = playDialog.open ? playContent.querySelector('#search-input') : null;
  if (search) search.dispatchEvent(new Event('input'));
}

function renderErasure(): void {
  const holder = byId('erasure-status', HTMLDivElement);
  const incomplete = view?.erasure === 'incomplete';
  holder.hidden = !incomplete;
  if (!incomplete || holder.childElementCount) return;
  holder.append(make('span', '', 'Une suppression n’est pas terminée : Mino n’a pas encore retiré sa sauvegarde automatique ni nettoyé son journal.'),
    button('Réessayer', () => void dispatch({ type: 'storage.purge' }).then(sent => {
      if (sent.ok && sent.result.kind === 'purge') toast(sent.result.erased ? 'Nettoyage terminé. La suppression est définitive.' : 'Le nettoyage a encore échoué. Vérifiez le dossier de données de Mino puis réessayez.');
    })));
}

/** With no bot left, the only way forward is creating one; old bots never come back. */
function renderEmpty(): void {
  const empty = bots().length === 0;
  byId('empty-bots', HTMLDivElement).hidden = !empty;
  document.querySelector('.suggestions')?.toggleAttribute('hidden', empty);
  promptEl.disabled = empty;
  byId('attach', HTMLButtonElement).disabled = empty;
  byId('model-button', HTMLButtonElement).disabled = empty;
  if (!empty) return;
  byId('picker-label', HTMLSpanElement).textContent = 'Aucun bot';
  byId('model-button', HTMLButtonElement).textContent = 'Codex';
  promptEl.placeholder = 'Créez un bot pour écrire.';
  renderComposerState();
}

// View loop.
function applyView(next: AppView): void {
  if (view && next.rev < view.rev && next.rev !== 0) return;
  const firstView = view === null;
  view = next;
  reconcilePurged(next);
  if (firstView || !botById(activeId)) activeId = next.bots.some(bot => bot.id === 'mino') ? 'mino' : next.activeBotId;
  renderPicker();
  renderEmpty();
  renderMentions();
  renderThread();
  renderPanel();
  renderDocOptions();
  renderIndicators();
  renderErasure();
  if (workDrawer.open) renderWorkDrawer();
  if (creationsDrawer.open) renderCreations();
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || !panelTaskId || e.defaultPrevented) return;
  if (document.querySelector('dialog[open]')) return;
  if (!docPanel.contains(document.activeElement) && wideLayout.matches) return;
  closePanel();
});

async function poll(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`/api/view?after=${view?.rev ?? -1}`);
      const body: unknown = await response.json();
      if (isAppView(body)) {
        if (view && body.rev < view.rev) view = null;
        applyView(body);
      }
    } catch {
      const error = byId('connection-error', HTMLParagraphElement);
      error.hidden = false;
      error.textContent = 'Connexion à Mino interrompue.';
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

async function boot(): Promise<void> {
  const [symbols, catalogue] = await Promise.all([
    fetch('/assets/symbols.svg').then(r => r.text()),
    fetch('/assets/mascots.json').then(r => r.json()),
  ]);
  byId('symbols', HTMLDivElement).innerHTML = symbols;
  if (typeof catalogue === 'object' && catalogue !== null && 'shapes' in catalogue && Array.isArray(catalogue.shapes) && 'colors' in catalogue && Array.isArray(catalogue.colors)) {
    mascots = {
      shapes: catalogue.shapes.filter((s: unknown): s is Mascots['shapes'][number] => typeof s === 'object' && s !== null && 'id' in s && 'label' in s && 'defaultColor' in s),
      colors: catalogue.colors.filter((c: unknown): c is string => typeof c === 'string'),
    };
  }
  fan.classList.add('no-motion');
  void poll();
  requestAnimationFrame(() => requestAnimationFrame(() => fan.classList.remove('no-motion')));
}

void boot();
