import { AttachmentSchema, type Attachment, type MentionSpan } from '../src/protocol.js';
/**
 * Browser-local drafts. Each page instance is a writer that only ever creates, rewrites or deletes its own keys;
 * other writers' drafts are copied on reload or request, or hidden by a marker that belongs to the reader.
 * The one exception is `purge`: the person deleted a bot, so every writer's copy of exactly those scopes goes.
 */

export type KeyValueStorage = {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  setDeferred?(key: string, value: () => string): void;
  durable?(): boolean;
  committed?(key: string): boolean;
  flush?(key: string): Promise<boolean>;
  removeItem(key: string): void;
};

export type DraftFile = Attachment;
/** `document` keeps the composer's document mode and reviewer with the draft it was chosen for. */
export type PromptContent = { text: string; files: DraftFile[]; mentions?: MentionSpan[]; document?: { reviewerBotId: string | null } };
/** `baseVersionId` is null for a document typed before any version existed. */
export type VersionContent = { baseVersionId: string | null; title: string; body: string };

export type DraftScope = { kind: 'prompt'; botId: string } | { kind: 'version'; workId: string };
type ContentOf<S extends DraftScope> = S extends { kind: 'prompt' } ? PromptContent : VersionContent;

/** What was captured at a given moment; acknowledging it removes the draft only if nothing changed since. */
export type Capture = { readonly scopeKey: string; readonly nonce: string };

export type ForeignDraft<S extends DraftScope> = { id: string; savedAt: number; content: ContentOf<S> };

/** `durable`: written to this browser. `unavailable` or `full`: kept in this page only. */
export type DraftStatus = 'durable' | 'unavailable' | 'full';

export type DraftBook = {
  readonly writerId: string;
  status(): DraftStatus;
  read<S extends DraftScope>(scope: S): ContentOf<S> | null;
  write<S extends DraftScope>(scope: S, content: ContentOf<S>): Capture;
  acknowledge(capture: Capture): boolean;
  discard(scope: DraftScope): void;
  others<S extends DraftScope>(scope: S): ForeignDraft<S>[];
  adopt<S extends DraftScope>(scope: S, id: string): ContentOf<S> | null;
  dismiss(scope: DraftScope, id: string): void;
  /** From now on, scopes marked gone in this space are never read, offered or written. */
  useSpace(spaceId: string): void;
  /** Marks these scopes gone for this space, then removes every writer's draft and marker for them. Nothing else. */
  purge(spaceId: string, scopes: readonly DraftScope[]): void;
};

const DRAFT = 'mino.draft.v2|';
const SEEN = 'mino.seen.v2|';
const LEGACY_DRAFT = 'mino.draft.v1|';
const LEGACY_SEEN = 'mino.seen.v1|';
const LEGACY_SPACE = 'mino.legacy-space.v1';
const GONE = 'mino.gone.v1|';
const SESSION_WRITER = 'mino.writer';

type Stored = { nonce: string; savedAt: number; content: unknown };

function scopeKey(scope: DraftScope): string {
  return scope.kind === 'prompt' ? `prompt:${scope.botId}` : `version:${scope.workId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isFile(value: unknown): value is DraftFile {
  return AttachmentSchema.safeParse(value).success;
}

function isMentionSpan(value: unknown): value is MentionSpan {
  return isRecord(value) && typeof value.botId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value.botId)
    && typeof value.start === 'number' && Number.isSafeInteger(value.start) && value.start >= 0
    && typeof value.end === 'number' && Number.isSafeInteger(value.end) && value.end > 0;
}

function parseContent<S extends DraftScope>(scope: S, value: unknown): ContentOf<S> | null;
function parseContent(scope: DraftScope, value: unknown): PromptContent | VersionContent | null {
  if (!isRecord(value)) return null;
  if (scope.kind === 'prompt') {
    if (typeof value.text !== 'string' || !Array.isArray(value.files) || !value.files.every(isFile)) return null;
    const mentions = value.mentions ?? [];
    if (!Array.isArray(mentions) || !mentions.every(isMentionSpan)) return null;
    const document = isRecord(value.document) && (value.document.reviewerBotId === null || typeof value.document.reviewerBotId === 'string')
      ? { document: { reviewerBotId: value.document.reviewerBotId } } : {};
    return { ...(value.mentions === undefined ? {} : { mentions: mentions.map(m => ({ botId: m.botId, start: m.start, end: m.end })) }), ...document, text: value.text, files: value.files.map(file => AttachmentSchema.parse(file)) };
  }
  if ((typeof value.baseVersionId !== 'string' && value.baseVersionId !== null) || typeof value.title !== 'string' || typeof value.body !== 'string') return null;
  return { baseVersionId: value.baseVersionId, title: value.title, body: value.body };
}

function parseStored(raw: string | null): Stored | null {
  const value = parseJson(raw);
  if (!isRecord(value) || typeof value.nonce !== 'string' || typeof value.savedAt !== 'number') return null;
  return { nonce: value.nonce, savedAt: value.savedAt, content: value.content };
}

function isEmpty(content: PromptContent | VersionContent): boolean {
  return 'text' in content && content.text === '' && content.files.length === 0 && !content.document;
}

function isQuota(error: unknown): boolean {
  return isRecord(error) && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

export function openDrafts(options: {
  local: KeyValueStorage | null;
  session: KeyValueStorage | null;
  now?: () => number;
  randomId?: () => string;
}): DraftBook {
  const now = options.now ?? (() => Date.now());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const local = options.local;
  let status: DraftStatus = local ? 'durable' : 'unavailable';
  const writerId = randomId();
  const failedDrafts = new Map<string, Exclude<DraftStatus, 'durable'>>();

  const get = (key: string): string | null => {
    try {
      return local?.getItem(key) ?? null;
    } catch {
      status = 'unavailable';
      return null;
    }
  };
  const set = (key: string, value: string | (() => string), draft = false): boolean => {
    if (!local) return false;
    try {
      if (typeof value === 'function' && local.setDeferred) local.setDeferred(key, value);
      else local.setItem(key, typeof value === 'function' ? value() : value);
      if (draft) {
        failedDrafts.delete(key);
        status = 'durable';
      }
      return local.committed?.(key) ?? true;
    } catch (error) {
      status = isQuota(error) ? 'full' : 'unavailable';
      if (draft) failedDrafts.set(key, status);
      return false;
    }
  };
  const remove = (key: string): void => {
    try {
      local?.removeItem(key);
      failedDrafts.delete(key);
    } catch {
      status = 'unavailable';
    }
  };
  const keys = (): string[] => {
    if (!local) return [];
    try {
      return Array.from({ length: local.length }, (_, i) => local.key(i)).filter((key): key is string => key !== null);
    } catch {
      status = 'unavailable';
      return [];
    }
  };

  let space: string | null = null;
  let draftPrefix = `${DRAFT}unbound:${writerId}|`;
  let ownPrefix = `${draftPrefix}${writerId}|`;
  let seenPrefix = `${SEEN}unbound:${writerId}|${writerId}|`;
  const goneHere = new Set<string>();
  const isGone = (key: string): boolean => space !== null && (goneHere.has(key) || get(`${GONE}${encodeURIComponent(space)}|${key}`) !== null);
  const seen = new Map<string, string>();
  const foreignCache = new Map<string, { raw: string | null; stored: Stored | null; content: PromptContent | VersionContent | null }>();
  const own = new Map<string, { nonce: string; content: unknown; persisted: boolean }>();

  function markSeen(id: string, nonce: string, persist = true): void {
    seen.set(id, nonce);
    if (persist) set(seenPrefix + id, nonce);
  }


  function persistSeenAfterCommit(draftKey: string, id: string, nonce: string): void {
    const marker = seenPrefix + id;
    void local?.flush?.(draftKey).then(saved => {
      if (saved) set(marker, nonce);
    });
  }

  function useSpace(spaceId: string): void {
    if (space === spaceId) return;
    space = spaceId;
    goneHere.clear();
    own.clear();
    foreignCache.clear();
    seen.clear();
    failedDrafts.clear();
    const encodedSpace = encodeURIComponent(spaceId);
    draftPrefix = `${DRAFT}${encodedSpace}|`;
    const seenRoot = `${SEEN}${encodedSpace}|`;
    ownPrefix = `${draftPrefix}${writerId}|`;
    seenPrefix = `${seenRoot}${writerId}|`;

    // V1 had one namespace for the entire origin. Bind it once; never import it into a second database.
    const legacyKeys = keys().filter(key => key.startsWith(LEGACY_DRAFT) || key.startsWith(LEGACY_SEEN));
    let legacySpace = get(LEGACY_SPACE);
    if (legacySpace === null && legacyKeys.length && set(LEGACY_SPACE, spaceId)) legacySpace = spaceId;
    if (legacySpace === spaceId) {
      for (const key of legacyKeys) {
        const raw = get(key);
        if (raw === null) continue;
        if (isGone(key.slice(key.lastIndexOf('|') + 1))) { remove(key); continue; }
        const target = key.startsWith(LEGACY_DRAFT)
          ? draftPrefix + key.slice(LEGACY_DRAFT.length)
          : seenRoot + key.slice(LEGACY_SEEN.length).replace(LEGACY_DRAFT, draftPrefix);
        const existing = get(target);
        const oldDraft = key.startsWith(LEGACY_DRAFT) ? parseStored(raw) : null;
        const newDraft = oldDraft ? parseStored(existing) : null;
        if (newDraft && oldDraft && newDraft.savedAt > oldDraft.savedAt) remove(key);
        else if (set(target, raw, oldDraft !== null)) remove(key);
      }
    }

    let previous: string | null = null;
    try {
      const value = options.session?.getItem(`${SESSION_WRITER}|${encodedSpace}`)
        ?? (legacySpace === spaceId ? options.session?.getItem(SESSION_WRITER) : null);
      if (value && /^[A-Za-z0-9-]{8,80}$/.test(value)) previous = value;
      options.session?.setItem(`${SESSION_WRITER}|${encodedSpace}`, writerId);
    } catch {
    }
    if (!previous) return;
    const previousDrafts = `${draftPrefix}${previous}|`;
    const previousSeen = `${seenRoot}${previous}|`;
    const snapshot = keys();
    for (const key of snapshot) {
      if (!key.startsWith(previousSeen)) continue;
      const nonce = get(key);
      if (nonce !== null) markSeen(key.slice(previousSeen.length), nonce);
    }
    for (const key of snapshot) {
      if (!key.startsWith(previousDrafts)) continue;
      const stored = parseStored(get(key));
      if (!stored) continue;
      const scope = key.slice(previousDrafts.length);
      if (isGone(scope)) continue;
      const copy = { ...stored, nonce: randomId() };
      const persisted = set(ownPrefix + scope, JSON.stringify(copy), true);
      own.set(scope, { ...copy, persisted });
      markSeen(key, stored.nonce, persisted);
      if (!persisted) persistSeenAfterCommit(ownPrefix + scope, key, stored.nonce);
    }
  }

  function read<S extends DraftScope>(scope: S): ContentOf<S> | null {
    if (isGone(scopeKey(scope))) return null;
    const entry = own.get(scopeKey(scope));
    return entry ? parseContent(scope, entry.content) : null;
  }

  function write<S extends DraftScope>(scope: S, content: ContentOf<S>): Capture {
    const key = scopeKey(scope);
    const nonce = randomId();
    if (isEmpty(content) || isGone(key)) {
      own.delete(key);
      remove(ownPrefix + key);
      return { scopeKey: key, nonce };
    }
    const savedAt = now();
    const serialize = () => JSON.stringify({ nonce, savedAt, content });
    const persisted = set(ownPrefix + key, 'files' in content && content.files.length ? serialize : serialize(), true);
    own.set(key, { nonce, content, persisted });
    return { scopeKey: key, nonce };
  }

  function acknowledge(capture: Capture): boolean {
    const entry = own.get(capture.scopeKey);
    if (!entry || entry.nonce !== capture.nonce) return false;
    own.delete(capture.scopeKey);
    remove(ownPrefix + capture.scopeKey);
    return true;
  }

  function foreign(scope: DraftScope): { id: string; stored: Stored }[] {
    const key = scopeKey(scope);
    if (isGone(key)) return [];
    return keys().flatMap(storageKey => {
      if (!storageKey.startsWith(draftPrefix) || storageKey.startsWith(ownPrefix) || !storageKey.endsWith(`|${key}`)) return [];
      const raw = get(storageKey);
      let cached = foreignCache.get(storageKey);
      if (!cached || cached.raw !== raw) {
        const stored = parseStored(raw);
        cached = { raw, stored, content: stored ? parseContent(scope, stored.content) : null };
        foreignCache.set(storageKey, cached);
      }
      const stored = cached.stored;
      if (!stored || seen.get(storageKey) === stored.nonce) return [];
      return [{ id: storageKey, stored }];
    });
  }

  function others<S extends DraftScope>(scope: S): ForeignDraft<S>[] {
    return foreign(scope)
      .flatMap(({ id, stored }) => {
        const content = foreignCache.get(id)?.content as ContentOf<S> | null;
        return content ? [{ id, savedAt: stored.savedAt, content }] : [];
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  function dismiss(scope: DraftScope, id: string): void {
    const found = foreign(scope).find(entry => entry.id === id);
    if (found) markSeen(id, found.stored.nonce);
  }

  function adopt<S extends DraftScope>(scope: S, id: string): ContentOf<S> | null {
    const found = foreign(scope).find(entry => entry.id === id);
    const content = found ? parseContent(scope, found.stored.content) : null;
    if (!found || !content) return null;
    write(scope, content);
    const persisted = own.get(scopeKey(scope))?.persisted ?? false;
    markSeen(id, found.stored.nonce, persisted);
    if (!persisted) persistSeenAfterCommit(ownPrefix + scopeKey(scope), id, found.stored.nonce);
    return content;
  }

  return {
    writerId,
    status: () => local?.durable?.() === false ? 'unavailable' : [...failedDrafts.values()].includes('unavailable') ? 'unavailable' : failedDrafts.size ? 'full' : status,
    read,
    write,
    acknowledge,
    discard(scope) {
      own.delete(scopeKey(scope));
      remove(ownPrefix + scopeKey(scope));
    },
    others,
    adopt,
    dismiss,
    useSpace,
    purge(spaceId, scopes) {
      useSpace(spaceId);
      const targets = new Set(scopes.map(scopeKey));
      for (const key of targets) {
        goneHere.add(key);
        set(`${GONE}${encodeURIComponent(spaceId)}|${key}`, '1');
        own.delete(key);
        failedDrafts.delete(ownPrefix + key);
      }
      for (const key of keys()) {
        if (!key.startsWith(draftPrefix) && !key.startsWith(`${SEEN}${encodeURIComponent(spaceId)}|`)) continue;
        const scope = key.slice(key.lastIndexOf('|') + 1);
        if (targets.has(scope)) remove(key);
      }
      for (const [id] of foreignCache) if (targets.has(id.slice(id.lastIndexOf('|') + 1))) foreignCache.delete(id);
      for (const [id] of seen) if (targets.has(id.slice(id.lastIndexOf('|') + 1))) seen.delete(id);
    },
  };
}
