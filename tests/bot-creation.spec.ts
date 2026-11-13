import { test, expect, type Page } from "@playwright/test";

const commands = (page: Page, type: string) => {
  const seen: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/commands")) return;
    const body = request.postDataJSON();
    if (body?.type === type) seen.push(body);
  });
  return seen;
};
const editSheet = async (page: Page, name: string) => {
  await page.locator("main > header .bot-title").click();
  await page.getByRole("menuitem", { name: `Modifier ${name}` }).click();
  return page.getByRole("dialog", { name: `Modifier ${name}`, exact: true });
};

test("créer un personnage avec sa personnalité ouvre la conversation, puis se modifie sans la quitter", async ({
  page,
}) => {
  const name = `Basilic ${test.info().repeatEachIndex}${Date.now() % 1000}`;
  const personality = "Tu es patient. Tu poses une question à la fois.";
  const creates = commands(page, "bot.create");
  await page.goto("/");
  await page.locator(".threads").getByRole("button", { name: /^Mino/ }).click();
  const title = page
    .locator("main > header")
    .getByRole("button", { name: "Mino", exact: true });
  await title.click();
  const menu = page.getByRole("menu", { name: "Personnages" });
  await expect(menu.getByRole("menuitemradio", { name: /Mino/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(title).toBeFocused();

  await title.click();
  await menu.getByRole("menuitem", { name: "Nouveau personnage" }).click();
  const sheet = page.getByRole("dialog", { name: "Nouveau personnage" });
  await expect(sheet.getByLabel("Nom", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(title).toBeFocused();
  expect(creates).toHaveLength(0);

  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Nouveau personnage" })
    .click();
  await sheet.getByLabel("Nom", { exact: true }).fill(name);
  await sheet
    .getByLabel("Personnalité et instructions", { exact: true })
    .fill(personality);
  await sheet.getByRole("button", { name: "Apparence" }).click();
  await sheet.getByTitle("Champignon").click();
  await expect(sheet.getByRole("radio", { name: "Champignon" })).toBeChecked();
  await sheet.getByRole("button", { name: "Créer et discuter" }).click();

  await expect(sheet).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: `Salut, moi c’est ${name}.` }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeFocused();
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({
    name,
    instructions: personality,
    shape: "mushroom",
  });

  await page.reload();
  const created = page
    .locator("main > header")
    .getByRole("button", { name, exact: true });
  await expect(created).toBeVisible();
  await created.click();
  await page.getByRole("menuitem", { name: `Modifier ${name}` }).click();
  const edit = page.getByRole("dialog", { name: `Modifier ${name}` });
  const field = edit.getByLabel("Personnalité et instructions", {
    exact: true,
  });
  await expect(field).toHaveValue(personality);
  await field.fill("Tu réponds en trois phrases au plus.");
  await edit.getByRole("button", { name: "Enregistrer" }).click();
  await expect(edit).toHaveCount(0);
  await expect(created).toBeFocused();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Personnages", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `Discuter avec ${name}` }),
  ).toContainText("Tu réponds en trois phrases au plus.");
  await page.getByRole("button", { name: `Discuter avec ${name}` }).click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveAttribute("placeholder", `Écrire à ${name}…`);
});

test("une création au résultat inconnu se réessaie sans créer de doublon", async ({
  page,
}) => {
  const name = `Romarin ${test.info().repeatEachIndex}${Date.now() % 1000}`;
  const creates = commands(page, "bot.create");
  let lost = false;
  await page.route("**/api/commands", async (route) => {
    if (!lost && route.request().postDataJSON()?.type === "bot.create") {
      lost = true;
      await route.fetch();
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Nouveau personnage" })
    .click();
  const sheet = page.getByRole("dialog", { name: "Nouveau personnage" });
  await sheet.getByLabel("Nom", { exact: true }).fill(name);
  await sheet.getByRole("button", { name: "Créer et discuter" }).click();
  await expect(
    sheet.getByRole("button", { name: "Réessayer la même action" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Nouveau personnage" })
    .click();
  await expect(sheet.getByLabel("Nom", { exact: true })).toHaveValue(name);
  await sheet.getByRole("button", { name: "Réessayer la même action" }).click();
  await expect(
    page.getByRole("heading", { name: `Salut, moi c’est ${name}.` }),
  ).toBeVisible();
  expect(creates).toHaveLength(2);
  expect(creates[1].requestId).toBe(creates[0].requestId);
  const view = await (await page.request.get("/api/view")).json();
  expect(
    view.bots.filter((b: { name: string }) => b.name === name),
  ).toHaveLength(1);
});

test("le modèle choisi dans la feuille du personnage reste enregistré", async ({
  page,
}) => {
  const base = `http://127.0.0.1:${process.env.MINO_QA_TOOLS_PORT ?? "4398"}`;
  const configures = commands(page, "bot.configure");
  await page.goto(`${base}/`);
  await page
    .locator(".threads")
    .getByRole("button", { name: /^Pixel/ })
    .click();
  const sheet = await editSheet(page, "Pixel");
  const trigger = sheet.getByRole("button", { name: /^Modèle de Pixel :/ });
  await trigger.click();
  const picker = page.getByRole("dialog", { name: "Modèle de Pixel" });
  await expect(
    picker.getByRole("combobox", { name: "Chercher un modèle" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(configures).toHaveLength(0);

  await trigger.click();
  await picker.getByRole("option", { name: /Fake Sol/ }).click();
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(configures.at(-1)).toMatchObject({
    botId: "pixel",
    model: "fake-sol",
    effort: null,
    speed: "standard",
  });

  const high = sheet
    .getByRole("group", { name: "Réflexion" })
    .getByRole("radio", { name: "high (Poussée)", exact: true });
  await sheet.locator('label:has(input[value="high"])').click();
  await expect(high).toBeChecked();
  expect(configures.at(-1)).toMatchObject({
    model: "fake-sol",
    effort: "high",
  });

  await expect(sheet).toBeVisible();
  await page.reload();
  await editSheet(page, "Pixel");
  await expect(trigger).toContainText("Fake Sol");
  const view = await (await page.request.get(`${base}/api/view`)).json();
  expect(
    view.bots.find((b: { id: string }) => b.id === "pixel").choice,
  ).toEqual({
    model: "fake-sol",
    effort: "high",
    speed: "standard",
  });
});

test("un changement de personnage ne rejoue pas la configuration précédente", async ({
  page,
}) => {
  const base = `http://127.0.0.1:${process.env.MINO_QA_TOOLS_PORT ?? "4398"}`;
  await page.goto(`${base}/`);
  await page.evaluate(async () => {
    const csrf =
      document.querySelector<HTMLMetaElement>('meta[name="mino-csrf"]')
        ?.content ?? "";
    for (const botId of ["pixel", "mino"]) {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-mino-csrf": csrf },
        body: JSON.stringify({
          type: "bot.configure",
          requestId: crypto.randomUUID(),
          botId,
          model: null,
          effort: null,
          speed: "standard",
        }),
      });
      if (!response.ok) throw Error("Réinitialisation du modèle impossible");
    }
  });
  const configures = commands(page, "bot.configure");
  let lost = false;
  await page.route("**/api/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (
      !lost &&
      command.type === "bot.configure" &&
      command.botId === "pixel"
    ) {
      lost = true;
      await route.fetch();
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  await page.goto(`${base}/`);
  await page
    .locator(".threads")
    .getByRole("button", { name: /^Pixel/ })
    .click();
  const pixel = await editSheet(page, "Pixel");
  await pixel.getByRole("button", { name: /^Modèle de Pixel :/ }).click();
  await page
    .getByRole("dialog", { name: "Modèle de Pixel" })
    .getByRole("option", { name: /Fake Sol/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Réessayer la même action" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(pixel).toHaveCount(0);
  await page.locator(".threads").getByRole("button", { name: /^Mino/ }).click();
  const mino = await editSheet(page, "Mino");
  await mino.getByRole("button", { name: /^Modèle de Mino :/ }).click();
  await page
    .getByRole("dialog", { name: "Modèle de Mino" })
    .getByRole("option", { name: /Fake Sol/ })
    .click();
  await expect.poll(() => configures.length).toBe(2);
  expect(configures.map((command) => command.botId)).toEqual(["pixel", "mino"]);
  expect(configures[1].requestId).not.toBe(configures[0].requestId);
});
