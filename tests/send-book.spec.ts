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
  expect(book.snapshot()).toHaveLength(2);
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

test("la purge retire le texte d’un ancien format sans toucher un autre bot ou espace", async () => {
  const { storage, state } = browser();
  const a = input("Texte privé à effacer"),
    b = input("Texte conservé", "mino");
  await page(storage).run(a);
  await page(storage).run(b);
  await page(storage, undefined, { spaceId: "space-b" }).run(a);
  for (const [key, value] of state.items) {
    const row = JSON.parse(value);
    if (row.spaceId === "space-a" && row.command.botId === "nova")
      state.items.set(
        key,
        JSON.stringify({ ...row, fact: { kind: "format-futur" } }),
      );
  }
  page(storage).purge(["nova"]);
  const remaining = [...state.items.values()].filter((value) =>
    value.includes(a.raw.text),
  );
  expect(remaining).toHaveLength(1);
  expect(JSON.parse(remaining[0]).spaceId).toBe("space-b");
  expect(page(storage).snapshot()).toMatchObject([{ command: b.command }]);
  expect(
    page(storage, undefined, { spaceId: "space-b" }).snapshot(),
  ).toHaveLength(1);
});

test("la collecte retire ensemble les copies acceptées de plusieurs écrivains", async () => {
  const { storage } = browser();
  const a = input();
  const options = { now: () => 0, ttlMs: 0, capacity: 1 };
  await page(storage, async () => accepted("a"), options).run(a);
  await page(storage, async () => accepted("a"), options).run(a);
  expect(storage.length).toBe(2);
  const reader = page(storage, undefined, options);
  reader.collect([a.command.requestId]);
  expect(reader.snapshot()).toEqual([]);
  expect(storage.length).toBe(0);
});

test("un refus ne fait pas collecter une copie encore inconnue", async () => {
  const { storage } = browser();
  const a = input();
  await page(storage).run(a);
  await page(storage, async () => ({
    kind: "rejected",
    status: 403,
    message: "refus",
  })).run(a);
  const reader = page(storage, undefined, { ttlMs: 0 });
  reader.collect([a.command.requestId]);
  expect(storage.length).toBe(2);
  expect(reader.snapshot()).toMatchObject([{ command: a.command }]);
});

test("une purge vide ne touche rien et une purge nommée retire les octets inclassables du seul espace", () => {
  const { storage, state } = browser();
  const ownKey = "mino.send-book.v1|space-a|broken|broken";
  const otherKey = "mino.send-book.v1|space-b|broken|broken";
  state.items.set(ownKey, "{texte privé incomplet");
  state.items.set(otherKey, "{texte privé incomplet");
  page(storage).purge([]);
  expect(state.items.get(ownKey)).toBe("{texte privé incomplet");
  page(storage).purge(["nova"]);
  expect(state.items.has(ownKey)).toBe(false);
  expect(state.items.get(otherKey)).toBe("{texte privé incomplet");
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
