import { test, expect } from "@playwright/test";
import type { AppView, MessageView, WorkView } from "../server/src/protocol";

test("la recherche retrouve les anciens passages sans accents et cible le message exact", async ({
  page,
  request,
}) => {
  const view: AppView = await (await request.get("/api/view")).json();
  const createdAt = "2025-01-01T00:00:00.000Z";
  const fixture = (
    id: string,
    threadBotId: string,
    text: string,
  ): MessageView => ({
    id,
    threadBotId,
    botId: threadBotId,
    text,
    role: "user",
    mentions: [],
    workId: "",
    attachments: [],
    createdAt,
    stamp: null,
    taskStep: null,
    trigger: null,
    handoff: null,
  });
  view.messages = [
    fixture("search-ancien", "mino", "Une préparation caféine pour demain."),
    fixture("search-autre-fil", "nova", "Une autre préparation caféine."),
    fixture(
      "search-recent",
      "mino",
      "Le dernier message du fil ne contient pas les termes.",
    ),
  ];
  await page.route("**/api/view", (route) => route.fulfill({ json: view }));
  await page.route("**/api/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "bot.select") return route.continue();
    view.activeBotId = command.botId;
    view.rev++;
    await route.fulfill({
      json: {
        ok: true,
        replayed: false,
        result: { kind: "bot", botId: command.botId },
        view,
      },
    });
  });
  await page.goto("/");
  const search = page.getByRole("textbox", { name: "Rechercher", exact: true });
  await search.fill("preparation cafeine");
  await expect(page.locator(".ez-search-navigation")).toContainText("1 / 2");
  await page
    .locator(".ez-search-results")
    .getByRole("button", { name: /Mino.*Votre message/ })
    .click();
  await expect(page.locator('[data-message-id="search-ancien"]')).toHaveClass(
    /ez-chat-focused/,
  );
  await page.getByRole("button", { name: "Résultat suivant" }).click();
  await expect(
    page.locator('[data-message-id="search-autre-fil"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "Résultat précédent" }).click();
  await expect(page.locator('[data-message-id="search-ancien"]')).toBeVisible();
});

test("seule la version courante figure parmi les résultats documentaires", async ({
  page,
  request,
}) => {
  const view: AppView = await (await request.get("/api/view")).json();
  const createdAt = "2025-01-01T00:00:00.000Z";
  const work: WorkView = {
    next: { kind: "none", reason: "Terminé" }, lastFact: { kind: "none" },
    id: "search-document",
    threadBotId: "mino",
    botId: "mino",
    taskId: null,
    requestMessageId: "search-source",
    title: "Note de recherche",
    state: "done",
    createdAt,
    updatedAt: createdAt,
    attempts: 0,
    attempt: null,
    proposals: [],
    versions: [
      {
        id: "search-v1",
        n: 1,
        title: "Ancienne version",
        body: "Terme disparu zebrureancienne",
        source: "edit",
        restoredFromN: null,
        createdAt,
      },
      {
        id: "search-v2",
        n: 2,
        title: "Version courante",
        body: "Résultat documentaire caféineunique",
        source: "edit",
        restoredFromN: null,
        createdAt,
      },
    ],
  };
  view.works = [work];
  view.messages = [];
  await page.route("**/api/view", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  const search = page.getByRole("textbox", { name: "Rechercher", exact: true });
  await search.fill("zebrureancienne");
  await expect(page.locator(".ez-search-navigation")).toContainText(
    "Aucun résultat",
  );
  await search.fill("cafeineunique");
  await expect(page.locator(".ez-search-navigation")).toContainText("1 / 1");
  await page
    .locator(".ez-search-results")
    .getByRole("button", { name: /Document · v2/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Version 2 · actuelle", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Modifier", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Titre", exact: true }),
  ).toHaveValue("Version courante");
});
