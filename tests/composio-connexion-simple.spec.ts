import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const BASE = "http://127.0.0.1:4398";
const EVIDENCE = ".audit/composio-ux/evidence";
const connections = (page: Page) =>
  page.getByRole("dialog").getByRole("region", { name: "Services connectés" });
async function open(page: Page) {
  await page.goto(BASE);
  if ((page.viewportSize()?.width ?? 1100) < 600)
    await page
      .getByRole("button", { name: "Ouvrir le menu", exact: true })
      .click();
  await page.getByRole("button", { name: /^Préférences/ }).click();
  await expect(connections(page).getByLabel("Service à relier")).toBeVisible();
}
async function named(page: Page, alias: string) {
  await connections(page)
    .getByText("Nom du compte (facultatif)", { exact: true })
    .click();
  await connections(page).getByLabel("Nom de ce compte").fill(alias);
}

test("choix puis Connecter sans nom, fenêtre avant réponse, double clic et retour vérifié", async ({
  page,
  context,
}) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await page.setViewportSize({ width: 1100, height: 950 });
  let links = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tools/link", async (route) => {
    links++;
    expect(route.request().postDataJSON().alias).toMatch(/^Courriel/);
    await gate;
    await route.continue();
  });
  await context.route("https://connexion-synthetique.invalid/**", (route) =>
    route.fulfill({
      body: "<p>Fournisseur simulé. Revenez dans EzraBot.</p>",
      contentType: "text/html",
    }),
  );
  await open(page);
  await page.screenshot({
    path: `${EVIDENCE}/connexion-1100.png`,
    fullPage: true,
  });
  const opened = page.waitForEvent("popup");
  await connections(page)
    .getByRole("button", { name: "Connecter", exact: true })
    .click({ clickCount: 2 });
  const popup = await opened;
  expect(popup.url()).toBe("about:blank");
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await expect.poll(() => links).toBe(1);
  release?.();
  await expect(popup).toHaveURL(/connexion-synthetique/);
  await popup.close();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(connections(page)).toContainText("Compte connecté.");
  expect(links).toBe(1);
  expect(
    await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    ),
  ).not.toContain("connexion-synthetique");
  await page.screenshot({
    path: `${EVIDENCE}/connecte-1100.png`,
    fullPage: true,
  });
});

test("fenêtre bloquée, attente durable, arrêt au démontage et reprise après rechargement", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    window.open = () => null;
  });
  let checks = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/check")) checks++;
  });
  await open(page);
  await connections(page)
    .getByLabel("Service à relier")
    .scrollIntoViewIfNeeded();
  await expect(
    connections(page).getByRole("button", { name: "Connecter", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: `${EVIDENCE}/connexion-390.png`,
    fullPage: true,
  });
  await named(page, "Compte attente mobile");
  await connections(page)
    .getByRole("button", { name: "Connecter", exact: true })
    .click();
  await expect(
    connections(page).getByRole("link", {
      name: "Ouvrir la page de connexion",
    }),
  ).toHaveAttribute("href", /^https:/);
  await expect.poll(() => checks).toBeGreaterThan(0);
  await expect(
    connections(page)
      .getByRole("listitem")
      .filter({ hasText: "Compte attente mobile" }),
  ).toBeVisible();
  await connections(page)
    .getByRole("link", { name: "Ouvrir la page de connexion" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${EVIDENCE}/attente-390.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Fermer", exact: true })
    .click();
  const stopped = checks;
  await page.waitForTimeout(3300);
  expect(checks).toBe(stopped);
  await page.reload();
  if ((page.viewportSize()?.width ?? 1100) < 600)
    await page
      .getByRole("button", { name: "Ouvrir le menu", exact: true })
      .click();
  await page.getByRole("button", { name: /^Préférences/ }).click();
  await expect.poll(() => checks).toBeGreaterThan(stopped);
  await expect(
    connections(page).getByRole("link", {
      name: "Ouvrir la page de connexion",
    }),
  ).toHaveCount(0);
  await connections(page)
    .getByRole("button", { name: "Arrêter la vérification" })
    .click();
  const paused = checks;
  await page.waitForTimeout(3300);
  expect(checks).toBe(paused);
});

test("erreur de catalogue et erreur de contrôle récupérables sans recréer de lien", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  let catalogError = true;
  await page.route("**/api/tools/catalog", (route) =>
    catalogError
      ? route.fulfill({
          json: { ok: false, message: "Catalogue indisponible" },
          status: 503,
        })
      : route.continue(),
  );
  await page.goto(BASE);
  if ((page.viewportSize()?.width ?? 1100) < 600)
    await page
      .getByRole("button", { name: "Ouvrir le menu", exact: true })
      .click();
  await page.getByRole("button", { name: /^Préférences/ }).click();
  await expect(connections(page)).toContainText("Catalogue indisponible");
  catalogError = false;
  await connections(page)
    .getByRole("button", { name: "Recharger les services" })
    .click();
  await expect(connections(page).getByLabel("Service à relier")).toBeVisible();
  const stop = connections(page).getByRole("button", {
    name: "Arrêter la vérification",
  });
  if (await stop.isVisible()) await stop.click();
  let links = 0;
  let fail = true;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/tools/link")) links++;
  });
  await page.route("**/api/tools/links/*/check", (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: { ok: false, message: "Contrôle indisponible" },
        })
      : route.continue(),
  );
  await connections(page)
    .getByRole("button", { name: "Connecter", exact: true })
    .click();
  await expect(connections(page)).toContainText("Contrôle indisponible");
  await expect(
    connections(page).getByRole("link", {
      name: "Ouvrir la page de connexion",
    }),
  ).toHaveAttribute("href", /^https:/);
  fail = false;
  await connections(page)
    .getByRole("button", { name: "Réessayer la vérification" })
    .click();
  await expect(connections(page)).toContainText("Compte connecté.");
  expect(links).toBe(1);
});

test("attente bornée et contrôle unique malgré plusieurs retours au focus", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await open(page);
  const stop = connections(page).getByRole("button", {
    name: "Arrêter la vérification",
  });
  if (await stop.isVisible()) await stop.click();
  await named(page, "Compte attente délai");
  await page.clock.install();
  let checks = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tools/links/*/check", async (route) => {
    checks++;
    await gate;
    await route.continue();
  });
  await connections(page)
    .getByRole("button", { name: "Connecter", exact: true })
    .click();
  await expect(connections(page)).toContainText("Terminez la connexion");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => checks).toBe(1);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(checks).toBe(1);
  release?.();
  await page.clock.fastForward(121_000);
  await expect(connections(page)).toContainText(
    "La connexion attend encore votre autorisation",
  );
  const ended = checks;
  await page.clock.fastForward(10_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(checks).toBe(ended);
  await connections(page)
    .getByRole("button", { name: "Réessayer la vérification" })
    .click();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => checks).toBeGreaterThan(ended);
});

test("échec de création ferme la fenêtre vide et ne recrée rien automatiquement", async ({
  page,
}) => {
  await open(page);
  const stop = connections(page).getByRole("button", {
    name: "Arrêter la vérification",
  });
  if (await stop.isVisible()) await stop.click();
  let links = 0;
  await page.route("**/api/tools/link", async (route) => {
    links++;
    await route.fulfill({
      status: 503,
      json: { ok: false, message: "Connexion indisponible" },
    });
  });
  const opened = page.waitForEvent("popup");
  await connections(page)
    .getByRole("button", { name: "Connecter", exact: true })
    .click();
  const popup = await opened;
  await expect(connections(page)).toContainText("Connexion indisponible");
  await expect.poll(() => popup.isClosed()).toBe(true);
  await page.waitForTimeout(3200);
  expect(links).toBe(1);
  await expect(
    connections(page).getByRole("button", { name: "Connecter", exact: true }),
  ).toBeEnabled();
});

test("fermer pendant un contrôle annule la requête et ignore sa réponse tardive", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await open(page);
  const stop = connections(page).getByRole("button", {
    name: "Arrêter la vérification",
  });
  if (await stop.isVisible()) await stop.click();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received = false;
  await page.route("**/api/tools/links/*/check", async (route) => {
    const reply = await route.fetch();
    received = true;
    await gate;
    await route.fulfill({ response: reply }).catch(() => {});
  });
  await connections(page)
    .getByRole("button", { name: "Connecter", exact: true })
    .click();
  await expect.poll(() => received).toBe(true);
  const aborted = page.waitForEvent("requestfailed", (request) =>
    request.url().endsWith("/check"),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Fermer", exact: true })
    .click();
  expect((await aborted).failure()?.errorText).toContain("ERR_ABORTED");
  release?.();
  await page.getByRole("button", { name: /^Préférences/ }).click();
  await expect(
    connections(page).getByRole("button", { name: "Connecter", exact: true }),
  ).toBeVisible();
  await expect(connections(page)).not.toContainText("Compte connecté.");
});
