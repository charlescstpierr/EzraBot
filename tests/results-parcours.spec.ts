import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStore } from "../server/src/store";
import { loadMascots } from "../server/src/domain";
import { createServer } from "node:net";
import { createHttpServer } from "../server/src/http";
import { createWorker } from "../server/src/worker";
import type { Engine } from "../server/src/engine";

const testResults = test.extend<{ lab: Awaited<ReturnType<typeof openLab>> }>({
  lab: async ({ page }, use) => {
    await page.route("**/api/agents/view*", (route) =>
      route.fulfill({
        json: {
          rev: 1,
          projects: [],
          missions: [],
          engine: { state: "unavailable", message: "Fixture sans appel IA" },
          queue: [],
        },
      }),
    );
    const lab = await openLab();
    try {
      await use(lab);
    } finally {
      await lab.close();
    }
  },
});

async function openLab() {
  const store = openStore({
    path: join(mkdtempSync(join(tmpdir(), "ezra-results-")), "store.sqlite"),
    mascots: loadMascots(resolve("server/assets/mascots.json")),
  });
  const engine: Engine = {
    status: () => ({ state: "unavailable", message: "Moteur QA désactivé" }),
    catalog: async () => ({
      state: "unavailable",
      message: "Moteur QA désactivé",
    }),
    onUsage: () => () => {},
    run: async () => ({ kind: "cancelled" }),
    close: async () => {},
  };
  const worker = createWorker({
    store,
    engines: { chat: engine, doc: engine },
  });
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const bound = probe.address();
  if (!bound || typeof bound === "string") throw Error("Port QA absent");
  const port = bound.port;
  await new Promise<void>((done) => probe.close(() => done()));
  const server = createHttpServer({
    store,
    worker,
    engine,
    root: resolve("server"),
    port,
    csrfToken: "results-qa-only",
  });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Port QA absent");
  function document(botId: string, title: string, body: string) {
    const sent = store.dispatch({
      type: "message.send",
      requestId: randomUUID(),
      botId,
      text: title,
      attachments: [],
    });
    if (!sent.ok || sent.result.kind !== "message")
      throw Error("Demande absente");
    const workId = sent.result.workId;
    const claim = store.claimNext("chat");
    if (!claim) throw Error("Tentative absente");
    store.finishJob(claim, {
      kind: "succeeded",
      reply: { reply: "Document synthétique", deliverable: { title, body } },
      used: { model: "qa", effort: "low", speed: "standard" },
      threadId: "qa-thread",
      turnId: randomUUID(),
    });
    const work = store.view().works.find((work) => work.id === workId);
    if (!work?.versions[0]) throw Error("Version absente");
    return work;
  }
  return {
    store,
    document,
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await worker.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
    },
  };
}

testResults(
  "ouvre la version précise de plusieurs personnages et la publication",
  async ({ page, lab }, testInfo) => {
    const bots = lab.store.view().bots;
    const other = bots.find((bot) => bot.id !== "mino");
    if (!other) throw Error("Personnage de test absent");
    const first = lab.document(
      "mino",
      "Plan du jardin",
      "Version originale du jardin.",
    );
    const original = first.versions[0];
    if (!original) throw Error("Version absente");
    const edited = lab.store.dispatch({
      type: "version.edit",
      requestId: randomUUID(),
      workId: first.id,
      baseVersionId: original.id,
      title: "Plan du jardin corrigé",
      body: "Version corrigée du jardin.",
    });
    expect(edited.ok).toBe(true);
    lab.document(other.id, "Liste de graines", "Tomates et carottes.");
    const proposal = lab.store.dispatch({
      type: "publication.propose",
      requestId: randomUUID(),
      workId: first.id,
      versionId:
        edited.ok && edited.result.kind === "version"
          ? edited.result.versionId
          : original.id,
      destination: "carnet",
    });
    expect(proposal.ok).toBe(true);
    const pending = lab.store
      .view()
      .works.find((work) => work.id === first.id)
      ?.proposals.at(-1);
    if (!pending) throw Error("Proposition absente");
    expect(
      lab.store.dispatch({
        type: "publication.approve",
        requestId: randomUUID(),
        proposalId: pending.id,
        action: pending.action,
        destination: pending.destination,
        versionId: pending.versionId,
        payloadSha256: pending.payloadSha256,
      }).ok,
    ).toBe(true);
    await page.goto(lab.origin);
    await page
      .getByRole("button", { name: "Tous mes résultats", exact: true })
      .click();
    const list = page.getByRole("list", { name: "Résultats enregistrés" });
    await expect(list.getByRole("button")).toHaveCount(4);
    await expect(list).toContainText(other.name);
    await expect(
      page.getByText("Consommation non disponible").first(),
    ).not.toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("apres.png"),
      fullPage: true,
    });
    await list.getByRole("button", { name: /^Plan du jardin Version/ }).click();
    await expect(
      page.getByRole("heading", { name: "Version 1 · ancienne", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Version originale du jardin.", { exact: true }).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Tous mes résultats", exact: true })
      .click();
    await list.getByRole("button", { name: /Publication/ }).click();
    await expect(
      page.getByRole("heading", { name: "Version 2 · actuelle", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Tous mes résultats", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: /Personnage/ })
      .selectOption(other.id);
    await expect(list.getByRole("button")).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "Ouvrir le menu", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Tous mes résultats", exact: true })
      .click();
    await page.getByRole("combobox", { name: /Personnage/ }).selectOption("");
    const activity = page.getByText("Activité des travaux", { exact: true });
    await activity.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Détails de l’activité").first()).toBeVisible();
    await page.getByText("Détails de l’activité").first().click();
    await expect(
      page.getByText("Consommation non disponible").first(),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("mobile.png"),
      fullPage: true,
    });
  },
);

testResults(
  "distingue vide, erreur réseau et tentative active sans annoncer une réussite",
  async ({ page, lab }) => {
    await page.goto(lab.origin);
    await page
      .getByRole("button", { name: "Tous mes résultats", exact: true })
      .click();
    await expect(
      page.getByText("Aucun résultat enregistré pour le moment."),
    ).toBeVisible();
    const sent = lab.store.dispatch({
      type: "message.send",
      requestId: randomUUID(),
      botId: "mino",
      text: "Document en cours",
      attachments: [],
    });
    expect(sent.ok).toBe(true);
    const claim = lab.store.claimNext("chat");
    if (!claim) throw Error("Tentative absente");
    lab.store.setStage(claim, "writing");
    await page.getByText("Activité des travaux", { exact: true }).click();
    await page.getByText("Détails de l’activité", { exact: true }).click();
    await expect(
      page.getByText("Tentative 1 · Rédaction en cours", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".results-activity")).not.toContainText("Validé");
    await expect(
      page
        .getByRole("list", { name: "Résultats enregistrés" })
        .getByRole("button"),
    ).toHaveCount(0);
    await page.route("**/api/view*", (route) =>
      route.fulfill({ status: 503, body: "indisponible" }),
    );
    await expect(
      page.getByText(
        "Connexion interrompue. Les résultats affichés peuvent ne plus être à jour.",
      ),
    ).toBeVisible();
  },
);

testResults(
  "ouvre le résultat de mission dans la coordination existante",
  async ({ page, lab }) => {
    const mission = {
      id: "qa-mission-result",
      projectId: "qa-project",
      title: "Synthèse du potager",
      originMessageId: null,
      status: "review",
      goalRev: 1,
      attemptsUsed: 1,
      maxAttempts: 3,
      threadId: null,
      acceptedAttemptId: null,
      createdAt: "2026-11-14T12:00:00Z",
      updatedAt: "2026-11-14T12:05:00Z",
      mode: "coordinated",
      parentId: null,
      lead: { botId: "nova", name: "Nova", shape: "mino", color: "#335444" },
      waiting: null,
      tree: { used: 1, max: 8 },
      goals: [],
      attempts: [],
      events: [],
      eventsOmitted: 0,
      can: {
        stop: false,
        resume: false,
        continue: false,
        revise: false,
        review: false,
        accept: null,
        budget: false,
      },
      acceptBlocked: null,
      live: null,
      children: [],
      decisions: [],
      origin: null,
      parent: null,
      tokens: { total: 0, unknownAttempts: 1 },
      synthesis: null,
    } satisfies import("../server/src/agent-protocol").MissionDetail;
    await page.route("**/api/agents/view*", (route) =>
      route.fulfill({
        json: {
          rev: 1,
          missions: [
            mission,
            {
              ...mission,
              id: "qa-active",
              title: "Travail actif",
              status: "running",
            },
          ],
          projects: [],
          engine: { state: "unavailable" },
          queue: [],
        },
      }),
    );
    await page.route("**/api/agents/missions/qa-mission-result", (route) =>
      route.fulfill({ json: { rev: 1, mission, project: null } }),
    );
    await page.goto(lab.origin);
    await page
      .getByRole("button", { name: "Tous mes résultats", exact: true })
      .click();
    const list = page.getByRole("list", { name: "Résultats enregistrés" });
    await expect(list).toContainText("Nova");
    await expect(list).not.toContainText("Travail actif");
    await list.getByRole("button", { name: /Synthèse du potager/ }).click();
    await expect(
      page.getByRole("heading", { name: "Synthèse du potager", exact: true }),
    ).toBeVisible();
  },
);
