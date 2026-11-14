import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppView } from "../server/src/protocol";

test("le Markdown ne crée aucune image réseau dans la page parente", async ({
  page,
  request,
}) => {
  const view: AppView = await (await request.get("/api/view")).json();
  view.activeBotId = "mino";
  view.works = [];
  view.tasks = [];
  view.messages = [
    {
      id: "image-recette",
      botId: "mino",
      threadBotId: "mino",
      role: "assistant",
      text: "![Locale](/api/export?threadBotId=mino)\n![Distante](https://example.test/pixel.png)",
      workId: "",
      mentions: [],
      attachments: [],
      createdAt: new Date().toISOString(),
      stamp: null,
      taskStep: null,
      trigger: null,
      handoff: null,
    },
  ];
  await page.route("**/api/view*", (route) => route.fulfill({ json: view }));
  await page.route("**/api/export*", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator('[data-message-id="image-recette"]')).toBeVisible();
  await expect(
    page.locator('[data-message-id="image-recette"] img'),
  ).toHaveCount(0);
});

test("un ajout de projet incertain reste récupérable après fermeture et rechargement", async ({
  page,
}, info) => {
  const path = mkdtempSync(join(tmpdir(), "ezrabot-projet-reprise-"));
  const sent: unknown[] = [];
  await page.route("**/api/agents/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "project.add") return route.continue();
    sent.push(command);
    const response = await route.fetch();
    if (sent.length === 1) await route.abort();
    else await route.fulfill({ response });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Projets", exact: true }).click();
  await page
    .getByRole("button", { name: "Ajouter un dossier", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Chemin complet du dossier").fill(path);
  await dialog.getByLabel("Nom affiché").fill("Projet reprise réelle");
  await dialog
    .getByRole("button", { name: "Confier ce dossier", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Fermer", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("projet-confirmation-inconnue.png"),
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Fermer", exact: true }).click();
  await page.reload();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/agents/commands") &&
      r.request().postDataJSON().type === "project.add",
  );
  await expect(
    page.getByRole("button", {
      name: "Réessayer la commande en attente",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Réessayer la commande en attente",
      exact: true,
    })
    .click();
  expect((await (await response).json()).replayed).toBeTruthy();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
});

test("une mission déjà acceptée mais non confirmée ne se duplique pas après rechargement", async ({
  page,
  request,
}) => {
  const path = mkdtempSync(join(tmpdir(), "ezrabot-mission-reprise-"));
  await page.goto("/");
  const project = await page.evaluate(async (path) => {
    const response = await fetch("/api/agents/commands", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mino-csrf":
          document.querySelector<HTMLMetaElement>('meta[name="mino-csrf"]')
            ?.content ?? "",
      },
      body: JSON.stringify({
        type: "project.add",
        requestId: crypto.randomUUID(),
        path,
        name: "Projet mission réelle",
      }),
    });
    return response.json();
  }, path);
  expect(project.ok).toBeTruthy();
  const sent: unknown[] = [];
  await page.route("**/api/agents/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "mission.create") return route.continue();
    sent.push(command);
    const response = await route.fetch();
    if (sent.length === 1) await route.abort();
    else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Missions", exact: true }).click();
  await page
    .getByRole("button", { name: "Nouvelle mission", exact: true })
    .click();
  await page.getByLabel("Dossier de la mission").selectOption(project.id);
  const goal = "Mission synthétique sans double exécution";
  await page.getByLabel("Objectif à confier").fill(goal);
  await page
    .getByRole("button", { name: "Confier la mission", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("inconnu");
  await page.reload();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/agents/commands") &&
      r.request().postDataJSON().type === "mission.create",
  );
  await expect(
    page.getByRole("button", {
      name: "Réessayer la commande en attente",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Réessayer la commande en attente",
      exact: true,
    })
    .click();
  expect((await (await response).json()).replayed).toBeTruthy();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  const view = await (await request.get("/api/agents/view")).json();
  expect(
    view.missions.filter((m: { title: string }) => m.title === goal),
  ).toHaveLength(1);
});

test("les en-têtes de missions et projets restent lisibles sur mobile", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  for (const name of ["Missions", "Projets"]) {
    await page
      .getByRole("button", { name: "Ouvrir le menu", exact: true })
      .click();
    await page.getByRole("button", { name, exact: true }).click();
    const header = page.locator(
      name === "Missions" ? ".missions-page header" : ".projects-page header",
    );
    await expect(header).toBeVisible();
    await page.screenshot({
      path: info.outputPath(`mobile-${name}.png`),
      fullPage: true,
    });
    const boxes = await header.evaluate((node) => {
      const area = node.getBoundingClientRect();
      return {
        bottom: area.bottom,
        children: [...node.children].map(
          (child) => child.getBoundingClientRect().bottom,
        ),
      };
    });
    for (const bottom of boxes.children)
      expect(bottom).toBeLessThanOrEqual(boxes.bottom + 1);
  }
});
