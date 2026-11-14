import { expect, test as base, type Page } from "@playwright/test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CommandResult,
  DispatchOutcome,
  EngineReply,
  EngineStatus,
  ResolvedChoice,
  StoreView,
  UsageSnapshot,
  WorkView,
} from "../server/src/protocol";

import { openStore, type Store } from "../server/src/store";
import {
  loadMascots,
  engineFailure,
  type EngineOutcome,
  type EngineErrorCode,
  type UsageObservation,
} from "../server/src/domain";
import { createWorker, type Worker } from "../server/src/worker";
import { createHttpServer } from "../server/src/http";
import type { Engine, RunInput } from "../server/src/engine";

const root = fileURLToPath(new URL("..", import.meta.url));
const CSRF = "documents-test-token";
const USED = { model: "gpt-test", effort: "low", speed: "standard" };

const USAGE_FIXTURE_SANS_CACHE: UsageObservation["usage"] = {
  last: {
    input: 1200,
    cachedInput: 0,
    cacheWriteInput: 0,
    output: 340,
    reasoningOutput: 0,
    total: 1540,
  },
  total: {
    input: 1200,
    cachedInput: 0,
    cacheWriteInput: 0,
    output: 340,
    reasoningOutput: 0,
    total: 1540,
  },
  modelContextWindow: null,
};

let bundle: Promise<{ js: string; css: string }> | undefined;
const harness = () =>
  (bundle ??= build({
    entryPoints: [join(root, "tests/fixtures/documents-harness.tsx")],
    bundle: true,
    format: "esm",
    target: "es2022",
    jsx: "automatic",
    write: false,
    outdir: "out",
    logLevel: "silent",
  }).then((result) => {
    const text = (extension: string) =>
      result.outputFiles.find((file) => file.path.endsWith(extension))?.text ??
      "";
    return { js: text(".js"), css: text(".css") };
  }));

type Call = { input: RunInput; finish(outcome: EngineOutcome): void };

function controlledEngine() {
  const calls: Call[] = [];
  const waiters: ((call: Call) => void)[] = [];
  const listeners = new Set<(observation: UsageObservation) => void>();
  const engine: Engine = {
    status: () => ({
      state: "unavailable",
      message: "Moteur contrôlé par le test : aucun appel IA.",
    }),
    catalog: async () => engine.status(),
    onUsage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run: (input) =>
      new Promise<EngineOutcome>((resolve) => {
        const departure = input.depart();
        if (!departure.ok) {
          resolve({
            kind: "failed",
            code: "admission_refused",
            message: departure.reason,
          });
          return;
        }
        input.signal.addEventListener(
          "abort",
          () => resolve({ kind: "cancelled" }),
          { once: true },
        );
        const call = { input, finish: resolve };
        const waiter = waiters.shift();
        if (waiter) waiter(call);
        else calls.push(call);
      }),
    close: async () => {},
  };
  return {
    engine,
    next: () =>
      new Promise<Call>((resolve) => {
        const call = calls.shift();
        if (call) resolve(call);
        else waiters.push(resolve);
      }),
    reportUsage: (observation: UsageObservation) =>
      listeners.forEach((listener) => listener(observation)),
  };
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

async function openLab(page: Page, serviceTools = false) {
  const store: Store = openStore({
    path: join(
      mkdtempSync(join(tmpdir(), "ezrabot-documents-")),
      "mino.sqlite",
    ),
    mascots: loadMascots(join(root, "server/assets/mascots.json")),
    serviceTools,
  });
  const chat = controlledEngine();
  const doc = controlledEngine();
  const worker: Worker = createWorker({
    store,
    engines: { chat: chat.engine, doc: doc.engine },
    progressIntervalMs: 5,
  });
  const port = await freePort();
  const server: Server = createHttpServer({
    store,
    worker,
    engine: doc.engine,
    port,
    root: join(root, "server"),
    csrfToken: CSRF,
    longPollMs: 2000,
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const origin = `http://127.0.0.1:${port}`;
  const { js, css } = await harness();
  await page.route(`${origin}/__documents**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith(".js"))
      return route.fulfill({ contentType: "text/javascript", body: js });
    if (path.endsWith(".css"))
      return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({
      contentType: "text/html",
      headers: {
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; frame-src 'self'",
      },
      body: `<!doctype html><html lang="fr"><head><meta charset="UTF-8"><meta name="mino-csrf" content="${CSRF}"><link rel="stylesheet" href="/__documents/harness.css"></head><body><div id="root"></div><script type="module" src="/__documents/harness.js"></script></body></html>`,
    });
  });
  if (process.env.CONTINUITY_MOBILE) {
    const mobile = await build({
      entryPoints: [join(root, "tests/fixtures/continuity-mobile-harness.jsx")],
      bundle: true,
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      write: false,
      alias: {
        "react-native-svg": join(
          root,
          "server/mobile/node_modules/react-native-svg/lib/module/ReactNativeSVG.web.js",
        ),
        "@react-native/assets-registry/registry": join(
          root,
          "server/mobile/node_modules/react-native-web/dist/modules/AssetRegistry/index.js",
        ),
        "react-native": join(
          root,
          "server/mobile/node_modules/react-native-web",
        ),
        react: join(root, "node_modules/react"),
        "react-dom": join(root, "node_modules/react-dom"),
      },
      resolveExtensions: [
        ".web.tsx",
        ".web.ts",
        ".web.js",
        ".tsx",
        ".ts",
        ".js",
        ".json",
      ],
      plugins: [
        {
          name: "web-excludes-android-touch-sound",
          setup(builder) {
            builder.onResolve(
              { filter: /\/fabric\/NativeSvgSoundModule$/ },
              (args) => ({ path: args.path, external: true }),
            );
          },
        },
      ],
      define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" },
      logLevel: "silent",
    });
    await page.route(`${origin}/__continuity-mobile**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module">${mobile.outputFiles[0]?.text}</script></body></html>`,
      }),
    );
  }
  const posted: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/commands"))
      posted.push(request.postDataJSON());
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const dispatch = (command: Record<string, unknown>): CommandResult => {
    const outcome = store.dispatch(
      { ...command, requestId: randomUUID() },
      { activeWorkIds: worker.activeWorkIds },
    );
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    worker.sync();
    return outcome.result;
  };
  const work = (workId: string): WorkView => {
    const found = store.view().works.find((each) => each.id === workId);
    if (!found) throw new Error(`work ${workId} absent`);
    return found;
  };
  return {
    store,
    chat,
    doc,
    origin,
    posted,
    errors,
    dispatch,
    work,
    failure: (code: EngineErrorCode): EngineOutcome => engineFailure(code),
    requestDocument(text: string, reviewerBotId: string | null = null) {
      const result = dispatch({
        type: "message.send",
        botId: "mino",
        text,
        attachments: [],
        document: { reviewerBotId },
      });
      if (result.kind !== "message" || !result.taskId)
        throw new Error("document request not recorded as a task");
      return { taskId: result.taskId, workId: result.workId };
    },
    async write(title: string, body: string, n = 1) {
      const call = await doc.next();
      call.input.onThread(`thread-${n}`);
      call.input.onTurn(`turn-${n}`);
      const { rev } = store.view();
      call.finish({
        kind: "succeeded",
        reply: { reply: "Voici le document.", deliverable: { title, body } },
        used: USED,
        threadId: `thread-${n}`,
        turnId: `turn-${n}`,
      });
      await expect.poll(() => store.view().rev).toBeGreaterThan(rev);
    },
    open: (query = "") => page.goto(`${origin}/__documents${query}`),
    async close() {
      await worker.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

const test = base.extend<{ lab: Awaited<ReturnType<typeof openLab>> }>({
  lab: async ({ page }, use) => {
    const lab = await openLab(page);
    await use(lab);
    expect(lab.errors).toEqual([]);
    await lab.close();
  },
});

test("une tâche en cours montre le texte reçu, garde une saisie sans version et arbitre la proposition", async ({
  page,
  lab,
}) => {
  const { taskId, workId } = lab.requestDocument(
    "Prépare un plan de déménagement",
  );
  await lab.open();
  const card = page.locator(`[data-task-id="${taskId}"]`);
  const call = await lab.doc.next();
  await expect(card.locator(".ez-doc-status")).toHaveText("En cours");
  await expect(card).toContainText("Aucune version enregistrée.");
  await expect(card.locator(".ez-doc-steps li")).toHaveText([
    "Rédaction · Mino · en cours",
  ]);

  call.input.onThread("thread-1");
  call.input.onTurn("turn-1");
  call.input.onText?.({
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    text: '{"reply":"Je rédige le plan","deliverable":{"title":"Plan","body":"Cartons puis camion',
    final: false,
  });
  await expect(card.locator(".ez-doc-stream")).toHaveText(
    "Cartons puis camion",
  );
  await expect(card.locator(".ez-doc-live")).toContainText("caractères reçus");

  await card.getByRole("button", { name: "Ouvrir le document" }).click();
  const panel = page.locator(".ez-doc-panel");
  await expect(panel.locator(".ez-doc-stream")).toHaveText(
    "Cartons puis camion",
  );
  await panel.getByLabel("Titre").fill("Mon plan");
  await panel.getByLabel("Contenu").fill("Ma liste personnelle");
  await panel.getByRole("button", { name: "Enregistrer une version" }).click();
  await expect(panel.getByRole("status")).toHaveText("Version 1 enregistrée.");
  expect(lab.posted.at(-1)).toMatchObject({
    type: "task.edit",
    taskId,
    baseVersionId: null,
    title: "Mon plan",
    body: "Ma liste personnelle",
  });

  await panel
    .getByLabel("Précision ou nouvel objectif pour ce document")
    .fill("Départ le 3 mai");
  await panel.getByRole("button", { name: "Ajouter une précision" }).click();
  await expect(panel.locator(".ez-doc-events li")).toContainText(
    "Départ le 3 mai",
  );
  await expect(panel.locator(".ez-doc-events li")).toHaveAttribute(
    "data-delivery",
    "waiting",
  );
  expect(lab.posted.at(-1)).toMatchObject({
    type: "task.intent",
    taskId,
    intent: { kind: "add_info", text: "Départ le 3 mai" },
  });
  await expect(
    panel.getByLabel("Précision ou nouvel objectif pour ce document"),
  ).toHaveValue("");

  call.finish({
    kind: "succeeded",
    reply: {
      reply: "Voici le plan.",
      deliverable: { title: "Plan", body: "Cartons puis camion, puis clés." },
    },
    used: USED,
    threadId: "thread-1",
    turnId: "turn-1",
  });
  await expect(panel.locator(".ez-doc-head .ez-doc-status")).toHaveText(
    "À arbitrer",
  );
  await expect(panel.locator(".ez-doc-proposal")).toContainText(
    "écrite à partir d’un document vide alors que la version 1 est actuelle",
  );
  await expect(panel.getByLabel("Contenu")).toHaveValue("Ma liste personnelle");
  const [mine] = lab.work(workId).versions;
  const proposal = lab.store.view().tasks[0]?.proposals[0];
  await panel.getByRole("button", { name: "Adopter comme version 2" }).click();
  await expect(
    panel.getByRole("heading", { name: "Version 2 · actuelle" }),
  ).toBeVisible();
  expect(lab.posted.at(-1)).toEqual({
    type: "doc.adopt",
    requestId: expect.any(String),
    proposalId: proposal?.id,
    seenVersionId: mine?.id,
    seenRevision: 1,
  });
  await expect(panel.getByLabel("Contenu")).toHaveValue(
    "Cartons puis camion, puis clés.",
  );
  await expect(
    panel.locator('.ez-doc-resolved [data-state="adopted"]'),
  ).toHaveText("Rédaction de Mino : adoptée (version 2)");
});

test("un échec sans version reste visible, se reprend dans sa limite et s’annule", async ({
  page,
  lab,
}) => {
  const { taskId } = lab.requestDocument("Rédige une lettre au bailleur");
  await lab.open();
  const card = page.locator(`[data-task-id="${taskId}"]`);
  (await lab.doc.next()).finish(lab.failure("engine_exited"));
  await expect(card.locator(".ez-doc-status")).toHaveText("Interrompu");
  await expect(card.locator(".ez-doc-error")).toHaveText(
    "Dernier appel : Codex s’est arrêté pendant l’appel.",
  );
  await expect(card).toContainText("Aucune version enregistrée.");
  await expect(card.locator(".ez-doc-steps li")).toHaveText([
    "Rédaction · Mino · échec",
  ]);
  await card.getByText("Appels · 1 / 1").click();
  await expect(card.locator(".ez-doc-details li")).toContainText(
    "aucun tour accepté",
  );

  await card
    .getByRole("button", {
      name: "Relancer l’étape interrompue (2 reprises restantes)",
    })
    .click();
  const second = await lab.doc.next();
  expect(lab.posted.at(-1)).toMatchObject({ type: "task.continue", taskId });
  await expect(card.locator(".ez-doc-status")).toHaveText("En cours");
  await expect(card.locator(".ez-doc-steps li")).toHaveText([
    "Rédaction · Mino · échec",
    "Rédaction · Mino · en cours",
  ]);

  await card.getByRole("button", { name: "Annuler le travail" }).click();
  await expect(card.locator(".ez-doc-status")).toHaveText("Annulé");
  expect(lab.posted.at(-1)).toMatchObject({
    type: "task.intent",
    taskId,
    intent: { kind: "cancel" },
  });
  expect(second.input.signal.aborted).toBe(true);
  await expect(card).toContainText("Aucune version enregistrée.");
  await expect(card.getByRole("button", { name: /Relancer/ })).toHaveCount(0);

  const sent = lab.dispatch({
    type: "message.send",
    botId: "mino",
    text: "Bonjour",
    attachments: [],
  });
  if (sent.kind !== "message") throw new Error("message not recorded");
  const reply = page.locator(`[data-work-id="${sent.workId}"]`);
  (await lab.chat.next()).finish(lab.failure("timeout"));
  await expect(reply.locator(".ez-doc-status")).toHaveText("Échec");
  await expect(reply.locator(".ez-doc-error")).toHaveText(
    "Codex n’a pas répondu à temps. L’appel est arrêté.",
  );
  await expect(reply).toContainText("Aucune version enregistrée.");
  await reply.getByRole("button", { name: "Relancer" }).click();
  const retried = await lab.chat.next();
  expect(lab.posted.at(-1)).toMatchObject({
    type: "work.retry",
    workId: sent.workId,
  });
  await reply.getByRole("button", { name: "Arrêter" }).click();
  await expect(reply.locator(".ez-doc-status")).toHaveText("Annulé");
  expect(lab.posted.at(-1)).toMatchObject({
    type: "work.cancel",
    workId: sent.workId,
  });
  expect(retried.input.signal.aborted).toBe(true);
});

test("une saisie survit à un résultat inconnu, à un enregistrement lent, à un conflit et à une restauration", async ({
  page,
  lab,
}) => {
  const { taskId, workId } = lab.requestDocument("Prépare un plan de voyage");
  await lab.write("Plan", "Texte du bot");
  await lab.open(`?workId=${workId}`);
  const panel = page.locator(".ez-doc-panel");
  const body = panel.getByLabel("Contenu");
  const save = panel.getByRole("button", { name: "Enregistrer une version" });
  await expect(panel.locator(".markdown")).toHaveText("Texte du bot");
  await panel.getByRole("button", { name: "Modifier" }).click();

  await body.fill("Ma saisie");
  await page.route("**/api/commands", (route) => route.abort(), { times: 1 });
  await save.click();
  await expect(panel.locator('[data-failure="unknown"]')).toBeVisible();
  await expect(save).toBeDisabled();
  await body.fill("Ma saisie, suite");
  await panel.getByRole("button", { name: "Réessayer le même envoi" }).click();
  await expect(panel.getByRole("status")).toContainText(
    "Saisie non enregistrée, partie de la version 2.",
  );
  const [lost, retried] = lab.posted.slice(-2);
  expect(retried).toEqual(lost);
  expect(retried).toMatchObject({ type: "task.edit", body: "Ma saisie" });
  expect(lab.work(workId).versions.map((version) => version.body)).toEqual([
    "Texte du bot",
    "Ma saisie",
  ]);
  await expect(body).toHaveValue("Ma saisie, suite");

  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    "**/api/commands",
    async (route) => {
      await held;
      await route.continue();
    },
    { times: 1 },
  );
  const before = lab.posted.length;
  await save.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(panel.getByRole("status")).toHaveText("Enregistrement…");
  await body.fill("Ma saisie, suite et fin");
  release();
  await expect(panel.getByRole("status")).toContainText(
    "Saisie non enregistrée, partie de la version 3.",
  );
  expect(lab.posted.length - before).toBe(1);
  await expect(body).toHaveValue("Ma saisie, suite et fin");

  await page.reload();
  await expect(body).toHaveValue("Ma saisie, suite et fin");
  await expect(panel.getByRole("status")).toContainText(
    "partie de la version 3",
  );

  const third = lab.work(workId).versions.at(-1);
  lab.dispatch({
    type: "task.edit",
    taskId,
    baseVersionId: third?.id,
    title: "Plan",
    body: "Texte de l’autre onglet",
  });
  const conflict = panel.locator(".ez-doc-conflict");
  await expect(conflict).toContainText(
    "Votre saisie part de la version 3. La version 4 (modifiée par vous) est maintenant actuelle.",
  );
  await expect(body).toHaveValue("Ma saisie, suite et fin");
  await save.click();
  await expect(panel.locator('[data-failure="refused"]')).toContainText(
    "stale_base",
  );
  expect(lab.posted.at(-1)).toMatchObject({ baseVersionId: third?.id });
  await expect(body).toHaveValue("Ma saisie, suite et fin");
  const fourth = lab.work(workId).versions.at(-1);
  await conflict
    .getByRole("button", { name: "Enregistrer ma saisie comme version 5" })
    .click();
  await expect(panel.getByRole("status")).toHaveText("Version 5 enregistrée.");
  expect(lab.posted.at(-1)).toMatchObject({
    type: "task.edit",
    baseVersionId: fourth?.id,
    body: "Ma saisie, suite et fin",
  });

  await body.fill("Brouillon à garder");
  const [first] = lab.work(workId).versions;
  await panel.getByRole("button", { name: "Restaurer la version 1" }).click();
  await expect(conflict).toContainText(
    "La version 6 (restaurée depuis la version 1) est maintenant actuelle.",
  );
  expect(lab.posted.at(-1)).toMatchObject({
    type: "version.restore",
    workId,
    versionId: first?.id,
  });
  await expect(body).toHaveValue("Brouillon à garder");
  await conflict
    .getByRole("button", {
      name: "Abandonner ma saisie et charger la version 6",
    })
    .click();
  await expect(body).toHaveValue("Texte du bot");
  await expect(conflict).toHaveCount(0);
});

test("la publication s’approuve avec les champs exacts affichés, se refuse et garde son historique", async ({
  page,
  lab,
}) => {
  const { taskId, workId } = lab.requestDocument("Prépare un guide d’accueil");
  await lab.write("Guide", "Bienvenue.");
  await lab.open(`?workId=${workId}`);
  const panel = page.locator(".ez-doc-panel");
  const approval = panel.locator(".ez-doc-approval");
  const resolved = panel.locator(".ez-doc-resolved li");

  await panel
    .getByRole("button", { name: "Préparer la publication de la version 1" })
    .click();
  await expect(approval).toContainText("Bienvenue.");
  await approval
    .getByRole("button", { name: "Refuser la publication" })
    .click();
  await expect(resolved).toContainText([
    "Version 1 · Publication refusée. Rien n’a été publié",
  ]);
  expect(lab.posted.at(-1)).toMatchObject({
    type: "publication.reject",
    proposalId: lab.work(workId).proposals[0]?.id,
  });

  await panel
    .getByRole("button", { name: "Préparer la publication de la version 1" })
    .click();
  await expect(approval).toBeVisible();
  lab.dispatch({
    type: "task.edit",
    taskId,
    baseVersionId: lab.work(workId).versions[0]?.id,
    title: "Guide",
    body: "Bienvenue à tous.",
  });
  await expect(approval).toHaveCount(0);
  await expect(resolved).toContainText([
    "Publication refusée",
    "Version 1 · Proposition annulée : le document a été modifié",
  ]);

  await panel
    .getByRole("button", { name: "Préparer la publication de la version 2" })
    .click();
  await expect(approval).toBeVisible();
  const open = lab.work(workId).proposals.at(-1);
  await expect(approval.locator("code")).toHaveText([
    "publish",
    "carnet",
    open?.versionId ?? "",
    open?.payloadSha256 ?? "",
  ]);
  await approval
    .getByRole("button", { name: "Approuver la publication" })
    .click();
  await expect(
    panel.locator('.ez-doc-resolved [data-state="published"]'),
  ).toContainText("Publié dans le Carnet · version 2");
  expect(lab.posted.at(-1)).toEqual({
    type: "publication.approve",
    requestId: expect.any(String),
    proposalId: open?.id,
    action: "publish",
    destination: "carnet",
    versionId: lab.work(workId).versions[1]?.id,
    payloadSha256: open?.payloadSha256,
  });
  await expect(
    panel.locator('.ez-doc-resolved [data-state="approved"]'),
  ).toContainText("Version 2 · Publication approuvée");
  await expect(panel.locator(".ez-doc-head .ez-doc-status")).toHaveText(
    "Validé",
  );
  const href = await panel
    .getByRole("link", { name: "Télécharger la publication" })
    .getAttribute("href");
  const file = await page.request.get(`${lab.origin}${href}`);
  expect(file.headers()["content-disposition"]).toContain("attachment");
  expect(await file.text()).toContain("Bienvenue à tous.");
});

test("un document HTML s’ouvre dans un cadre isolé, une version ciblée se lit et le diagnostic distingue absent et zéro", async ({
  page,
  lab,
}) => {
  const { taskId, workId } = lab.requestDocument("Crée une page pour le club");
  await lab.write(
    "Page du club",
    '<!doctype html><html><body><h1>Club</h1><script>document.querySelector("h1").textContent += " · script actif"</script></body></html>',
  );
  const [html] = lab.work(workId).versions;
  lab.dispatch({
    type: "task.edit",
    taskId,
    baseVersionId: html?.id,
    title: "Page du club",
    body: "Texte **gras** en Markdown",
  });

  await lab.open(`?workId=${workId}&versionId=${html?.id}`);
  const panel = page.locator(".ez-doc-panel");
  await expect(
    panel.getByRole("heading", { name: "Version 1 · ancienne" }),
  ).toBeVisible();
  const frame = panel.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(frame).toHaveAttribute(
    "src",
    `/api/versions/${html?.id}/preview`,
  );
  await expect(panel.frameLocator("iframe").locator("h1")).toHaveText(
    "Club · script actif",
  );
  await expect(panel.getByRole("button", { name: /Modifier/ })).toHaveCount(0);
  await panel.getByRole("button", { name: "Code", exact: true }).click();
  await expect(panel.locator(".ez-doc-code")).toContainText("<!doctype html>");
  const link = panel.getByRole("link", { name: "Télécharger le HTML" });
  await expect(link).toHaveAttribute(
    "href",
    `/api/versions/${html?.id}/download`,
  );
  const file = await page.request.get(
    `${lab.origin}/api/versions/${html?.id}/download`,
  );
  expect(file.headers()["content-type"]).toContain("text/html");
  expect(file.headers()["content-disposition"]).toContain("attachment");

  await panel
    .getByRole("button", { name: "Revenir à la version 2 actuelle" })
    .click();
  await expect(
    panel.getByRole("heading", { name: "Version 2 · actuelle" }),
  ).toBeVisible();
  await expect(panel.locator(".markdown strong")).toHaveText("gras");
  await expect(panel.locator("iframe")).toHaveCount(0);

  await panel.getByText("Diagnostic du dernier appel").click();
  const facts = panel.locator(".ez-doc-facts");
  await expect(facts).toContainText(
    "Réglage utilisé" + "gpt-test · low · standard",
  );
  await expect(facts).toContainText("Contexte envoyé" + "Taille court");
  await expect(facts).toContainText("Consommation" + "non fournie par Codex");
  lab.doc.reportUsage({
    threadId: "thread-1",
    turnId: "turn-1",
    usage: USAGE_FIXTURE_SANS_CACHE,
  });
  await expect(facts).toContainText(
    "1 200 en entrée dont 0 lus en cache et 0 écrits en cache, 340 en sortie dont 0 de raisonnement, 1 540 au total",
  );
  await expect(facts).toContainText(
    "Fenêtre de contexte du modèle" + "non fournie par Codex",
  );
  await expect(facts).not.toContainText("Consommation");
});

test("un changement d’objectif arrête l’ancien plan, la proposition s’écarte, la nouvelle passe se valide depuis la carte", async ({
  page,
  lab,
}) => {
  const { taskId, workId } = lab.requestDocument(
    "Prépare un programme de fête",
  );
  await lab.open(`?workId=${workId}`);
  const panel = page.locator(".ez-doc-panel");
  const status = panel.locator(".ez-doc-head .ez-doc-status");
  const call = await lab.doc.next();
  call.input.onThread("thread-1");
  call.input.onTurn("turn-1");
  await expect(status).toHaveText("En cours");

  await panel
    .getByLabel("Précision ou nouvel objectif pour ce document")
    .fill("Plutôt une invitation");
  await panel.getByRole("button", { name: "Changer l’objectif" }).click();
  await expect(panel).toContainText(
    "Objectif (révision 2) : Plutôt une invitation",
  );
  expect(lab.posted.at(-1)).toMatchObject({
    type: "task.intent",
    taskId,
    intent: { kind: "change_goal", text: "Plutôt une invitation" },
  });

  call.finish({
    kind: "succeeded",
    reply: {
      reply: "Voici le programme.",
      deliverable: { title: "Programme", body: "Musique à 20 h." },
    },
    used: USED,
    threadId: "thread-1",
    turnId: "turn-1",
  });
  await expect(panel.locator(".ez-doc-proposal")).toContainText(
    "écrite pour l’objectif de la révision 1. L’objectif actuel est la révision 2.",
  );
  await panel.getByRole("button", { name: "Écarter la proposition" }).click();
  await expect(status).toHaveText("Objectif modifié");
  expect(lab.posted.at(-1)).toMatchObject({
    type: "doc.dismiss",
    proposalId: lab.store.view().tasks[0]?.proposals[0]?.id,
  });
  expect(lab.work(workId).versions).toEqual([]);

  await panel
    .getByRole("button", {
      name: "Nouvelle passe avec l’objectif modifié (2 reprises restantes)",
    })
    .click();
  await lab.write("Invitation", "Venez samedi.", 2);
  await expect(status).toHaveText("Prêt à valider");
  await expect(
    panel.locator('.ez-doc-events [data-delivery="sent"]'),
  ).toContainText("Transmise à Mino (nouvelle passe, appel 2)");

  await page.getByRole("button", { name: "Retour au fil" }).click();
  const card = page.locator(`[data-task-id="${taskId}"]`);
  await expect(card).toContainText("Version 1 enregistrée.");
  await card.getByRole("button", { name: "Valider le document" }).click();
  await expect(card.locator(".ez-doc-status")).toHaveText("Validé");
  expect(lab.posted.at(-1)).toMatchObject({ type: "work.accept", workId });
});

test("un relais montre chaque étape, les échanges transmis et le diagnostic du relecteur", async ({
  page,
  lab,
}) => {
  lab.requestDocument("Prépare un plan de fête", "nova");
  await lab.write("Plan", "Brouillon.", 1);
  const review = await lab.doc.next();
  review.input.onThread("thread-2");
  review.input.onTurn("turn-2");
  review.finish({
    kind: "succeeded",
    reply: { reply: "Ajoute un horaire.", deliverable: null },
    used: USED,
    threadId: "thread-2",
    turnId: "turn-2",
  });
  await lab.write("Plan", "Brouillon avec horaire.", 3);

  await lab.open(`?workId=${lab.store.view().tasks[0]?.reviewWorkId}`);
  const panel = page.locator(".ez-doc-panel");
  await expect(
    panel.getByRole("heading", { name: "Version 2 · actuelle" }),
  ).toBeVisible();
  await expect(panel.locator(".ez-doc-reader .markdown")).toHaveText(
    "Brouillon avec horaire.",
  );
  await expect(panel.locator(".ez-doc-steps li")).toHaveText([
    "Rédaction · Mino · fait",
    "Avis · Nova · fait",
    "Synthèse · Mino · fait",
  ]);
  const exchanges = panel.locator(".ez-doc-exchange");
  await expect(exchanges).toContainText([
    "Mino → Nova · brouillon pour avis" +
      "Transmis à Nova dans un tour accepté (avis, appel 1, fait)",
    "Nova → Mino · avis pour la synthèse" +
      "Transmis à Mino dans un tour accepté (synthèse, appel 2, fait)",
  ]);
  await exchanges.nth(1).getByText("Message enregistré").click();
  await expect(exchanges.nth(1).locator(".markdown")).toHaveText(
    "Ajoute un horaire.",
  );
  await panel.getByText("Diagnostic du dernier appel").click();
  await expect(panel.locator(".ez-doc-facts")).toContainText([
    "Bot" + "Mino",
    "Bot" + "Nova",
  ]);
});

test("continuité29 garde le travail après rechargement et attribue les coupes du contexte", async ({
  page,
  lab,
}, info) => {
  for (const [botId, name] of [
    ["mino", "Ana"],
    ["nova", "Bob"],
    ["atlas", "Cyd"],
  ]) {
    lab.dispatch({ type: "bot.update", botId, name });
  }
  const text = "@Ana @Bob @Cyd " + "Question synthétique. ".repeat(250);
  const seeded = lab.store.dispatch({
    type: "message.send",
    requestId: randomUUID(),
    botId: "mino",
    text,
    attachments: [],
    mentions: [
      { botId: "mino", start: 0, end: 4 },
      { botId: "nova", start: 5, end: 9 },
      { botId: "atlas", start: 10, end: 14 },
    ],
  });
  expect(seeded.ok).toBe(true);
  for (let i = 0; i < 3; i += 1) {
    const claim = lab.store.claimNext("chat");
    expect(claim).toBeTruthy();
    if (!claim) throw Error("Tentative synthétique absente");
    lab.store.finishJob(claim, {
      kind: "succeeded",
      reply: { reply: "Réponse synthétique. ".repeat(400), deliverable: null },
      used: USED,
      threadId: "qa-source",
      turnId: `qa-source-${i}`,
    });
  }
  const sent = lab.dispatch({
    type: "message.send",
    botId: "mino",
    text: "Reprendre cette étude synthétique",
    attachments: [],
  });
  if (sent.kind !== "message") throw Error("Travail absent");
  await lab.open(`?workId=${sent.workId}`);
  const call = await lab.chat.next();
  call.finish(lab.failure("turn_failed"));
  await expect.poll(() => lab.work(sent.workId).state).toBe("failed");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Relancer", exact: true }),
  ).toBeVisible();
  await page.getByText("Diagnostic du dernier appel", { exact: true }).click();
  await expect(page.getByText(/politique (11|12)/)).toBeVisible();
  if (!process.env.CONTINUITY_BASELINE) {
    for (const name of ["Ana", "Bob", "Cyd"])
      await expect(page.locator("dl.ez-doc-facts")).toContainText(name);
    await expect(page.getByText(/0 textes récents complets/)).toBeVisible();
  }
  await page.screenshot({
    path: info.outputPath("continuity29-contexte-pc.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: info.outputPath("continuity29-contexte-etroit.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Relancer", exact: true }).click();
  const retried = await lab.chat.next();
  expect(retried.input.turn.input).toContain(
    "Reprendre cette étude synthétique",
  );
  expect(lab.work(sent.workId).attempt?.n).toBe(2);
  expect(lab.work(sent.workId).requestMessageId).toBe(sent.messageId);
  retried.finish({
    kind: "succeeded",
    reply: {
      reply: "Étude reprise",
      deliverable: {
        title: "Étude synthétique",
        body: "Résultat confirmé après reprise explicite.",
      },
    },
    used: USED,
    threadId: "qa-new-thread",
    turnId: "qa-retry",
  });
  await expect.poll(() => lab.work(sent.workId).state).toBe("review");
  await page.reload();
  await expect(
    page
      .getByText("Résultat confirmé après reprise explicite.", { exact: true })
      .first(),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("continuity29-reprise.png"),
    fullPage: true,
  });
});

base(
  "continuité29 un effet inconnu ne propose aucune relance du travail",
  async ({ page }, info) => {
    const { ACCOUNT_A, SEND_EMAIL } =
      await import("../server/test/fixtures/fake-composio");
    const lab = await openLab(page, true);
    try {
      const live = { account: ACCOUNT_A, tools: [SEND_EMAIL] };
      expect(
        lab.store.tools.apply(
          {
            type: "tools.grant",
            requestId: randomUUID(),
            botId: "mino",
            accountId: ACCOUNT_A.id,
            toolSlugs: [SEND_EMAIL.slug],
          },
          live,
        ).ok,
      ).toBe(true);
      const sent = lab.store.dispatch({
        type: "message.send",
        requestId: randomUUID(),
        botId: "mino",
        text: "Action synthétique au résultat inconnu",
        attachments: [],
      });
      if (!sent.ok || sent.result.kind !== "message")
        throw Error("Travail absent");
      const workId = sent.result.workId;
      const claim = lab.store.claimNext("chat");
      if (!claim) throw Error("Tentative absente");
      expect(
        lab.store.tools.propose(claim, {
          callId: "qa-tool",
          tool: SEND_EMAIL.slug,
          arguments: {
            to: "personne@exemple.invalid",
            subject: "Synthétique",
            body: "Preuve locale",
          },
        }).success,
      ).toBe(true);
      lab.store.finishJob(claim, {
        kind: "succeeded",
        reply: {
          reply: "Proposition synthétique enregistrée",
          deliverable: null,
        },
        used: USED,
        threadId: "qa-proposal",
        turnId: "qa-tool",
      });
      const proposal = lab.store.tools
        .view({ state: "ready" })
        .proposals.at(-1);
      if (!proposal) throw Error("Proposition absente");
      const approved = lab.store.tools.apply(
        {
          type: "tools.approve",
          requestId: randomUUID(),
          proposalId: proposal.id,
          fingerprint: proposal.fingerprint,
        },
        live,
      );
      if (
        !approved.ok ||
        approved.result.kind !== "decision" ||
        !approved.result.executionId
      )
        throw Error("Exécution absente");
      const executionId = approved.result.executionId;
      const permit = lab.store.tools.claimDispatch(executionId, {
        kind: "found",
        account: ACCOUNT_A,
      });
      if (!permit) throw Error("Permis absent");
      lab.store.tools.settle(permit, { kind: "unknown", category: "timeout" });
      const report = lab.store.claimNext("chat");
      if (!report) throw Error("Compte rendu absent");
      lab.store.finishJob(report, engineFailure("turn_failed"));
      expect(lab.work(workId).state).toBe("done");
      await lab.open(`?workId=${workId}`);
      await page.reload();
      if (!process.env.CONTINUITY_BASELINE) {
        await expect(
          page.getByText(/Résultat inconnu\. Action non renvoyée/),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Relancer", exact: true }),
        ).toHaveCount(0);
      }
      await page.screenshot({
        path: info.outputPath("continuity29-inconnu-pc.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: info.outputPath("continuity29-inconnu-etroit.png"),
        fullPage: true,
      });
      if (process.env.CONTINUITY_MOBILE) {
        await page.goto(`${lab.origin}/__continuity-mobile?workId=${workId}`);
        await expect(
          page.getByText("Action synthétique au résultat inconnu", {
            exact: true,
          }),
        ).toBeVisible();
        if (!process.env.CONTINUITY_BASELINE) {
          await expect(
            page.getByText(/Résultat inconnu. Action non renvoyée./),
          ).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: "Reprendre ce travail",
              exact: true,
            }),
          ).toBeDisabled();
        }
        await page.screenshot({
          path: info.outputPath("continuity29-inconnu-mobile-web.png"),
          fullPage: true,
        });
      }
      expect(
        lab.store.tools.claimDispatch(executionId, {
          kind: "found",
          account: ACCOUNT_A,
        }),
      ).toBeNull();
    } finally {
      await lab.close();
    }
  },
);
