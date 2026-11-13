import { test, expect, type Page } from "@playwright/test";

test("les souvenirs concurrents restent distincts et la suppression purge les brouillons", async ({
  page,
  context,
}) => {
  const name = "Compagnon synthétique";
  const settings = async (p: Page) => {
    await p.getByRole("button", { name: "Personnages", exact: true }).click();
    await p.getByRole("button", { name: `Modifier ${name}` }).click();
    await p
      .getByRole("dialog")
      .getByRole("button", { name: "Mémoire et réglages" })
      .click();
  };
  await page.goto("/");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Nouveau personnage" })
    .click();
  const sheet = page.getByRole("dialog", { name: "Nouveau personnage" });
  await sheet.getByLabel("Nom", { exact: true }).fill(name);
  await sheet
    .getByLabel("Description courte", { exact: true })
    .fill("Données de recette");
  await sheet.getByRole("button", { name: "Changer l’apparence" }).click();
  await sheet.getByTitle("Radis").click();
  await sheet
    .getByLabel("Personnalité et instructions", { exact: true })
    .fill("Pose une question à la fois et aide-moi à jardiner.");
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/commands") &&
      response.request().postDataJSON().type === "bot.create",
  );
  await sheet.getByRole("button", { name: "Créer et discuter" }).click();
  expect((await saved).ok()).toBeTruthy();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
  await settings(page);
  await expect(page.locator(".ez-character blockquote")).toHaveText(
    "Pose une question à la fois et aide-moi à jardiner.",
  );
  await expect(
    page.getByLabel("Contexte relu", { exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Moteur de réponse" }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Discuter", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Brouillon privé synthétique à effacer");
  await settings(page);
  await page
    .getByLabel("Un souvenir à garder", { exact: true })
    .fill("Valeur initiale");
  await page
    .getByRole("button", { name: "Ajouter à sa mémoire", exact: true })
    .click();
  await expect(page.locator(".ez-character-memory")).toContainText(
    "Valeur initiale",
  );
  const other = await context.newPage();
  await other.goto("/");
  await settings(other);
  await page
    .getByRole("button", { name: "Modifier le souvenir", exact: true })
    .click();
  await other
    .getByRole("button", { name: "Modifier le souvenir", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Modifier le souvenir", exact: true })
    .fill("Première modification acceptée");
  await page
    .getByRole("button", { name: "Enregistrer ce souvenir", exact: true })
    .click();
  await expect(page.locator(".ez-character-memory")).toContainText(
    "Première modification acceptée",
  );
  await other
    .getByRole("textbox", { name: "Modifier le souvenir", exact: true })
    .fill("Deuxième modification non écrasante");
  await other
    .getByRole("button", { name: "Enregistrer ce souvenir", exact: true })
    .click();
  await expect(other.getByRole("alert")).toContainText("changé");
  await expect(
    other.getByRole("textbox", { name: "Modifier le souvenir", exact: true }),
  ).toHaveValue("Deuxième modification non écrasante");
  await page
    .getByRole("button", { name: "Examiner la suppression", exact: true })
    .click();
  await page
    .getByLabel(`Recopier le nom « ${name} »`, { exact: true })
    .fill(name);
  await other
    .getByRole("textbox", { name: "Un souvenir à garder", exact: true })
    .fill("Un second souvenir synthétique");
  await other
    .getByRole("button", { name: "Ajouter à sa mémoire", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Actualiser les décomptes", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: `Supprimer définitivement ${name}`,
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Actualiser les décomptes", exact: true })
    .click();
  await expect(
    page.getByLabel(`Recopier le nom « ${name} »`, { exact: true }),
  ).toHaveValue("");
  await page
    .getByLabel(`Recopier le nom « ${name} »`, { exact: true })
    .fill(name);
  await page
    .getByRole("button", {
      name: `Supprimer définitivement ${name}`,
      exact: true,
    })
    .click();
  await expect(
    page.locator(".threads").getByRole("button", { name: new RegExp(name) }),
  ).toHaveCount(0);
  await expect(
    other.locator(".threads").getByRole("button", { name: new RegExp(name) }),
  ).toHaveCount(0);
  expect(
    await other.evaluate(() =>
      Object.values(localStorage).some(
        (value) =>
          typeof value === "string" &&
          value.includes("Brouillon privé synthétique à effacer"),
      ),
    ),
  ).toBeFalsy();
  await other.close();
});
