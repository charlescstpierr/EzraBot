import { mkdirSync } from "node:fs";
import { test, expect } from "@playwright/test";
import type { AppView } from "../server/src/protocol";

const TOOLS =
  process.env.MINO_CREATION_TOOLS_URL ??
  `http://127.0.0.1:${process.env.MINO_QA_TOOLS_PORT ?? "4398"}`;
const OFFLINE =
  process.env.MINO_CREATION_OFFLINE_URL ??
  `http://127.0.0.1:${process.env.MINO_QA_PORT ?? "4399"}`;

test("le modèle choisi avant création est envoyé une seule fois et reste après recharge", async ({
  page,
}) => {
  const sent: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/commands")) {
      const command = request.postDataJSON();
      if (command.type === "bot.create" || command.type === "bot.configure")
        sent.push(command);
    }
  });
  await page.goto(TOOLS);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Nouveau personnage" })
    .click();
  const sheet = page.getByRole("dialog", {
    name: "Nouveau personnage",
    exact: true,
  });
  await sheet.getByLabel("Nom", { exact: true }).fill("Sol choisi");
  await sheet
    .getByLabel("Personnalité et instructions")
    .fill("Une réponse courte.");
  const trigger = sheet.getByRole("button", {
    name: /^Modèle de ce personnage/,
  });
  await trigger.click();
  const picker = sheet.getByRole("dialog", {
    name: "Modèle de ce personnage",
    exact: true,
  });
  await picker.getByRole("combobox").fill("Fake Sol");
  await picker.getByRole("option", { name: /Fake Sol/ }).click();
  await expect(trigger).toContainText("Fake Sol");
  expect(sent).toEqual([]);
  mkdirSync("/tmp/creation-model-evidence", { recursive: true });
  await page.screenshot({
    path: "/tmp/creation-model-evidence/creation-picker.png",
  });
  await sheet.getByRole("button", { name: "Créer et discuter" }).click();
  await expect(sheet).toHaveCount(0);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "bot.create",
    model: "fake-sol",
    name: "Sol choisi",
    instructions: "Une réponse courte.",
  });
  await page.reload();
  const view: AppView = await (
    await page.request.get(TOOLS + "/api/view")
  ).json();
  expect(view.bots.filter((b) => b.name === "Sol choisi")).toHaveLength(1);
  expect(view.bots.find((b) => b.name === "Sol choisi")?.choice).toEqual({
    model: "fake-sol",
    effort: null,
    speed: "standard",
  });
  await page.locator("main > header .bot-title").click();
  await page.getByRole("menuitem", { name: "Modifier Sol choisi" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Modifier Sol choisi" })
      .getByRole("button", { name: /^Modèle de Sol choisi/ }),
  ).toContainText("Fake Sol");
});

test("le catalogue indisponible permet de créer avec le modèle par défaut", async ({
  page,
}) => {
  await page.goto(OFFLINE);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Nouveau personnage" })
    .click();
  const sheet = page.getByRole("dialog", {
    name: "Nouveau personnage",
    exact: true,
  });
  await sheet.getByLabel("Nom", { exact: true }).fill("Sans catalogue");
  await sheet.getByRole("button", { name: /^Modèle de ce personnage/ }).click();
  await sheet
    .getByRole("button", { name: "Modèle par défaut", exact: true })
    .click();
  await sheet.getByRole("button", { name: "Créer et discuter" }).click();
  await expect(sheet).toHaveCount(0);
  const view: AppView = await (
    await page.request.get(OFFLINE + "/api/view")
  ).json();
  expect(
    view.bots.find((b) => b.name === "Sans catalogue")?.choice.model,
  ).toBeNull();
});
