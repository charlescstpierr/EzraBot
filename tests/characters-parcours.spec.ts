import { test, expect } from "@playwright/test";

test("les souvenirs concurrents restent distincts et la suppression purge les brouillons", async ({
  page,
  context,
}) => {
  const name = "Compagnon synthétique";
  await page.goto("/");
  await page.getByRole("button", { name: "Personnages", exact: true }).click();
  await page
    .getByRole("button", { name: "Nouveau personnage", exact: true })
    .click();
  await page.getByLabel("Son petit nom", { exact: true }).fill(name);
  await page.getByLabel("Son rôle", { exact: true }).fill("Données de recette");
  await page
    .getByRole("combobox", { name: "Sa forme", exact: true })
    .selectOption("radish");
  await page
    .getByRole("button", { name: "Créer le personnage", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Ouvrir son fil", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Ouvrir son fil", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Brouillon privé synthétique à effacer");
  await page.getByRole("button", { name: "Personnages", exact: true }).click();
  await page
    .locator(".character-tabs")
    .getByRole("button", { name, exact: true })
    .click();
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
  await other.getByRole("button", { name: "Personnages", exact: true }).click();
  await other
    .locator(".character-tabs")
    .getByRole("button", { name, exact: true })
    .click();
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
  await page
    .getByRole("button", {
      name: `Supprimer définitivement ${name}`,
      exact: true,
    })
    .click();
  await expect(
    page.locator(".character-tabs").getByRole("button", { name, exact: true }),
  ).toHaveCount(0);
  await expect(
    other.locator(".character-tabs").getByRole("button", { name, exact: true }),
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
