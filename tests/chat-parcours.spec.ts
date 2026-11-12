import { test, expect } from "@playwright/test";

test("le texte saisi pendant un envoi accepté reste un brouillon", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await input.fill("  Première demande  ");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/commands", async (route) => {
    await held;
    await route.fulfill({ response: await route.fetch() });
  });
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await input.fill("Texte ajouté pendant la réponse");
  release();
  await expect(
    page.getByRole("button", { name: "Envoyer le message" }),
  ).toBeEnabled();
  await expect(input).toHaveValue("Texte ajouté pendant la réponse");
  await page.reload();
  await expect(input).toHaveValue("Texte ajouté pendant la réponse");
});

test("la reprise après rechargement conserve la commande inconnue entière", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  const commands: unknown[] = [];
  await page.route("**/api/commands", async (route) => {
    commands.push(route.request().postDataJSON());
    await route.abort();
  });
  await input.fill("  Message à reprendre  ");
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await input.fill("Brouillon plus récent");
  await page.reload();
  await expect(input).toHaveValue("Brouillon plus récent");
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(input).toHaveValue("Brouillon plus récent");
});

test("une pièce textuelle est jointe puis retirée et un binaire est refusé", async ({
  page,
}) => {
  await page.goto("/");
  const files = page.getByLabel("Joindre des fichiers texte", { exact: true });
  await files.setInputFiles({
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Notes\nTexte local"),
  });
  await expect(
    page.getByRole("button", { name: "Retirer notes.md" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retirer notes.md" }).click();
  await expect(
    page.getByRole("button", { name: "Retirer notes.md" }),
  ).toHaveCount(0);
  await files.setInputFiles({
    name: "image.png",
    mimeType: "image/png",
    buffer: Buffer.from([0, 1, 2]),
  });
  await expect(page.getByRole("alert")).toContainText("fichier texte");
});

test("une invitation choisie au curseur garde son ID après insertion de texte", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await input.fill("  Bonjour @No");
  await input.press("End");
  await page
    .locator(".ez-chat-fan")
    .getByRole("button", { name: "Nova", exact: true })
    .click();
  await input.press("Home");
  await input.press("Control+Home");
  await input.pressSequentially("Préfixe ");
  const request = page.waitForRequest(
    (r) =>
      r.url().endsWith("/api/commands") &&
      r.postDataJSON().type === "message.say",
  );
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  const command = (await request).postDataJSON();
  expect(command.mentions).toHaveLength(1);
  expect(command.mentions[0].botId).toBe("nova");
  expect(
    command.text.slice(command.mentions[0].start, command.mentions[0].end),
  ).toBe("@Nova");
});
