import { mkdirSync } from "node:fs";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { PcView } from "../server/src/tools-protocol";

// Real isolated store, worker, memory desk and HTTP server. Honcho and the App Server are fakes started by
// scripts/test-server.mjs: every project, declaration, request and workspace on these pages is synthetic.

const HONCHO = "http://127.0.0.1:4397";
const EVIDENCE = "test-results/honcho-parcours";
const HEADERS = { origin: HONCHO, "x-mino-csrf": "test-only-token" };

async function pcView(request: APIRequestContext): Promise<PcView> {
  return (await request.get(`${HONCHO}/api/view`)).json();
}

async function command(
  request: APIRequestContext,
  route: "commands" | "memory/commands",
  data: Record<string, unknown>,
) {
  const response = await request.post(`${HONCHO}/api/${route}`, {
    headers: HEADERS,
    data: { requestId: crypto.randomUUID(), ...data },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

const scopeOf = async (request: APIRequestContext, botId: string) =>
  (await pcView(request)).memory.scopes.find((scope) => scope.botId === botId);

/** Gives a character a Honcho project through the real PC route and waits for its workspace. */
async function enable(
  request: APIRequestContext,
  botId: string,
  label: string,
) {
  await command(request, "memory/commands", {
    type: "memory.enable",
    botId,
    label,
    acknowledged: true,
  });
  await expect
    .poll(async () => (await scopeOf(request, botId))?.state)
    .toBe("active");
}

async function declare(
  request: APIRequestContext,
  botId: string,
  text: string,
) {
  await command(request, "memory/commands", {
    type: "memory.declare",
    botId,
    text,
  });
  await expect
    .poll(async () =>
      (await scopeOf(request, botId))?.declarations.every(
        (declaration) => declaration.sync === "verified",
      ),
    )
    .toBe(true);
}

async function newCharacter(request: APIRequestContext, name: string) {
  const created = await command(request, "commands", {
    type: "bot.create",
    name,
    title: "Personnage de recette",
    shape: "radish",
    color: "#8de343",
  });
  return created.result.botId as string;
}

async function openCharacter(page: Page, name: string) {
  await page.goto(HONCHO);
  await page.getByRole("button", { name: "Personnages", exact: true }).click();
  await page
    .locator(".character-tabs")
    .getByRole("button", { name, exact: true })
    .click();
}

async function openThread(page: Page, name: string) {
  await page.goto(HONCHO);
  await page
    .locator(".threads")
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
}

/** Sends one request and waits for the reply of the fake engine under it. */
async function ask(page: Page, text: string) {
  const replies = page.locator(".ez-chat-assistant");
  const before = await replies.count();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect(replies).toHaveCount(before + 1);
  return replies.nth(before);
}

// Tall enough for a whole memory section of a character page, so each picture and video shows it in one piece.
const SIZE = { width: 1280, height: 1500 };
test.use({ viewport: SIZE, video: { mode: "on", size: SIZE } });

test.beforeAll(() => mkdirSync(EVIDENCE, { recursive: true }));

test("consentement : les limites sont dites avant la bascule, puis un souvenir local choisi devient une déclaration vérifiée", async ({
  page,
  request,
}) => {
  const botId = await newCharacter(request, "Capucine");
  await command(request, "commands", {
    type: "memory.create",
    botId,
    text: "Préfère les réponses en trois points.",
  });
  await openCharacter(page, "Capucine");
  const consent = page
    .locator("section")
    .filter({ hasText: "Passer à la mémoire Honcho" });
  for (const limit of [
    "Rien n’est partagé avec un autre personnage.",
    "Les réponses des personnages et les fichiers joints ne sont pas envoyés.",
    "les comptes rendus d’action et ses réponses dans une autre conversation partent sans mémoire.",
    "ses souvenirs locaux ne sont plus envoyés au moteur.",
    "le personnage répond sans aucune mémoire.",
    "EzraBot ne peut pas prouver que Honcho a tout effacé.",
    "Le téléphone montre seulement son état.",
    "Ce choix ne se défait pas.",
  ])
    await expect(consent).toContainText(limit);
  await expect(page.locator(".ez-character-memory")).toContainText(
    "Préfère les réponses en trois points.",
  );
  await consent.screenshot({ path: `${EVIDENCE}/01-avant-consentement.png` });
  expect(await scopeOf(request, botId)).toBeUndefined();

  await consent
    .getByLabel("Nom du projet de mémoire", { exact: true })
    .fill("Jardin de Capucine");
  await consent.getByRole("checkbox").check();
  await consent
    .getByRole("button", { name: "Activer la mémoire Honcho" })
    .click();
  const project = page
    .locator("section")
    .filter({ hasText: "Mémoire Honcho · projet « Jardin de Capucine »" });
  await expect(project.getByRole("status")).toHaveText("Mémoire active.");
  await expect(page.getByRole("heading", { name: "Sa mémoire" })).toHaveCount(
    0,
  );
  await expect(project).toContainText("Anciens souvenirs locaux");
  expect((await scopeOf(request, botId))?.declarations).toEqual([]);

  await project
    .getByRole("checkbox", { name: "Préfère les réponses en trois points." })
    .check();
  await project
    .getByRole("button", { name: "Importer la sélection comme déclarations" })
    .click();
  await project
    .getByLabel("Une déclaration à retenir", { exact: true })
    .fill("Jardine le samedi matin.");
  await project.getByRole("button", { name: "Ajouter la déclaration" }).click();
  await expect(project.locator(".ez-memory-item")).toHaveCount(2);
  await expect(
    project.locator(".ez-memory-item").filter({ hasText: "copie vérifiée" }),
  ).toHaveCount(2);
  await expect(project).not.toContainText("Anciens souvenirs locaux");
  const bot = (await pcView(request)).bots.find(
    (candidate) => candidate.id === botId,
  );
  expect(bot?.memories).toEqual([]);
  await project.screenshot({ path: `${EVIDENCE}/02-memoire-active.png` });
});

test("rappel sourcé : la réponse montre ses sources, et une demande rappelée s’ouvre sur son original", async ({
  page,
  request,
}) => {
  const botId = await newCharacter(request, "Basilic");
  await enable(request, botId, "Cuisine de Basilic");
  await declare(request, botId, "Cuisine sans gluten depuis mars.");
  await openThread(page, "Basilic");

  const first = await ask(page, "Propose un dessert pour dimanche midi.");
  await first
    .getByRole("button", { name: "Mémoire utilisée : 1 source" })
    .click();
  const firstSources = first.getByRole("list", {
    name: "Sources de mémoire de cette réponse",
  });
  await expect(firstSources).toContainText("Déclaration, révision 1");
  await expect(firstSources).toContainText("Cuisine sans gluten depuis mars.");
  await expect
    .poll(async () => (await scopeOf(request, botId))?.messages.verified)
    .toBe(1);

  const second = await ask(page, "Et un autre dessert pour dimanche soir ?");
  await second
    .getByRole("button", { name: "Mémoire utilisée : 2 sources" })
    .click();
  const sources = second.getByRole("list", {
    name: "Sources de mémoire de cette réponse",
  });
  await expect(sources).toContainText("Propose un dessert pour dimanche midi.");
  await second.screenshot({ path: `${EVIDENCE}/03-rappel-source.png` });
  await sources
    .getByRole("button", { name: "Ouvrir la demande d’origine" })
    .click();
  await expect(page.locator(".ez-chat-focused")).toContainText(
    "Propose un dessert pour dimanche midi.",
  );
});

test("correction et exclusion : l’ancienne version quitte les sources, une demande exclue reste affichée mais ne sert plus", async ({
  page,
  request,
}) => {
  const botId = await newCharacter(request, "Romarin");
  await enable(request, botId, "Voyages de Romarin");
  await declare(request, botId, "Habite à Lyon.");
  await openThread(page, "Romarin");
  const first = await ask(page, "Quel train prendre pour la mer ?");
  await expect(
    first.getByRole("button", { name: "Mémoire utilisée : 1 source" }),
  ).toBeVisible();

  await openCharacter(page, "Romarin");
  const project = page
    .locator("section")
    .filter({ hasText: "Mémoire Honcho · projet « Voyages de Romarin »" });
  await project.getByRole("button", { name: "Corriger", exact: true }).click();
  await project
    .getByRole("textbox", { name: "Texte corrigé", exact: true })
    .fill("Habite à Nantes.");
  await project
    .getByRole("button", { name: "Enregistrer la correction" })
    .click();
  const corrected = project.locator(".ez-memory-item");
  await expect(corrected).toContainText("Habite à Nantes.");
  await expect(corrected).toContainText("Révision 2 · copie vérifiée");
  await expect(project).not.toContainText("Habite à Lyon.");

  await openThread(page, "Romarin");
  const earlier = page.locator(".ez-chat-assistant").first();
  await earlier
    .getByRole("button", { name: "Mémoire utilisée : 1 source" })
    .click();
  await expect(earlier).toContainText(
    "Déclaration retirée depuis. Son texte n’est plus affiché.",
  );
  await expect(earlier).not.toContainText("Habite à Lyon.");

  const asked = page
    .locator(".ez-chat-user")
    .filter({ hasText: "Quel train prendre pour la mer ?" });
  await asked.getByRole("button", { name: "Exclure de la mémoire" }).click();
  await asked.getByRole("button", { name: "Confirmer l’exclusion" }).click();
  await expect(asked).toContainText("Demande exclue de la mémoire Honcho.");
  await expect(asked).toContainText("Quel train prendre pour la mer ?");
  await page
    .locator(".ez-chat-thread, main")
    .first()
    .screenshot({ path: `${EVIDENCE}/04-correction-exclusion.png` });
  const later = await ask(page, "Et pour la montagne ?");
  await later
    .getByRole("button", { name: "Mémoire utilisée : 1 source" })
    .click();
  await expect(later).toContainText("Habite à Nantes.");
  await expect(later).not.toContainText("Quel train prendre pour la mer ?");

  await openCharacter(page, "Romarin");
  await page
    .getByRole("button", { name: "Ouvrir la demande exclue 1" })
    .click();
  await expect(page.locator(".ez-chat-focused")).toContainText(
    "Quel train prendre pour la mer ?",
  );
});

test("panne, oubli et nouvel espace vide : sans Honcho la réponse part sans mémoire, l’oubli ferme tout de suite, et rien d’ancien ne revient", async ({
  page,
  request,
}) => {
  const botId = await newCharacter(request, "Sauge");
  await enable(request, botId, "Carnet de Sauge");
  await declare(request, botId, "Écrit un carnet de voyage.");
  await openThread(page, "Sauge");
  const failed = await ask(page, "Une panne-synthétique pendant le rappel ?");
  await expect(failed).toContainText(
    "Réponse composée sans mémoire : Honcho n’a pas pu être consulté.",
  );
  await failed.screenshot({ path: `${EVIDENCE}/05-panne.png` });

  await openCharacter(page, "Sauge");
  const project = page
    .locator("section")
    .filter({ hasText: "Mémoire Honcho · projet « Carnet de Sauge »" });
  const forget = project.getByRole("button", {
    name: "Oublier la mémoire de Sauge",
  });
  await expect(forget).toBeDisabled();
  await project
    .getByLabel("Recopier le nom du projet « Carnet de Sauge »", {
      exact: true,
    })
    .fill("Carnet de Sauge");
  await forget.click();
  await expect(project.getByRole("status")).toContainText(
    "EzraBot ne peut pas prouver l’effacement.",
  );
  await expect(project).not.toContainText("Écrit un carnet de voyage.");
  await expect(
    project.getByLabel("Une déclaration à retenir", { exact: true }),
  ).toHaveCount(0);
  await project.screenshot({ path: `${EVIDENCE}/06-oubli.png` });

  await openThread(page, "Sauge");
  const suspended = await ask(page, "Que retiens-tu de mon carnet ?");
  await expect(suspended).toContainText(
    "Réponse composée sans mémoire : elle est suspendue.",
  );

  await openCharacter(page, "Sauge");
  const reopen = project.getByRole("button", {
    name: "Ouvrir un nouvel espace vide",
  });
  await project
    .getByLabel("Recopier le nom du projet « Carnet de Sauge »", {
      exact: true,
    })
    .fill("Carnet de Sauge");
  await project.getByRole("checkbox").check();
  await reopen.click();
  await expect(project.getByRole("status")).toHaveText("Mémoire active.");
  await expect(project.locator(".ez-memory-item")).toHaveCount(0);
  const scope = await scopeOf(request, botId);
  expect([scope?.declarations, scope?.messages]).toEqual([
    [],
    { pending: 0, verified: 0, uncertain: 0, failed: 0 },
  ]);
  await project.screenshot({ path: `${EVIDENCE}/07-nouvel-espace.png` });
});
