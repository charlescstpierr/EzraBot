import { test, expect } from "@playwright/test";
test("React assets, original mascot and local navigation work", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const asset of [
    "/",
    "/react-app.js",
    "/react-app.css",
    "/assets/symbols.svg",
    "/advanced",
  ])
    expect((await request.get(asset)).ok()).toBeTruthy();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Salut, moi c’est Mino." }),
  ).toBeVisible();
  await expect(
    page.locator(".ez-chat-hero .mascot-live .mascot-eyes"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Mettre mes idées au clair" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Peux-tu m’aider à structurer mes idées ?");
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Peux-tu m’aider à structurer mes idées ?");
  await page.getByRole("button", { name: "Projets", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Tout commence par un dossier." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Ajouter un dossier" })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Fermer", exact: true }).click();
  expect(errors).toEqual([]);
});
test("drafts stay separate and mobile fits the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await input.fill("Brouillon de Mino");
  await page.getByRole("button", { name: "Ouvrir le menu" }).click();
  await page.locator(".threads").getByRole("button", { name: /Nova/ }).click();
  await expect(input).toHaveValue("");
  await input.fill("Brouillon de Nova");
  await page.getByRole("button", { name: "Ouvrir le menu" }).click();
  await page.locator(".threads").getByRole("button", { name: /Mino/ }).click();
  await expect(input).toHaveValue("Brouillon de Mino");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
test("a failed or uncertain send preserves the text and retry identity", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await input.fill("Message pour vérifier la reprise");
  const ids: string[] = [];
  await page.route("**/api/commands", async (route) => {
    ids.push(route.request().postDataJSON().requestId);
    await route.abort();
  });
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await input.fill("Un nouveau brouillon à garder");
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect.poll(() => ids.length).toBe(2);
  expect(ids[0]).toBe(ids[1]);
  await expect(input).toHaveValue("Un nouveau brouillon à garder");
});

test("an accepted retry keeps a newer draft and changing threads during send is safe", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await input.fill("Premier message");
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  await page.route("**/api/commands", async (route) => {
    if (route.request().postDataJSON().type !== "message.say")
      return route.continue();
    await hold;
    await route.fulfill({ response: await route.fetch() });
  });
  const sent = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/commands") &&
      r.request().postDataJSON().type === "message.say",
  );
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await input.fill("Brouillon suivant");
  await page.locator(".threads").getByRole("button", { name: /Nova/ }).click();
  await input.fill("Texte privé de Nova");
  release();
  await sent;
  await expect(
    page.getByRole("button", { name: "Envoyer le message" }),
  ).toBeEnabled();
  await expect(input).toHaveValue("Texte privé de Nova");
  await page.locator(".threads").getByRole("button", { name: /Mino/ }).click();
  await expect(input).toHaveValue("Brouillon suivant");
});
test("a confirmed refusal does not trap the next message in the outbox", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  const payloads: string[] = [];
  await page.route("**/api/commands", async (route) => {
    payloads.push(route.request().postDataJSON().text);
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, message: "Refus contrôlé" }),
    });
  });
  await input.fill("Ancien message refusé");
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect(page.getByRole("alert")).toContainText("Refus contrôlé");
  await input.fill("Nouveau message");
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect.poll(() => payloads.length).toBe(2);
  expect(payloads).toEqual(["Ancien message refusé", "Nouveau message"]);
});
test("inviting a bot sends exact mention spans in the current thread", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await input.fill("Bonjour");
  await page
    .getByRole("button", { name: "Ajouter des pièces jointes" })
    .click();
  await page.getByRole("menuitem", { name: "Inviter un personnage" }).click();
  await page
    .locator(".bot-fan")
    .getByRole("button", { name: "Nova", exact: true })
    .click();
  await expect(input).toHaveValue("Bonjour @Nova ");
  const req = page.waitForRequest((r) => r.url().endsWith("/api/commands"));
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  const data = (await req).postDataJSON();
  expect(data.botId).toBe("mino");
  expect(data.mentions).toEqual([{ botId: "nova", start: 8, end: 13 }]);
});
