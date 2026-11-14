import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  CARNET_DESTINATION,
  EngineReplySchema,
  PUBLISH_ACTION,
  STANDARD_SPEED,
  type BotChoice,
  type CatalogModel,
  type EngineReply,
  type ResolvedChoice,
  type UsageSnapshot,
  type WorkState,
} from './protocol.js';

const TRANSITIONS: Record<WorkState, readonly WorkState[]> = {
  pending: ['running', 'cancelled'],
  running: ['review', 'done', 'failed', 'cancelled'],
  review: ['review', 'done'],
  done: ['review', 'done'],
  failed: ['pending'],
  cancelled: ['pending'],
};

export function canTransition(from: WorkState, to: WorkState): boolean {
  return TRANSITIONS[from].includes(to);
}

const DOCUMENT_TRANSITIONS: Partial<Record<WorkState, readonly WorkState[]>> = {
  pending: ['review'],
  review: ['running'],
  failed: ['review'],
  cancelled: ['review'],
};

export function canTransitionDocument(from: WorkState, to: WorkState): boolean {
  return canTransition(from, to) || (DOCUMENT_TRANSITIONS[from]?.includes(to) ?? false);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function parseEngineReply(raw: string): EngineReply | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = EngineReplySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function publicationPayload(input: { workId: string; versionId: string; title: string; body: string }): string {
  return JSON.stringify({
    action: PUBLISH_ACTION,
    destination: CARNET_DESTINATION,
    workId: input.workId,
    versionId: input.versionId,
    title: input.title,
    body: input.body,
  });
}

export type ChoiceResolution = { ok: true; choice: ResolvedChoice } | { ok: false; message: string };

export function resolveChoice(models: readonly CatalogModel[], choice: BotChoice): ChoiceResolution {
  const model = choice.model === null ? models.find(m => m.isDefault) : models.find(m => m.id === choice.model);
  if (!model) {
    return {
      ok: false,
      message: choice.model === null
        ? 'Codex n’annonce aucun modèle par défaut. Choisissez un modèle dans les réglages du bot.'
        : `Codex ne propose plus le modèle « ${choice.model} ». Choisissez un autre modèle dans les réglages du bot.`,
    };
  }
  const effort = choice.effort ?? model.defaultEffort;
  if (!model.efforts.includes(effort)) {
    return { ok: false, message: `L’effort « ${effort} » n’est pas proposé pour ${model.displayName}.` };
  }
  if (choice.speed !== STANDARD_SPEED && !model.speeds.some(speed => speed.id === choice.speed)) {
    return { ok: false, message: `La vitesse choisie n’est pas proposée pour ${model.displayName}.` };
  }
  return { ok: true, choice: { model: model.id, effort, speed: choice.speed } };
}

export const ENGINE_ERRORS = {
  codex_missing: 'Codex est introuvable sur cet ordinateur. Installez Codex ou indiquez son chemin avec MINO_CODEX_BIN.',
  codex_start_failed: 'Codex n’a pas pu démarrer. Vérifiez que la commande codex fonctionne dans un terminal.',
  unsafe_config: 'Codex n’a pas confirmé que ses outils sont désactivés. Mino refuse de lancer l’appel.',
  not_chatgpt: 'Codex n’est pas connecté avec un compte ChatGPT. Lancez « codex login » avec ChatGPT ; Mino n’utilise pas de clé API.',
  choice_unavailable: 'Le réglage de modèle de ce bot n’est pas proposé par Codex.',
  rpc_refused: 'Codex a refusé de démarrer l’appel avec ce réglage.',
  tool_blocked: 'Codex a tenté d’utiliser un outil. Mino l’a bloqué et a arrêté l’appel.',
  request_refused: 'Codex a demandé une autorisation que Mino refuse toujours. L’appel est arrêté.',
  invalid_output: 'La réponse de Codex ne respectait pas le format attendu. Aucune réponse n’a été enregistrée.',
  timeout: 'Codex n’a pas répondu à temps. L’appel est arrêté.',
  engine_exited: 'Codex s’est arrêté pendant l’appel.',
  usage_limit: 'La limite d’utilisation de votre compte est atteinte. Réessayez plus tard.',
  unauthorized: 'La session Codex n’est plus valide. Relancez « codex login » avec ChatGPT.',
  model_not_found: 'Ce modèle n’est pas accessible avec votre compte.',
  overloaded: 'Le service est saturé pour le moment. Réessayez dans quelques minutes.',
  too_long: 'La demande est trop longue pour ce modèle.',
  connection_failed: 'Connexion au service impossible. Vérifiez votre accès à Internet.',
  turn_failed: 'Codex a signalé un échec sans réponse.',
  interrupted: 'Mino s’est arrêté pendant cet appel. Relancez-le quand vous voulez.',
  admission_refused: 'Mino n’a pas admis cet appel. Rien n’est parti.',
  memory_changed: 'La mémoire de cette conversation a changé pendant cet appel : une source a été corrigée, exclue ou oubliée. Mino n’a rien publié. Relancez la demande.',
} as const;

export type EngineErrorCode = keyof typeof ENGINE_ERRORS;

export type EngineOutcome =
  | { kind: 'succeeded'; reply: EngineReply; used: ResolvedChoice; threadId: string; turnId: string }
  | { kind: 'failed'; code: EngineErrorCode; message: string }
  | { kind: 'cancelled' };

/** One `thread/tokenUsage/updated` notification, parsed. It may arrive before or after the turn ends. */
export type UsageObservation = { threadId: string; turnId: string; usage: Omit<UsageSnapshot, 'receivedAt'> };

export function engineFailure(code: EngineErrorCode, message: string = ENGINE_ERRORS[code]): EngineOutcome {
  return { kind: 'failed', code, message };
}

const MascotCatalogueSchema = z.object({
  shapes: z.array(z.object({ id: z.string(), label: z.string(), symbol: z.string(), defaultColor: z.string().regex(/^#[0-9a-f]{6}$/) })).length(18),
  colors: z.array(z.string().regex(/^#[0-9a-f]{6}$/)).min(1),
});
export type MascotCatalogue = z.infer<typeof MascotCatalogueSchema>;

export function loadMascots(path: string | URL): MascotCatalogue {
  return MascotCatalogueSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export const SEED_BOTS = [
  { id: 'mino', name: 'Mino', title: 'votre partenaire de création', shape: 'sprout' },
  { id: 'pixel', name: 'Pixel', title: 'votre regard design', shape: 'carrot' },
  { id: 'atlas', name: 'Atlas', title: 'le code, simplement', shape: 'mushroom' },
  { id: 'nova', name: 'Nova', title: 'votre compagnon d’idées', shape: 'radish' },
] as const;

export function workTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? line.slice(0, 59) + '…' : line;
}

type MentionSpan = import('./protocol.js').MentionSpan;
export function checkMentions(text: string, spans: readonly MentionSpan[]): MentionSpan[] | null {
  let end = 0;
  for (const span of spans) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < end || span.start < 0 || span.start + 1 >= span.end || span.end > text.length || text[span.start] !== '@') return null;
    end = span.end;
  }
  return [...spans];
}
export function replyTargets(threadBotId: string, spans: readonly MentionSpan[]): string[] {
  return spans.length ? [...new Set(spans.map(span => span.botId))] : [threadBotId];
}
