import { test, expect } from "@playwright/test";
import type { AppView } from "../server/src/protocol";
test("preuves visuelles du client avec un espace synthétique vide", async ({
  page,
  request,
}, info) => {
  const view: AppView = await (await request.get("/api/view")).json();
  const fixture = {
    ...view,
    activeBotId: "mino",
    bots: view.bots.filter((b) =>
      ["mino", "nova", "atlas", "pixel"].includes(b.id),
    ),
    messages: [],
    works: [],
    tasks: [],
    carnet: [],
  };
  await page.route("**/api/view*", (route) => route.fulfill({ json: fixture }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "Salut, moi c’est Mino." }),
  ).toBeVisible();
  const placement = await page.locator(".ez-chat-welcome").evaluate((node) => {
    const mascot = node.querySelector(".mascot")?.getBoundingClientRect();
    const area = node.getBoundingClientRect();
    const scroll = node.closest(".ez-chat-scroll");
    return {
      offset: mascot
        ? Math.abs(mascot.x + mascot.width / 2 - area.x - area.width / 2)
        : 999,
      scrollTop: scroll?.scrollTop,
    };
  });
  expect(placement.offset).toBeLessThan(2);
  expect(placement.scrollTop).toBe(0);
  await page.screenshot({
    path: info.outputPath("apres-chat-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Personnages", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Discuter avec Mino" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("apres-personnages-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("apres-chat-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("les rôles restent distincts et les accès téléphone et projets sont à gauche", async ({
  page,
  request,
}, info) => {
  const view: AppView = await (await request.get("/api/view")).json();
  const fixture: AppView = {
    ...view,
    activeBotId: "mino",
    works: [],
    tasks: [],
    messages: [
      {
        id: "qa-user",
        role: "user",
        text: "Peux-tu m’aider à préparer mon projet de jardin ?",
      },
      {
        id: "qa-bot",
        role: "assistant",
        text: "Commençons par les plantes que vous souhaitez cultiver.\n\n- Quelles herbes aimez-vous cuisiner ?\n- De combien de place disposez-vous ?",
      },
    ].map((message) => ({
      ...message,
      role: message.role === "user" ? "user" : "assistant",
      botId: "mino",
      threadBotId: "mino",
      workId: "",
      mentions: [],
      attachments: [],
      createdAt: "2026-11-12T14:00:00Z",
      stamp: null,
      taskStep: null,
      handoff: null,
    })),
  };
  await page.route("**/api/view*", (route) => route.fulfill({ json: fixture }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const user = page.locator('[data-message-id="qa-user"]');
  const bot = page.locator('[data-message-id="qa-bot"]');
  await expect(user).toHaveAccessibleName("Vous");
  await expect(bot).toHaveAccessibleName("Mino");
  await expect(page.locator(".ez-chat-scroll .mascot")).toHaveCount(1);
  await expect(page.locator("footer")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Parler à Mino" })).toHaveCount(
    0,
  );
  await expect(page.getByText("Service PC", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveAccessibleDescription(/Entrée pour envoyer/);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const userBox = await user.locator(".ez-chat-bubble").boundingBox();
    const botBox = await bot.locator(".ez-chat-bubble").boundingBox();
    expect(userBox).not.toBeNull();
    expect(botBox).not.toBeNull();
    expect(userBox!.x).toBeGreaterThan(botBox!.x);
    expect(userBox!.y + userBox!.height).toBeLessThan(botBox!.y);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: info.outputPath(`apres-messages-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "Ouvrir le menu" }).click();
  await expect(
    page.locator("aside").getByRole("button", { name: "Projets", exact: true }),
  ).toBeVisible();
  await page
    .locator("aside")
    .getByRole("button", { name: "Connexion téléphone", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Associer un téléphone" }),
  ).toHaveAttribute("href", "/devices");
  await expect(page.getByText("Service PC", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Fermer", exact: true }).click();
  await page.getByRole("button", { name: "Ouvrir le menu" }).click();
  await page.getByRole("button", { name: /^Préférences/ }).click();
  await expect(
    page.getByRole("dialog").getByText("Service PC", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("Moteur Codex", { exact: true }),
  ).toBeVisible();
});
