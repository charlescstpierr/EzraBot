import { test, expect } from "@playwright/test";
import { createRunner } from "../src/api";
import type { AppView } from "../server/src/protocol";

test("une acceptation conserve le résultat exact et un refus applique sa vue", async ({
  request,
}) => {
  const view: AppView = await (await request.get("/api/view")).json();
  const applied: AppView[] = [];
  const input = {
    type: "bot.select" as const,
    requestId: crypto.randomUUID(),
    botId: "mino",
  };
  const accepted = createRunner(
    { app: (next) => applied.push(next), agents() {} },
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          replayed: true,
          view,
          result: { kind: "bot", botId: "mino" },
        }),
      ),
    () => "test",
  );
  expect(await accepted.app(input)).toEqual({
    kind: "accepted",
    view,
    replayed: true,
    result: { kind: "bot", botId: "mino" },
  });
  const refusal = createRunner(
    { app: (next) => applied.push(next), agents() {} },
    async () =>
      new Response(
        JSON.stringify({
          ok: false,
          view,
          code: "stale_base",
          message: "Version modifiée",
        }),
        { status: 409 },
      ),
    () => "test",
  );
  expect((await refusal.app(input)).kind).toBe("refused");
  expect(applied).toEqual([view, view]);
});

test("un refus HTTP sans vue reste distinct d’un résultat inconnu", async () => {
  const apply = { app() {}, agents() {} };
  const input = {
    type: "bot.select" as const,
    requestId: crypto.randomUUID(),
    botId: "mino",
  };
  const rejected = createRunner(
    apply,
    async () =>
      new Response(JSON.stringify({ ok: false, message: "Session expirée" }), {
        status: 403,
      }),
    () => "test",
  );
  expect(await rejected.app(input)).toEqual({
    kind: "rejected",
    status: 403,
    message: "Session expirée",
  });
  const unknown = createRunner(
    apply,
    async () => {
      throw new Error("Connexion perdue");
    },
    () => "test",
  );
  expect((await unknown.app(input)).kind).toBe("unknown");
  const broken = createRunner(
    apply,
    async () => new Response("{", { status: 500 }),
    () => "test",
  );
  expect((await broken.app(input)).kind).toBe("unknown");
});
