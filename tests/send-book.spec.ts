import { test, expect } from "@playwright/test";
import type { KeyValueStorage } from "../server/web/drafts";
import type { AppOutcome } from "../src/port";
import type { Sendable } from "../src/chat/pending";
import { openSendBook } from "../src/chat/send-book";

const unknown: AppOutcome = { kind: "unknown", message: "inconnu" };
// The book reads no view fields. A synthetic view stays outside the persisted receipt.
const accepted = (id: string): AppOutcome => ({
  kind: "accepted",
  replayed: false,
  result: { kind: "message", messageId: `message-${id}`, workId: `work-${id}` },
  view: JSON.parse("{}"),
});
function browser() {
  const items = new Map<string, string>();
  const state = { fail: false, items };
  const storage: KeyValueStorage = {
    get length() {
      return items.size;
    },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (k) => items.get(k) ?? null,
    setItem(k, v) {
      if (state.fail) throw Error("quota");
      items.set(k, v);
    },
    removeItem(k) {
      if (state.fail) throw Error("quota");
      items.delete(k);
    },
  };
  return { state, storage };
}
function input(text = "Texte relu", botId = "nova") {
  return {
    command: {
      type: "message.say",
      requestId: crypto.randomUUID(),
      botId,
      text,
      attachments: [],
    } satisfies Sendable,
    raw: { text: ` ${text} `, files: [] },
    draftNonce: crypto.randomUUID(),
  };
}
function page(
  storage: KeyValueStorage | null,
  send: (c: Sendable) => Promise<AppOutcome> = async () => unknown,
  extra: Partial<Parameters<typeof openSendBook>[0]> = {},
) {
  return openSendBook({ spaceId: "space-a", storage, send, ...extra });
}
function deferred() {
  let resolve: (o: AppOutcome) => void = () => {
    throw Error("not initialized");
  };
  const promise = new Promise<AppOutcome>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
type Op = "length" | "key" | "getItem" | "setItem" | "removeItem";
function relay(
  storage: KeyValueStorage,
  before: (op: Op, key?: string) => void,
): KeyValueStorage {
  return {
    get length() {
      before("length");
      return storage.length;
    },
    key(i) {
      before("key");
      return storage.key(i);
    },
    getItem(k) {
      before("getItem", k);
      return storage.getItem(k);
    },
    setItem(k, v) {
      before("setItem", k);
      storage.setItem(k, v);
    },
    removeItem(k) {
      before("removeItem", k);
      storage.removeItem(k);
    },
  };
}
const refusal: AppOutcome = {
  kind: "rejected",
  status: 503,
  message: "occupé",
};
const holding = (items: Map<string, string>, text: string) =>
  [...items.values()].filter((value) => value.includes(text));

test("deux écrivains gardent deux demandes du même bot après rechargement", async () => {
  const { storage } = browser();
  const a = input("A"),
    b = input("B");
  const first = page(storage),
    second = page(storage);
  expect(first.writerId).not.toBe(second.writerId);
  await Promise.all([first.run(a), second.run(b)]);
  expect(page(storage).snapshot()).toHaveLength(2);
  expect(
    page(storage)
      .snapshot()
      .map((r) => r.command),
  ).toEqual(expect.arrayContaining([a.command, b.command]));
  expect(
    page(storage)
      .snapshot()
      .map((r) => r.raw.text),
  ).toEqual(expect.arrayContaining([a.raw.text, b.raw.text]));
});

test("le gel est durable avant le départ, sans renvoi automatique au rechargement", async () => {
  const { storage } = browser();
  const a = input();
  const sent: Sendable[] = [];
  const book = page(storage, async (c) => {
    sent.push(c);
    expect(page(storage).snapshot()).toMatchObject([
      {
        command: a.command,
        draftNonce: a.draftNonce,
        fact: { kind: "queued" },
      },
    ]);
    return unknown;
  });
  await book.run(a);
  const recovered = page(storage);
  expect(sent).toEqual([a.command]);
  expect(recovered.snapshot()).toMatchObject([
    { fact: { kind: "unknown" }, durability: { frozen: true, fact: true } },
  ]);
  expect(recovered.writerId).not.toBe(book.writerId);
});

test("reprise explicite conserve les octets et refuse un contenu divergent", async () => {
  const { storage } = browser();
  const a = input();
  await page(storage).run(a);
  const sent: string[] = [];
  const restored = page(storage, async (c) => {
    sent.push(JSON.stringify(c));
    return accepted("a");
  });
  const [saved] = restored.snapshot();
  await restored.run(saved);
  expect(sent).toEqual([JSON.stringify(a.command)]);
  expect(
    await restored.run({
      ...a,
      command: { ...a.command, text: "Autre intention" },
    }),
  ).toEqual({ kind: "blocked", reason: "conflict" });
  expect(sent).toHaveLength(1);
  expect(page(storage).snapshot()).toMatchObject([
    { fact: { kind: "accepted", receipt: { workId: "work-a" } } },
  ]);
});

test("une réponse inconnue tardive ne fait pas régresser une acceptation d’un autre onglet", async () => {
  const { storage } = browser();
  const a = input();
  const late = deferred();
  const first = page(storage, () => late.promise);
  const pending = first.run(a);
  await page(storage, async () => accepted("a")).run(a);
  late.resolve(unknown);
  await pending;
  for (const book of [first, page(storage)])
    expect(book.snapshot()).toMatchObject([
      { fact: { kind: "accepted", receipt: { messageId: "message-a" } } },
    ]);
});

test("des réponses hors ordre gardent chacune leur reçu", async () => {
  const { storage } = browser();
  const a = input("Document"),
    b = input("Chat");
  const one = deferred(),
    two = deferred();
  const book = page(storage, (c) =>
    c.requestId === a.command.requestId ? one.promise : two.promise,
  );
  const pendingA = book.run(a),
    pendingB = book.run(b);
  two.resolve(accepted("b"));
  await pendingB;
  one.resolve(accepted("a"));
  await pendingA;
  const rows = page(storage).snapshot();
  expect(
    rows.find((r) => r.command.requestId === a.command.requestId)?.fact,
  ).toEqual({
    kind: "accepted",
    receipt: { kind: "message", messageId: "message-a", workId: "work-a" },
  });
  expect(
    rows.find((r) => r.command.requestId === b.command.requestId)?.fact,
  ).toMatchObject({ receipt: { workId: "work-b" } });
});

test("absence ou échec de stockage avant départ bloque le POST et conserve le brouillon", async () => {
  const { storage, state } = browser();
  state.fail = true;
  for (const local of [storage, null]) {
    let sent = false;
    const a = input();
    const book = page(local, async () => {
      sent = true;
      return unknown;
    });
    expect((await book.run(a)).kind).toBe("blocked");
    expect(sent).toBe(false);
    expect(book.snapshot()).toMatchObject([
      { raw: a.raw, durability: { frozen: false } },
    ]);
  }
});

test("une panne après départ ne transforme pas une acceptation en refus", async () => {
  const { storage, state } = browser();
  const a = input();
  const book = page(storage, async () => {
    state.fail = true;
    return accepted("a");
  });
  expect(await book.run(a)).toMatchObject({
    kind: "settled",
    outcome: { kind: "accepted" },
    entry: {
      fact: { kind: "accepted" },
      durability: { frozen: true, fact: false },
    },
  });
  expect(book.status()).toBe("storage-error");
  expect(page(storage).snapshot()).toMatchObject([
    { command: a.command, fact: { kind: "queued" } },
  ]);
  state.fail = false;
  await page(storage, async (c) => {
    expect(c).toEqual(a.command);
    return accepted("a");
  }).run(a);
  expect(page(storage).snapshot()).toMatchObject([
    { fact: { kind: "accepted" } },
  ]);
});

test("un transport levé garde l’identité incertaine malgré le refus d’un rejeu", async () => {
  const { storage } = browser();
  const a = input();
  await page(storage, async () => {
    throw Error("réseau");
  }).run(a);
  expect(page(storage).snapshot()).toMatchObject([
    { fact: { kind: "unknown" } },
  ]);
  await page(storage, async () => ({
    kind: "rejected",
    status: 403,
    message: "refus",
  })).run(a);
  expect(page(storage).snapshot()).toMatchObject([
    { fact: { kind: "unknown" } },
  ]);
  const b = input("Autre demande refusée");
  await page(storage, async () => ({
    kind: "rejected",
    status: 403,
    message: "refus",
  })).run(b);
  expect(
    page(storage)
      .snapshot()
      .find((row) => row.command.requestId === b.command.requestId),
  ).toMatchObject({ fact: { kind: "refused", reason: "rejected" } });
});

test("les snapshots et le runner ne peuvent pas modifier la commande figée", async () => {
  const { storage } = browser();
  const a = input();
  const book = page(storage, async (c) => {
    c.text = "mutation";
    return unknown;
  });
  await book.run(a);
  a.command.text = "autre mutation";
  const snapshot = book.snapshot();
  snapshot[0].command.text = "snapshot muté";
  expect(book.snapshot()[0].command.text).toBe("Texte relu");
  expect(page(storage).snapshot()[0].command.text).toBe("Texte relu");
});

test("la purge isole espaces et bots et bloque une réponse après suppression", async () => {
  const { storage } = browser();
  const late = deferred();
  const a = input(),
    b = input("B", "mino");
  const book = page(storage, () => late.promise);
  const pending = book.run(a);
  await page(storage).run(b);
  await page(storage, undefined, { spaceId: "space-b" }).run(a);
  page(storage).purge(["nova"]);
  late.resolve(accepted("a"));
  await pending;
  expect(book.snapshot()).toMatchObject([{ command: b.command }]);
  expect(page(storage).snapshot("nova")).toEqual([]);
  expect(
    page(storage, undefined, { spaceId: "space-b" }).snapshot(),
  ).toHaveLength(1);
  expect(await book.run(a)).toEqual({ kind: "blocked", reason: "purged" });
});

test("les lignes corrompues et commandes sensibles ne deviennent pas des envois", async () => {
  const { storage, state } = browser();
  const a = input();
  await page(storage).run(a);
  const stored = [...state.items.entries()][0];
  const row = JSON.parse(stored[1]);
  state.items.set(stored[0], "{");
  expect(page(storage).snapshot()).toEqual([]);
  for (const command of [
    { type: "tools.approve", requestId: a.command.requestId },
    { ...a.command, document: { reviewerBotId: null }, type: "message.send" },
  ]) {
    state.items.set(stored[0], JSON.stringify({ ...row, command }));
    expect(page(storage).snapshot()).toEqual([]);
  }
  state.items.set(stored[0], JSON.stringify({ ...row, spaceId: "space-b" }));
  expect(page(storage).snapshot()).toEqual([]);
});

test("capacité et TTL protègent les inconnus et travaux ouverts", async () => {
  const { storage } = browser();
  let time = 0;
  const a = input("inconnu"),
    b = input("ouvert"),
    c = input("nouveau");
  const book = page(
    storage,
    async (command) =>
      command.requestId === a.command.requestId ? unknown : accepted("b"),
    { now: () => time, capacity: 2, ttlMs: 10 },
  );
  await book.run(a);
  await book.run(b);
  time = 100;
  book.collect([]);
  expect(book.snapshot()).toHaveLength(2);
  expect(await book.run(c)).toEqual({ kind: "blocked", reason: "saturated" });
  book.collect([a.command.requestId]);
  expect(book.snapshot()).toHaveLength(2);
  page(storage).collect([b.command.requestId]);
  expect(book.snapshot()).toMatchObject([
    { command: a.command, fact: { kind: "unknown" } },
  ]);
  book.collect([b.command.requestId]);
  expect(page(storage).snapshot()).toMatchObject([{ command: a.command }]);
  expect((await book.run(c)).kind).toBe("settled");
});

test("deux gestes simultanés identiques partagent le même départ", async () => {
  const { storage } = browser();
  const a = input();
  const result = deferred();
  const sent: Sendable[] = [];
  const book = page(storage, (c) => {
    sent.push(c);
    return result.promise;
  });
  const first = book.run(a),
    second = book.run(a);
  expect(sent).toEqual([a.command]);
  result.resolve(accepted("a"));
  expect(await first).toEqual(await second);
});

test("une collecte ne révèle pas un ancien inconnu d’un autre écrivain", async () => {
  const { storage } = browser();
  const a = input();
  await page(storage).run(a);
  const owner = page(storage, async () => accepted("a"), {
    now: () => 100,
    ttlMs: 0,
  });
  await owner.run(a);
  owner.collect([a.command.requestId]);
  expect(page(storage).snapshot()).toMatchObject([
    { fact: { kind: "accepted" } },
  ]);
});

test("une panne après un résultat inconnu conserve les octets pour le rejeu", async () => {
  const { storage, state } = browser();
  const a = input();
  const book = page(storage, async () => {
    state.fail = true;
    return unknown;
  });
  expect(await book.run(a)).toMatchObject({
    kind: "settled",
    entry: {
      fact: { kind: "unknown" },
      durability: { frozen: true, fact: false },
    },
  });
  expect(page(storage).snapshot()).toMatchObject([
    { command: a.command, fact: { kind: "queued" } },
  ]);
  state.fail = false;
  await book.run(a);
  expect(book.snapshot()[0].command).toEqual(a.command);
});

test("les reçus terminés d’un ancien chargement libèrent la capacité", async () => {
  const { storage } = browser();
  let time = 0;
  const options = { now: () => time, capacity: 2, ttlMs: 10 };
  const a = input("A"),
    b = input("B"),
    c = input("C");
  const first = page(
    storage,
    async (command) => accepted(command.requestId),
    options,
  );
  await first.run(a);
  await first.run(b);
  time = 100;
  const reloaded = page(
    storage,
    async (command) => accepted(command.requestId),
    options,
  );
  reloaded.collect([a.command.requestId, b.command.requestId]);
  expect(reloaded.snapshot()).toEqual([]);
  expect((await reloaded.run(c)).kind).toBe("settled");
});

test("les envois refusés sans reprise d’un ancien chargement libèrent la capacité", async () => {
  const { storage } = browser();
  let time = 0;
  const options = { now: () => time, capacity: 1, ttlMs: 10 };
  const a = input("Refus"),
    b = input("Nouvelle demande");
  await page(
    storage,
    async () => ({ kind: "rejected", status: 403, message: "refus" }),
    options,
  ).run(a);
  time = 100;
  const reloaded = page(storage, async () => accepted("b"), options);
  reloaded.collect([]);
  expect(reloaded.snapshot()).toEqual([]);
  expect((await reloaded.run(b)).kind).toBe("settled");
});

test("la purge retire le texte des anciens et futurs formats sans toucher un autre bot ou espace", async () => {
  const { storage, state } = browser();
  const a = input("Texte privé à effacer"),
    b = input("Texte conservé", "mino");
  await page(storage).run(a);
  await page(storage).run(b);
  await page(storage, undefined, { spaceId: "space-b" }).run(a);
  const legacy = (botId: string, text: string) =>
    JSON.stringify({
      spaceId: "space-a",
      writerId: "ancien",
      savedAt: 0,
      command: { ...a.command, botId, text },
      raw: { text, files: [] },
      fact: { kind: "format-futur" },
    });
  state.items.set(
    "mino.send-book.v1|space-a|ancien|1",
    legacy("nova", a.command.text),
  );
  state.items.set(
    "mino.send-book.v1|space-a|ancien|2",
    legacy("mino", b.command.text),
  );
  state.items.set("mino.send-book.v2|space-a|futur|nova|x|y", a.command.text);
  state.items.set("mino.send-book.v2|space-a|futur|mino|x|y", b.command.text);
  page(storage).purge(["nova"]);
  const remaining = holding(state.items, a.command.text);
  expect(remaining).toHaveLength(1);
  expect(JSON.parse(remaining[0]).spaceId).toBe("space-b");
  expect(holding(state.items, b.command.text)).toHaveLength(3);
  expect(page(storage).snapshot()).toMatchObject([{ command: b.command }]);
  expect(
    page(storage, undefined, { spaceId: "space-b" }).snapshot(),
  ).toHaveLength(1);
});

test("la collecte retire ensemble les copies acceptées de plusieurs écrivains", async () => {
  const { storage, state } = browser();
  const a = input();
  const options = { now: () => 0, ttlMs: 0, capacity: 1 };
  await page(storage, async () => accepted("a"), options).run(a);
  await page(storage, async () => accepted("a"), options).run(a);
  const witnesses = holding(state.items, a.command.text);
  expect(witnesses).toHaveLength(2);
  const reader = page(storage, undefined, options);
  reader.collect([a.command.requestId]);
  expect(reader.snapshot()).toEqual([]);
  expect(page(storage, undefined, options).snapshot()).toEqual([]);
  expect(holding(state.items, a.command.text)).toEqual(witnesses);
  expect(
    (await page(storage, undefined, options).run(input("Nouvelle"))).kind,
  ).toBe("settled");
  page(storage).purge(["nova"]);
  expect([...state.items.keys()]).toEqual([
    "mino.send-book.v2|space-a|gone|nova",
  ]);
});

test("un refus ne fait pas collecter une copie encore inconnue", async () => {
  const { storage, state } = browser();
  const a = input();
  await page(storage).run(a);
  await page(storage, async () => ({
    kind: "rejected",
    status: 403,
    message: "refus",
  })).run(a);
  const saved = [...state.items];
  const reader = page(storage, undefined, { ttlMs: 0 });
  reader.collect([a.command.requestId]);
  expect([...state.items]).toEqual(saved);
  expect(reader.snapshot()).toMatchObject([{ command: a.command }]);
});

test("une purge vide ne touche rien et une purge nommée retire les octets inclassables du seul espace", () => {
  const { storage, state } = browser();
  const ownKey = "mino.send-book.v1|space-a|broken|broken";
  const otherKey = "mino.send-book.v1|space-b|broken|broken";
  const ownV2 = "mino.send-book.v2|space-a|body|%E0%A4%A|w|d";
  const otherV2 = "mino.send-book.v2|space-b|body|%E0%A4%A|w|d";
  for (const key of [ownKey, otherKey, ownV2, otherV2])
    state.items.set(key, "{texte privé incomplet");
  page(storage).purge([]);
  expect(state.items.get(ownKey)).toBe("{texte privé incomplet");
  expect(state.items.get(ownV2)).toBe("{texte privé incomplet");
  page(storage).purge(["nova"]);
  expect(state.items.has(ownKey)).toBe(false);
  expect(state.items.has(ownV2)).toBe(false);
  expect(state.items.get(otherKey)).toBe("{texte privé incomplet");
  expect(state.items.get(otherV2)).toBe("{texte privé incomplet");
});

test("un refus précédent ne masque pas une reprise dont la réponse est perdue", async () => {
  const { storage } = browser();
  const a = input();
  let n = 0;
  const book = page(storage, async () =>
    ++n === 1
      ? { kind: "rejected", status: 503, message: "indisponible" }
      : unknown,
  );
  await book.run(a);
  expect(await book.run(a)).toMatchObject({
    entry: { fact: { kind: "unknown" } },
  });
  expect(page(storage).snapshot()).toMatchObject([
    { command: a.command, fact: { kind: "unknown" } },
  ]);
});

test("la collecte ne retire pas une reprise après refus arrivée au serveur sans reçu", async () => {
  const { storage } = browser();
  const a = input();
  let n = 0;
  const book = page(
    storage,
    async () =>
      ++n === 1
        ? { kind: "rejected", status: 503, message: "indisponible" }
        : unknown,
    { capacity: 1, ttlMs: 0 },
  );
  await book.run(a);
  await book.run(a);
  book.collect([]);
  expect(page(storage).snapshot()).toMatchObject([
    { command: a.command, fact: { kind: "unknown" } },
  ]);
});

test("un ancien écrivain refusé ne masque pas le départ d’une reprise dans un autre onglet", async () => {
  const { storage } = browser();
  const a = input();
  await page(storage, async () => ({
    kind: "rejected",
    status: 503,
    message: "indisponible",
  })).run(a);
  const result = deferred();
  const second = page(storage, () => result.promise, { capacity: 1, ttlMs: 0 });
  const pending = second.run(a);
  const during = page(storage).snapshot();
  second.collect([]);
  const afterCollect = page(storage).snapshot();
  result.resolve(unknown);
  await pending;
  expect(during).toMatchObject([
    { command: a.command, fact: { kind: "queued" } },
  ]);
  expect(afterCollect).toHaveLength(1);
  expect(page(storage).snapshot()).toMatchObject([
    { command: a.command, fact: { kind: "unknown" } },
  ]);
});

test("un refus du rejeu ne résout pas une ancienne incertitude sans reçu serveur", async () => {
  const { storage } = browser();
  const a = input();
  let n = 0;
  const book = page(
    storage,
    async () =>
      ++n === 1 ? unknown : { kind: "rejected", status: 403, message: "refus" },
    { capacity: 1, ttlMs: 0 },
  );
  await book.run(a);
  await book.run(a);
  book.collect([]);
  expect(page(storage).snapshot()).toMatchObject([
    { command: a.command, fact: { kind: "unknown" } },
  ]);
});

test("la purge échouée n’efface rien avant une réponse tardive d’un autre onglet", async () => {
  const { storage } = browser();
  let failMarker = false;
  let removed = 0;
  const limited: KeyValueStorage = {
    get length() {
      return storage.length;
    },
    key: (i) => storage.key(i),
    getItem: (k) => storage.getItem(k),
    setItem(k, v) {
      if (failMarker) throw Error("quota");
      storage.setItem(k, v);
    },
    removeItem(k) {
      removed++;
      storage.removeItem(k);
    },
  };
  const result = deferred();
  const a = input();
  const writer = page(limited, () => result.promise);
  const pending = writer.run(a);
  const before = page(storage).snapshot();
  failMarker = true;
  const purger = page(limited);
  purger.purge(["nova"]);
  const after = page(storage).snapshot();
  const local = purger.snapshot();
  const status = purger.status();
  failMarker = false;
  result.resolve(accepted("a"));
  await pending;
  expect(status).toBe("storage-error");
  expect(removed).toBe(0);
  expect(after).toEqual(before);
  expect(local).toHaveLength(1);
});
test("une collecte concurrente ne retire pas la nouvelle reprise d’un ancien refus", async () => {
  const { storage } = browser();
  const a = input();
  const result = deferred();
  let sent = 0;
  const writer = page(storage, async () =>
    ++sent === 1
      ? { kind: "rejected", status: 503, message: "occupé" }
      : result.promise,
  );
  await writer.run(a);
  let injected = false;
  let pending: Promise<unknown> | undefined;
  const reader: KeyValueStorage = {
    get length() {
      return storage.length;
    },
    key: (i) => storage.key(i),
    getItem(k) {
      const old = storage.getItem(k);
      if (!injected && old?.includes('"kind":"refused"')) {
        injected = true;
        pending = writer.run(a);
      }
      return old;
    },
    setItem: (k, v) => storage.setItem(k, v),
    removeItem: (k) => storage.removeItem(k),
  };
  page(reader, undefined, { capacity: 1, ttlMs: 0 }).collect([]);
  const during = page(storage).snapshot();
  result.resolve(unknown);
  if (pending) await pending;
  expect(injected).toBe(true);
  expect(sent).toBe(2);
  expect(during).toMatchObject([
    { command: a.command, fact: { kind: "queued" } },
  ]);
});

const acceptedA = {
  kind: "accepted",
  receipt: { kind: "message", messageId: "message-a", workId: "work-a" },
};

test("une collecte d’acceptation garde son reçu face à une reprise qu’elle n’a pas vue", async () => {
  const { storage } = browser();
  const a = input();
  const retry = deferred();
  let sent = 0;
  const writer = page(storage, async () =>
    ++sent === 1 ? accepted("a") : retry.promise,
  );
  await writer.run(a);
  let pending: Promise<unknown> | undefined;
  const reader = relay(storage, (op, key) => {
    if (
      !pending &&
      op === "getItem" &&
      key &&
      storage.getItem(key)?.includes('"kind":"accepted"')
    )
      pending = writer.run(a);
  });
  page(reader, undefined, { capacity: 1, ttlMs: 0 }).collect([
    a.command.requestId,
  ]);
  const during = page(storage).snapshot();
  retry.resolve(refusal);
  await pending;
  expect(sent).toBe(2);
  expect(during).toMatchObject([{ command: a.command, fact: acceptedA }]);
  expect(page(storage).snapshot()).toMatchObject([
    { command: a.command, fact: acceptedA },
  ]);
});

test("une reprise injectée avant chaque opération de la collecte garde l’identité et le reçu", async () => {
  const cases = [
    {
      name: "refus",
      first: refusal,
      late: unknown,
      proof: false,
      during: { kind: "queued" },
      after: { kind: "unknown" },
    },
    {
      name: "acceptation",
      first: accepted("a"),
      late: refusal,
      proof: true,
      during: acceptedA,
      after: acceptedA,
    },
  ];
  for (const c of cases)
    for (const samePage of [false, true]) {
      const attempt = async (step: number) => {
        const { storage } = browser();
        const a = input();
        const retry = deferred();
        let sent = 0;
        const send = async () => (++sent === 1 ? c.first : retry.promise);
        let ops = 0;
        let armed = false;
        let pending: Promise<unknown> | undefined;
        const tab = relay(storage, () => {
          if (armed && ++ops === step && !pending)
            pending = (samePage ? collector : writer).run(a);
        });
        const writer = page(storage, send);
        const collector = page(tab, samePage ? send : undefined, {
          capacity: 1,
          ttlMs: 0,
        });
        await (samePage ? collector : writer).run(a);
        armed = true;
        collector.collect(c.proof ? [a.command.requestId] : []);
        armed = false;
        const during = page(storage).snapshot();
        retry.resolve(c.late);
        await pending;
        return {
          a,
          ops,
          sent,
          pending,
          during,
          after: page(storage).snapshot(),
        };
      };
      const { ops: total } = await attempt(0);
      expect(total).toBeGreaterThan(3);
      for (let step = 1; step <= total; step++) {
        const r = await attempt(step);
        const label = `${c.name}, ${samePage ? "même onglet" : "autre onglet"}, étape ${step}/${total}`;
        expect(r.pending, label).toBeDefined();
        expect(r.sent, label).toBe(2);
        expect(r.during, label).toMatchObject([
          { command: r.a.command, fact: c.during },
        ]);
        expect(r.after, label).toMatchObject([
          { command: r.a.command, fact: c.after },
        ]);
      }
    }
});

test("une purge entre le gel et le POST retire le texte sans envoyer", async () => {
  const { storage, state } = browser();
  const a = input("Texte privé gelé");
  let sent = 0;
  let purged = false;
  const tab = relay(storage, (op) => {
    if (op === "setItem" && !purged) {
      purged = true;
      page(storage).purge(["nova"]);
    }
  });
  const attempt = await page(tab, async () => {
    sent++;
    return accepted("a");
  }).run(a);
  expect(attempt).toEqual({ kind: "blocked", reason: "purged" });
  expect(sent).toBe(0);
  expect(holding(state.items, a.command.text)).toEqual([]);
  expect(page(storage).snapshot()).toEqual([]);
});

test("limite : un arrêt entre le gel et sa compensation laisse le texte caché jusqu’au balayage suivant", async () => {
  const { storage, state } = browser();
  const a = input("Texte privé gelé");
  let sent = 0;
  let purged = false;
  const tab = relay(storage, (op) => {
    if (op === "setItem" && !purged) {
      purged = true;
      page(storage).purge(["nova"]);
    }
    if (op === "removeItem") throw Error("arrêt avant compensation");
  });
  const attempt = await page(tab, async () => {
    sent++;
    return accepted("a");
  }).run(a);
  expect(attempt.kind).toBe("blocked");
  expect(sent).toBe(0);
  expect(holding(state.items, a.command.text)).toHaveLength(1);
  expect(page(storage).snapshot()).toEqual([]);
  expect(holding(state.items, a.command.text)).toHaveLength(1);
  page(storage).collect([]);
  expect(holding(state.items, a.command.text)).toEqual([]);
});

test("une réponse tardive lue avant la barrière ne réécrit jamais le texte purgé", async () => {
  const { storage, state } = browser();
  const a = input("Texte privé gelé");
  const result = deferred();
  let stale = false;
  let staleReads = 0;
  const tab: KeyValueStorage = {
    get length() {
      return storage.length;
    },
    key: (i) => storage.key(i),
    getItem(k) {
      if (stale && k.includes("|gone|")) {
        if (!staleReads++) page(storage).purge(["nova"]);
        return null;
      }
      return storage.getItem(k);
    },
    setItem: (k, v) => storage.setItem(k, v),
    removeItem: (k) => storage.removeItem(k),
  };
  const pending = page(tab, () => result.promise).run(a);
  stale = true;
  result.resolve(accepted("a"));
  await pending;
  stale = false;
  expect(staleReads).toBeGreaterThan(0);
  expect(holding(state.items, a.command.text)).toEqual([]);
  expect(page(storage).snapshot("nova")).toEqual([]);
  page(storage).collect([]);
  expect([...state.items.keys()].every((k) => k.includes("|gone|"))).toBe(true);
});

test("une lecture ou une énumération en échec bloque l’envoi et la collecte", async () => {
  for (const fault of ["length", "key", "getItem"] as const) {
    const { storage, state } = browser();
    await page(storage, async () => refusal).run(input("Refus ancien"));
    const saved = [...state.items];
    let sent = 0;
    const book = page(
      relay(storage, (op) => {
        if (op === fault) throw Error("lecture");
      }),
      async () => {
        sent++;
        return accepted("b");
      },
      { capacity: 1, ttlMs: 0 },
    );
    expect(await book.run(input("Nouvelle")), fault).toEqual({
      kind: "blocked",
      reason: "storage-error",
    });
    book.collect([]);
    expect(sent, fault).toBe(0);
    expect(book.status(), fault).toBe("storage-error");
    expect([...state.items], fault).toEqual(saved);
  }
});

test("le cache d’un onglet ne ranime pas un envoi collecté par un autre onglet", async () => {
  const { storage } = browser();
  const options = { now: () => 0, capacity: 1, ttlMs: 0 };
  const a = input("Refus"),
    b = input("Acceptée"),
    c = input("Nouvelle");
  const tab = page(
    storage,
    async (command) =>
      command.requestId === a.command.requestId
        ? refusal
        : accepted(command.requestId),
    options,
  );
  await tab.run(a);
  page(storage, undefined, options).collect([]);
  expect(tab.snapshot()).toEqual([]);
  await tab.run(b);
  page(storage, undefined, options).collect([b.command.requestId]);
  expect(tab.snapshot()).toEqual([]);
  expect((await tab.run(c)).kind).toBe("settled");
});

test("limite : une acceptation et une incertitude du même envoi restent protégées et peuvent saturer", async () => {
  const { storage } = browser();
  const options = { now: () => 0, capacity: 1, ttlMs: 0 };
  const a = input();
  await page(storage, async () => unknown, options).run(a);
  await page(storage, async () => accepted("a"), options).run(a);
  let sent = 0;
  const reader = page(
    storage,
    async () => {
      sent++;
      return accepted("b");
    },
    options,
  );
  reader.collect([a.command.requestId]);
  expect(reader.snapshot()).toMatchObject([
    { command: a.command, fact: acceptedA },
  ]);
  expect(await reader.run(input("Nouvelle"))).toEqual({
    kind: "blocked",
    reason: "saturated",
  });
  expect(sent).toBe(0);
});

test("deux commandes divergentes du même requestId restent en conflit, chacune avec son reçu", async () => {
  const { storage } = browser();
  const a = input("Texte A");
  const b = {
    ...a,
    command: { ...a.command, text: "Texte B" },
    raw: { text: "Texte B", files: [] },
  };
  let second: Promise<unknown> | undefined;
  const tab = relay(storage, (op) => {
    if (op === "setItem" && !second)
      second = page(storage, async () => accepted("b")).run(b);
  });
  await page(tab, async () => accepted("a")).run(a);
  await second;
  const rows = page(storage).snapshot();
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.command.text === "Texte A")).toMatchObject({
    conflict: true,
    fact: { receipt: { workId: "work-a" } },
  });
  expect(rows.find((r) => r.command.text === "Texte B")).toMatchObject({
    conflict: true,
    fact: { receipt: { workId: "work-b" } },
  });
  for (const gesture of [a, b])
    expect(await page(storage).run(gesture)).toEqual({
      kind: "blocked",
      reason: "conflict",
    });
  page(storage, undefined, { capacity: 1, ttlMs: 0 }).collect([
    a.command.requestId,
  ]);
  expect(page(storage).snapshot()).toEqual(rows);
});

test("chaque clé privée est écrite une seule fois, malgré les reprises et la collecte", async () => {
  const { storage } = browser();
  const written: string[] = [];
  const tab = relay(storage, (op, key) => {
    if (op === "setItem" && key) written.push(key);
  });
  const a = input();
  const options = { now: () => 0, ttlMs: 0, capacity: 1 };
  for (const outcome of [refusal, accepted("a"), refusal])
    await page(tab, async () => outcome, options).run(a);
  const book = page(tab, async () => refusal, options);
  book.collect([a.command.requestId]);
  expect(book.snapshot()).toEqual([]);
  await book.run(a);
  expect(book.snapshot()).toMatchObject([{ fact: acceptedA }]);
  book.collect([a.command.requestId]);
  expect(book.snapshot()).toEqual([]);
  expect(written.length).toBeGreaterThan(0);
  expect(new Set(written).size).toBe(written.length);
});

test("une réentrance synchrone du même onglet partage le départ en cours", async () => {
  for (const via of ["storage", "send"] as const) {
    const { storage } = browser();
    const a = input();
    const sent: Sendable[] = [];
    let nested: Promise<unknown> | undefined;
    let entered = false;
    let book: ReturnType<typeof page> | undefined;
    const reenter = (from: typeof via) => {
      if (via !== from || !book || entered) return;
      entered = true;
      nested = book.run(a);
    };
    const tab = relay(storage, () => reenter("storage"));
    book = page(tab, async (c) => {
      sent.push(c);
      reenter("send");
      return accepted("a");
    });
    const first = book.run(a);
    expect(nested, via).toBeDefined();
    expect(await nested, via).toEqual(await first);
    expect(sent, via).toEqual([a.command]);
  }
});

test("après rechargement, un reçu retiré absorbe le refus d’une reprise explicite", async () => {
  const { storage } = browser();
  const options = { now: () => 0, capacity: 1, ttlMs: 0 };
  const a = input();
  await page(storage, async () => accepted("a"), options).run(a);
  page(storage, undefined, options).collect([a.command.requestId]);
  expect(page(storage).snapshot()).toEqual([]);
  let sent = 0;
  const replay = await page(
    storage,
    async () => {
      sent++;
      return refusal;
    },
    options,
  ).run(a);
  expect(sent).toBe(1);
  expect(replay).toMatchObject({
    kind: "settled",
    entry: { command: a.command, fact: acceptedA },
  });
  expect(page(storage).snapshot()).toMatchObject([
    { command: a.command, fact: acceptedA },
  ]);
});

test("la collecte d’un refus retire le corps avant le résultat et s’arrête à la première erreur", async () => {
  for (const failing of ["body", "final"] as const) {
    const { storage, state } = browser();
    const a = input("Refus privé");
    await page(storage, async () => refusal).run(a);
    const removed: string[] = [];
    const book = page(
      relay(storage, (op, key) => {
        if (op !== "removeItem" || !key) return;
        removed.push(key.split("|")[2]);
        if (key.includes(`|${failing}|`)) throw Error("quota");
      }),
      undefined,
      { capacity: 1, ttlMs: 0 },
    );
    book.collect([]);
    expect(book.status(), failing).toBe("storage-error");
    if (failing === "body") {
      expect(removed).toEqual(["body"]);
      expect(page(storage).snapshot()).toMatchObject([
        { command: a.command, fact: { kind: "refused" } },
      ]);
    } else {
      expect(removed).toEqual(["body", "final"]);
      expect(page(storage).snapshot()).toEqual([]);
      expect(holding(state.items, a.command.text)).toEqual([]);
      expect(state.items.size).toBe(1);
    }
  }
});

test("chaque départ a sa propre identité et son résultat ne copie aucun texte", async () => {
  const { storage, state } = browser();
  const a = input();
  const book = page(storage, async () => refusal);
  await book.run(a);
  await book.run(a);
  await page(storage).run(a);
  const stored = (part: string) =>
    [...state.items].filter(([k]) => k.includes(`|${part}|`)).map(([, v]) => v);
  const bodies = stored("body").map((v) => JSON.parse(v));
  expect(bodies).toHaveLength(3);
  expect(new Set(bodies.map((b) => b.departureId)).size).toBe(3);
  for (const body of bodies) {
    expect(body.departureId).not.toBe(a.command.requestId);
    expect(body.departureId).not.toBe(body.writerId);
    expect(body).toMatchObject({
      command: a.command,
      raw: a.raw,
      draftNonce: a.draftNonce,
    });
  }
  expect(bodies.filter((b) => b.writerId === book.writerId)).toHaveLength(2);
  const finals = stored("final");
  expect(finals).toHaveLength(3);
  for (const final of finals) {
    expect(final).not.toContain(a.command.text);
    expect(final).not.toContain(a.draftNonce);
  }
});

test("un reçu seulement retiré ne contourne pas la capacité active", async () => {
  const { storage } = browser();
  const retired = input("Reçu retiré"),
    pending = input("Demande incertaine");
  const first = page(storage, async () => accepted("retired"), {
    capacity: 1,
    ttlMs: 0,
  });
  await first.run(retired);
  first.collect([retired.command.requestId]);
  expect(page(storage).snapshot()).toEqual([]);
  const sent: Sendable[] = [];
  const full = page(
    storage,
    async (command) => {
      sent.push(command);
      return unknown;
    },
    { capacity: 1, ttlMs: 0 },
  );
  await full.run(pending);
  const before = full.snapshot();
  expect(await full.run(retired)).toEqual({
    kind: "blocked",
    reason: "saturated",
  });
  expect(sent).toEqual([pending.command]);
  expect(full.snapshot()).toEqual(before);
});
