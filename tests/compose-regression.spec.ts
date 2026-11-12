import { test, expect } from "@playwright/test";

test("un envoi accepté acquitte aussi les espaces du brouillon soumis", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await input.fill("  Bonjour avec des espaces  ");
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/commands") &&
      r.request().postDataJSON().type === "message.say",
  );
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  expect((await response).ok()).toBeTruthy();
  await expect(input).toHaveValue("");
});

test("un nom dans du code ne crée pas une invitation", async ({ page }) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await input.fill("Explique ce code :\n```ts\n@Nova\n```");
  const request = page.waitForRequest(
    (r) =>
      r.url().endsWith("/api/commands") &&
      r.postDataJSON().type === "message.say",
  );
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  const submitted = (await request).postDataJSON();
  expect(submitted.mentions ?? []).toEqual([]);
});
