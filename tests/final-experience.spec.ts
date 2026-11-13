import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("un personnage créé avec sa personnalité ouvre son fil et conserve son modèle", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:${process.env.MINO_QA_TOOLS_PORT ?? "4398"}/`,
  );
  const name = `Recette ${Date.now().toString(36)}`;
  const personality = "Tu es patient. Pose une seule question à la fois.";
  await page.getByRole("button", { name: "Personnages", exact: true }).click();
  await page
    .getByRole("button", { name: "Nouveau personnage", exact: true })
    .first()
    .click();
  await expect(
    page.getByLabel("Personnalité et instructions", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Nom", { exact: true }).fill(name);
  await page
    .getByLabel("Personnalité et instructions", { exact: true })
    .fill(personality);
  const profileWrites: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/commands"))
      return;
    const type: unknown = request.postDataJSON().type;
    if (type === "bot.create" || type === "bot.update")
      profileWrites.push(type);
  });
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/commands") &&
      response.request().postDataJSON().type === "bot.create",
  );
  await page
    .getByRole("button", { name: "Créer et discuter", exact: true })
    .click();
  expect((await created).ok()).toBe(true);
  await expect(
    page.getByRole("dialog", { name: "Nouveau personnage", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: `Salut, moi c’est ${name}.`,
      exact: true,
    }),
  ).toBeVisible();
  expect(profileWrites).toEqual(["bot.create"]);

  const model = page.getByRole("button", {
    name: new RegExp(`^Modèle de ${name} :`),
  });
  await model.click();
  const picker = page.getByRole("dialog", {
    name: `Modèle de ${name}`,
    exact: true,
  });
  await expect(picker.getByRole("option", { name: /Fake Sol/ })).toBeVisible();
  const configured = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/commands") &&
      response.request().postDataJSON().type === "bot.configure",
  );
  await picker.getByRole("option", { name: /Fake Sol/ }).click();
  const configuration = await configured;
  expect(configuration.ok()).toBe(true);
  expect(configuration.request().postDataJSON()).toMatchObject({
    model: "fake-sol",
  });
  await expect(picker).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Bonjour, préparons un jardin synthétique.");
  await page
    .getByRole("button", { name: "Envoyer le message", exact: true })
    .click();
  await expect(
    page
      .getByRole("article")
      .getByText("Bonjour, préparons un jardin synthétique.", {
        exact: true,
      }),
  ).toBeVisible();

  await page.reload();
  await expect(model).toContainText("Fake Sol");
  const view = await page.request.get("/api/view");
  expect(view.ok()).toBe(true);
  expect(await view.json()).toMatchObject({
    bots: expect.arrayContaining([
      expect.objectContaining({
        name,
        instructions: personality,
        choice: expect.objectContaining({ model: "fake-sol" }),
      }),
    ]),
  });
  await page.getByRole("button", { name, exact: true }).click();
  await page
    .getByRole("menuitem", { name: `Modifier ${name}`, exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: `Modifier ${name}`,
    exact: true,
  });
  await expect(
    editor.getByLabel("Personnalité et instructions", { exact: true }),
  ).toHaveValue(personality);
  const revised = `${personality} Utilise des exemples courts.`;
  await editor
    .getByLabel("Personnalité et instructions", { exact: true })
    .fill(revised);
  await editor
    .getByRole("button", { name: "Enregistrer", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name, exact: true }).click();
  await page
    .getByRole("menuitem", { name: `Modifier ${name}`, exact: true })
    .click();
  await expect(
    editor.getByLabel("Personnalité et instructions", { exact: true }),
  ).toHaveValue(revised);
});

test("le menu joint une photo et un dossier au message sans créer de document", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const add = page.getByRole("button", {
    name: "Ajouter des pièces jointes",
    exact: true,
  });
  const menu = page.getByRole("menu", { name: "Pièces jointes", exact: true });
  await expect(add).toBeVisible();
  await add.click();
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Photos",
    "Fichiers",
    "Dossier",
  ]);
  const close = page.getByRole("button", {
    name: "Fermer les pièces jointes",
    exact: true,
  });
  await expect(close).toHaveAttribute("aria-expanded", "true");
  await close.click();
  await expect(menu).toHaveCount(0);
  await expect(add).toHaveAttribute("aria-expanded", "false");
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas indisponible");
    context.fillRect(0, 0, 32, 32);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const photo = {
    name: "jardin.png",
    mimeType: "image/png",
    buffer: Buffer.from(base64, "base64"),
  };
  await add.click();
  const firstPhoto = page.waitForEvent("filechooser");
  await menu.getByRole("menuitem", { name: "Photos", exact: true }).click();
  await (await firstPhoto).setFiles(photo);
  await expect(
    page.getByRole("img", { name: "jardin.png", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retirer jardin.png", exact: true })
    .click();
  await expect(
    page.getByRole("img", { name: "jardin.png", exact: true }),
  ).toHaveCount(0);
  await add.click();
  const secondPhoto = page.waitForEvent("filechooser");
  await menu.getByRole("menuitem", { name: "Photos", exact: true }).click();
  await (await secondPhoto).setFiles(photo);
  await expect(
    page.getByRole("button", { name: "Retirer jardin.png", exact: true }),
  ).toBeVisible();
  await add.click();
  const file = page.waitForEvent("filechooser");
  await menu.getByRole("menuitem", { name: "Fichiers", exact: true }).click();
  await (
    await file
  ).setFiles({
    name: "liste.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Liste synthétique"),
  });
  await expect(
    page.getByRole("button", { name: "Retirer liste.txt", exact: true }),
  ).toBeVisible();

  const directory = testInfo.outputPath("dossier-recette");
  await mkdir(join(directory, "notes"), { recursive: true });
  await writeFile(
    join(directory, "notes", "semis.txt"),
    "Notes synthétiques de semis",
  );
  await add.click();
  const folder = page.waitForEvent("filechooser");
  await menu.getByRole("menuitem", { name: "Dossier", exact: true }).click();
  await (await folder).setFiles(directory);
  await expect(
    page.getByText("dossier-recette/notes/semis.txt", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Regarde ces notes synthétiques de jardin.");
  await page
    .getByRole("button", { name: "Envoyer le message", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /^Retirer / })).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: "jardin.png", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("dossier-recette/notes/semis.txt", { exact: false }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("article")
      .filter({ has: page.getByText("Document", { exact: true }) }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("img", { name: "jardin.png", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("dossier-recette/notes/semis.txt", { exact: false }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("article")
      .filter({ has: page.getByText("Document", { exact: true }) }),
  ).toHaveCount(0);
});
