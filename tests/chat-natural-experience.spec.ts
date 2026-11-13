import { test, expect } from "@playwright/test";
import type { AppView, MessageView, WorkView } from "../server/src/protocol";

const toolsBase = `http://127.0.0.1:${process.env.MINO_QA_TOOLS_PORT ?? "4398"}`;

test("réponse progressive puis finale sans estampille, avec une seule mascotte vivante (vue simulée)", async ({
  page,
  request,
}, testInfo) => {
  const view: AppView = await (await request.get("/api/view")).json();
  const stamp: NonNullable<MessageView["stamp"]> = {
    model: "gpt-5.4",
    effort: "medium",
    speed: "standard",
    threadId: "synthetic-thread",
    turnId: "synthetic-turn",
  };
  const previous: MessageView = {
    id: "natural-previous",
    threadBotId: "mino",
    botId: "mino",
    role: "assistant",
    text: "Bonjour, on prépare le jardin ?",
    workId: "natural-old-work",
    mentions: [],
    attachments: [],
    createdAt: "2026-11-12T14:00:00Z",
    stamp,
    taskStep: null,
    handoff: null,
  };
  const work: WorkView & { replyPreview?: string | null } = {
    id: "natural-running",
    threadBotId: "mino",
    botId: "mino",
    taskId: null,
    requestMessageId: "natural-question",
    state: "pending",
    title: "",
    createdAt: previous.createdAt,
    updatedAt: previous.createdAt,
    attempt: null,
    attempts: 0,
    versions: [],
    proposals: [],
    replyPreview: null,
  };
  view.activeBotId = "mino";
  view.tasks = [];
  view.messages = [previous];
  view.works = [];
  await page.route("**/api/view*", (route) => route.fulfill({ json: view }));
  await page.route("**/api/commands", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const command = route.request().postDataJSON();
    if (command.type === "message.say" || command.type === "message.send") {
      view.messages.push({
        ...previous,
        id: work.requestMessageId,
        role: "user",
        text: command.text,
        workId: work.id,
        stamp: null,
      });
      view.works = [work];
      view.rev++;
      await route.fulfill({ response, json: { ...body, view } });
    } else await route.fulfill({ response });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const chat = page.getByRole("main");
  await expect(chat.getByText(previous.text, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("chat-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("chat-mobile-390.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Oui, des tomates.");
  await page
    .getByRole("button", { name: "Envoyer le message", exact: true })
    .click();
  const waiting = chat.getByRole("status").filter({ hasText: "Mino" });
  await expect(waiting).toBeVisible();
  await expect(waiting.locator(".mascot")).toBeVisible();
  work.state = "running";
  work.replyPreview = "Commençons par deux plants";
  view.rev++;
  await expect
    .soft(
      chat.getByText(work.replyPreview, { exact: true }),
      "Le préfixe apparaît avant la fin du travail simulé",
    )
    .toBeVisible();
  await expect(
    chat
      .getByRole("article")
      .filter({ hasText: "Commençons par deux plants de tomates." }),
  ).toHaveCount(0);
  work.state = "done";
  work.replyPreview = null;
  const finalText = "Commençons par deux plants de tomates.";
  view.messages.push({
    ...previous,
    id: "natural-final",
    text: finalText,
    workId: work.id,
  });
  view.rev++;
  const latest = chat.getByRole("article").filter({ hasText: finalText });
  await expect(latest).toBeVisible();
  await expect(chat.getByText(finalText, { exact: true })).toHaveCount(1);
  await expect(waiting).toHaveCount(0);
  await expect
    .soft(chat.getByRole("article").getByText(/gpt-5\.4|medium|standard/))
    .toHaveCount(0);
  await expect(page.locator(".ez-chat-scroll .mascot")).toHaveCount(2);
  const live = page.locator(".ez-chat-scroll .mascot-live");
  await expect(live).toHaveCount(1);
  await expect(live).toBeVisible();
  const mascotBox = (await live.boundingBox())!;
  const replyBox = (await latest.locator(".ez-chat-bubble").boundingBox())!;
  expect(mascotBox.x + mascotBox.width).toBeLessThanOrEqual(replyBox.x);
  expect(
    Math.abs(mascotBox.y + mascotBox.height - replyBox.y - replyBox.height),
  ).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath("chat-final.png") });
});

test("le composeur sombre et symétrique range l’invitation dans le menu plus", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const add = page.getByRole("button", {
    name: "Ajouter des pièces jointes",
    exact: true,
  });
  const send = page.getByRole("button", {
    name: "Envoyer le message",
    exact: true,
  });
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(message).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`composer-${viewport.width}.png`),
    });
    await expect
      .soft(page.getByRole("button", { name: /Inviter/ }))
      .toHaveCount(0);
    const left = await add.boundingBox();
    const right = await send.boundingBox();
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect
      .soft(
        Math.abs(left!.height - right!.height),
        "Les deux commandes ont la même hauteur",
      )
      .toBeLessThanOrEqual(1);
    expect
      .soft(Math.abs(left!.y - right!.y), "Les commandes sont alignées")
      .toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
    const surface = await message.evaluate((element) => {
      const form = element.closest("form");
      if (!form) throw Error("Le champ doit appartenir au composeur");
      const style = getComputedStyle(form);
      return {
        background: style.backgroundColor,
        radius: parseFloat(style.borderTopLeftRadius),
        width: form.getBoundingClientRect().width,
      };
    });
    const channels = surface.background
      .match(/[\d.]+/g)
      ?.slice(0, 3)
      .map(Number);
    expect(channels).toHaveLength(3);
    expect
      .soft(Math.max(...channels!), "Le fond du composeur est sombre")
      .toBeLessThan(80);
    expect
      .soft(surface.radius, "Le composeur est arrondi")
      .toBeGreaterThanOrEqual(16);
    expect(surface.width).toBeLessThanOrEqual(viewport.width);
  }
  await add.click();
  const menu = page.getByRole("menu");
  for (const name of ["Photos", "Fichiers", "Dossier"]) {
    await expect(
      menu.getByRole("menuitem", { name, exact: true }),
    ).toBeVisible();
  }
  await expect
    .soft(menu.getByRole("menuitem", { name: /Inviter/ }))
    .toBeVisible();
  await page
    .getByRole("button", { name: "Fermer les pièces jointes", exact: true })
    .click();
  await expect(menu).toHaveCount(0);
  await add.click();
  const chosen = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Fichiers", exact: true }).click();
  await (
    await chosen
  ).setFiles({
    name: "natural-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Notes synthétiques"),
  });
  await expect(
    page.getByRole("button", {
      name: "Retirer natural-notes.txt",
      exact: true,
    }),
  ).toBeVisible();
});

test("le modèle reste dans la création et la modification, puis persiste par bot (API réelle)", async ({
  page,
}) => {
  await page.goto(toolsBase);
  const initial: AppView = await (
    await page.request.get(new URL("/api/view", page.url()).href)
  ).json();
  const minoModel = initial.bots.find((bot) => bot.id === "mino")?.choice.model;
  const name = `Jardin ${Date.now().toString(36)}`;
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Nouveau personnage", exact: true })
    .click();
  const create = page.getByRole("dialog", {
    name: "Nouveau personnage",
    exact: true,
  });
  await create.getByLabel("Nom", { exact: true }).fill(name);
  await create
    .getByLabel("Personnalité et instructions", { exact: true })
    .fill("Tu parles des plantes.");
  await create.getByRole("button", { name: /^Modèle/ }).click();
  await expect(create.getByRole("option", { name: /Fake Sol/ })).toBeVisible();
  await create
    .getByRole("button", { name: "Modèle par défaut", exact: true })
    .click();
  await create
    .getByRole("button", { name: "Créer et discuter", exact: true })
    .click();
  await expect(create).toHaveCount(0);
  await expect
    .soft(
      page.locator("main > header").getByRole("button", { name: /^Modèle/ }),
      "Le modèle ne reste pas dans l’en-tête",
    )
    .toHaveCount(0);
  await page
    .locator("main > header")
    .getByRole("button", { name, exact: true })
    .click();
  await page.getByRole("menuitem", { name: /^Modifier/ }).click();
  const edit = page.getByRole("dialog").filter({
    has: page.getByLabel("Personnalité et instructions", { exact: true }),
  });
  await expect(edit.getByRole("button", { name: /^Modèle/ })).toContainText(
    "Fake Sol",
  );
  await edit
    .getByLabel("Personnalité et instructions", { exact: true })
    .fill("Tu poses une question à la fois.");
  await edit.getByRole("button", { name: /^Modèle/ }).click();
  await edit.getByRole("option", { name: /Fake Sol/ }).click();
  await edit.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await page.reload();
  const view: AppView = await (
    await page.request.get(new URL("/api/view", page.url()).href)
  ).json();
  expect(view.bots.find((bot) => bot.name === name)).toMatchObject({
    instructions: "Tu poses une question à la fois.",
    choice: { model: "fake-sol" },
  });
  expect(view.bots.find((bot) => bot.id === "mino")?.choice.model).toBe(
    minoModel,
  );
  await page
    .locator("main > header")
    .getByRole("button", { name, exact: true })
    .click();
  await page.getByRole("menuitem", { name: /^Modifier/ }).click();
  await expect(
    edit.getByLabel("Personnalité et instructions", { exact: true }),
  ).toHaveValue("Tu poses une question à la fois.");
  await expect(edit.getByRole("button", { name: /^Modèle/ })).toContainText(
    "Fake Sol",
  );
});
