import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AttachmentSchema, CommandSchema, LIMITS } from "../src/protocol.js";
import { openStore } from "../src/store.js";
import { loadMascots } from "../src/domain.js";
import { composeContext, type ContextSource } from "../src/context.js";

const image = {
  kind: "image",
  name: "pixel.png",
  mimeType: "image/png",
  base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=",
} as const;
const command = (attachments: unknown[], text = "") => ({
  type: "message.send",
  botId: "mino",
  requestId: randomUUID(),
  text,
  attachments,
});
test("attachment validation preserves legacy shapes and refuses unsafe batches", () => {
  const legacy = { name: "notes.txt", text: "bonjour" };
  assert.deepEqual(AttachmentSchema.parse(legacy), legacy);
  assert(CommandSchema.safeParse(command([image])).success);
  assert(!CommandSchema.safeParse(command([])).success);
  for (const relativePath of [
    "/root/a",
    "C:/a",
    "a\\b",
    "a//b",
    "./a",
    "a/../b",
    "a/\0b",
  ])
    assert(
      !AttachmentSchema.safeParse({ ...image, relativePath }).success,
      relativePath,
    );
  for (const base64 of [
    "123",
    "!!!!",
    image.base64.replace("iVB", "jVB"),
    "iVBORw0KGgo=",
  ]) {
    assert(!AttachmentSchema.safeParse({ ...image, base64 }).success);
  }
  assert(
    !AttachmentSchema.safeParse({
      ...image,
      base64: Buffer.alloc(LIMITS.imageBytes + 1).toString("base64"),
    }).success,
  );
  assert(!AttachmentSchema.safeParse({ name: "a", text: "\0" }).success);
  assert(
    !CommandSchema.safeParse(
      command([
        { ...image, relativePath: "folder/a" },
        { ...image, relativePath: "folder/a" },
      ]),
    ).success,
  );
  assert(
    !CommandSchema.safeParse(
      command(
        Array.from({ length: 9 }, () => ({
          name: "a",
          text: "a".repeat(15000),
        })),
      ),
    ).success,
  );
});

test("images survive reopening, retries compare bytes and purge removes retrieval", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ezra-images-")), "test.sqlite");
  const mascots = loadMascots(
    new URL("../../assets/mascots.json", import.meta.url),
  );
  let store = openStore({ path, mascots });
  const input = {
    ...command([
      { ...image, relativePath: "folder/pixel.png" },
      { name: "notes.txt", text: "bonjour" },
    ]),
    botId: "pixel",
  };
  assert(store.dispatch(input).ok);
  const id = store.view().messages[0]!.attachments[0]!.id;
  assert.equal(store.image(id)?.bytes.toString("base64"), image.base64);
  assert(!JSON.stringify(store.view()).includes(image.base64));
  store.close();
  store = openStore({ path, mascots });
  assert(store.dispatch(input).ok);
  assert(
    !store.dispatch({
      ...input,
      attachments: [{ ...image, relativePath: "other/pixel.png" }],
    }).ok,
  );
  const changedBytes = Buffer.from(image.base64, "base64");
  changedBytes[40] = (changedBytes[40] ?? 0) ^ 1;
  const byteConflict = store.dispatch({
    ...input,
    attachments: [
      {
        ...image,
        relativePath: "folder/pixel.png",
        base64: changedBytes.toString("base64"),
      },
      { name: "notes.txt", text: "bonjour" },
    ],
  });
  assert(!byteConflict.ok);
  if (!byteConflict.ok) assert.equal(byteConflict.code, "request_conflict");
  const claim = store.claimNext("chat");
  assert(claim);
  assert.equal(claim.turn.images?.[0]?.base64, image.base64);
  assert(!claim.turn.input.includes(image.base64));
  assert(
    store.dispatch({
      type: "work.cancel",
      workId: claim.workId,
      requestId: randomUUID(),
    }).ok,
  );
  const bot = store.view().bots.find((bot) => bot.id === "pixel")!;
  assert(
    store.dispatch({
      type: "bot.delete",
      botId: "pixel",
      confirmName: bot.name,
      expected: bot.deletion,
      requestId: randomUUID(),
    }).ok,
  );
  assert.equal(store.image(id), null);
  store.close();
});

test("context hashes image bytes, names and ordering without putting them in prompt text", () => {
  const source: ContextSource = {
    bot: {
      name: "Test",
      title: "",
      instructions: "",
      replyStyle: "concise",
      contextSize: "short",
    },
    memories: [],
    exchanges: [],
    request: { text: "Décris", attachments: [image] },
  };
  const original = composeContext(source);
  const changed = composeContext({
    ...source,
    request: {
      ...source.request,
      attachments: [{ ...image, name: "autre.png" }],
    },
  });
  assert.notEqual(original.sha256, changed.sha256);
  const altered = { ...image, base64: image.base64.slice(0, -4) + "AAAA" };
  assert.notEqual(
    original.sha256,
    composeContext({
      ...source,
      request: { text: "Décris", attachments: [altered] },
    }).sha256,
  );
  assert.notEqual(
    composeContext({
      ...source,
      request: { text: "Décris", attachments: [image, altered] },
    }).sha256,
    composeContext({
      ...source,
      request: { text: "Décris", attachments: [altered, image] },
    }).sha256,
  );
  assert.equal(original.turn.images?.[0]?.base64, image.base64);
  assert(!original.turn.input.includes(image.base64));
});
