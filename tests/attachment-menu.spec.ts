import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("le bouton unique ouvre un menu utilisable au clavier et restaure le focus", async ({
  page,
}) => {
  await page.goto("/");
  const trigger = page.getByRole("button", {
    name: "Ajouter des pièces jointes",
  });
  await expect(trigger).toBeVisible();
  await expect(
    page.locator('.ez-chat-composer input[type="file"]'),
  ).toHaveCount(3);
  await expect(page.locator('input[type="file"]:visible')).toHaveCount(0);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Fermer les pièces jointes" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("menuitem", { name: "Photos", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(
    page.getByRole("menuitem", { name: "Inviter un personnage", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Fichiers", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(message).toBeFocused();
  await trigger.click();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("Photos et Fichiers ouvrent leurs sélecteurs et conservent les pièces après recharge", async ({
  page,
}) => {
  await page.goto("/");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  for (const option of ["Photos", "Fichiers"]) {
    await page
      .getByRole("button", { name: "Ajouter des pièces jointes" })
      .click();
    const chosen = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: option, exact: true }).click();
    const chooser = await chosen;
    expect(chooser.isMultiple()).toBe(true);
    expect(await chooser.element().getAttribute("accept")).toMatch(
      option === "Photos" ? "image/png,image/jpeg,image/webp" : /text\/\*/,
    );
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Ajouter des pièces jointes" }),
    ).toBeFocused();
    await chooser.setFiles(
      option === "Photos"
        ? {
            name: "menu.png",
            mimeType: "image/png",
            buffer: Buffer.from(png, "base64"),
          }
        : {
            name: "menu.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Texte synthétique"),
          },
    );
    await expect(
      page.getByRole("button", {
        name: `Retirer menu.${option === "Photos" ? "png" : "txt"}`,
      }),
    ).toBeVisible();
  }
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Retirer menu.png" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retirer menu.txt" }),
  ).toBeVisible();
  await expect(page.locator("img.ez-attachment-preview")).toBeVisible();
  await page.getByRole("button", { name: "Retirer menu.png" }).click();
  await expect(page.locator("img.ez-attachment-preview")).toHaveCount(0);
});

test("Dossier ouvre un vrai sélecteur de dossier et garde le chemin relatif", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "attachment-menu-"));
  try {
    const folder = join(directory, "exemple");
    await mkdir(folder);
    await writeFile(join(folder, "notes.txt"), "Notes synthétiques");
    await page.goto("/");
    await page
      .getByRole("button", { name: "Ajouter des pièces jointes" })
      .click();
    const chosen = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Dossier", exact: true }).click();
    const chooser = await chosen;
    expect(await chooser.element().getAttribute("webkitdirectory")).toBe("");
    await chooser.setFiles(folder);
    await expect(
      page.getByText("exemple/notes.txt", { exact: false }),
    ).toBeVisible();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("le menu reste dans la fenêtre mobile et au-dessus du champ", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Ajouter des pièces jointes" })
    .click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  const composer = await page.locator(".ez-chat-composer").boundingBox();
  expect(bounds).not.toBeNull();
  expect(composer).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(composer!.y);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
});

test("le bouton attend la fin de lecture puis accepte de nouveau des fichiers", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Ajouter des pièces jointes" })
    .waitFor();
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      return new Promise<ArrayBuffer>((resolve) => {
        Reflect.set(window, "finishAttachmentRead", async () =>
          resolve(await read.call(this)),
        );
      });
    };
  });
  await page.getByLabel("Joindre photos et fichiers").setInputFiles({
    name: "lecture.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Lecture différée"),
  });
  await expect(
    page.getByRole("button", { name: "Ajouter des pièces jointes" }),
  ).toBeDisabled();
  await page.evaluate(() => Reflect.get(window, "finishAttachmentRead")());
  await expect(
    page.getByRole("button", { name: "Retirer lecture.txt" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ajouter des pièces jointes" }),
  ).toBeEnabled();
});
