import { mkdirSync } from "node:fs";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { PcView, ToolsReplyOf } from "../server/src/tools-protocol";

// Real isolated store, worker and HTTP server. The provider and the App Server are fakes started by scripts/test-server.mjs:
// every account, service and address on these pages is synthetic.

const TOOLS = "http://127.0.0.1:4398";
const EVIDENCE = ".audit/connexion-fil/evidence";
const HEADERS = { origin: TOOLS, "x-mino-csrf": "test-only-token" };
const PROVIDER = "connexion-synthetique.invalid";

const pcView = async (request: APIRequestContext): Promise<PcView> =>
  (await request.get(`${TOOLS}/api/view`)).json();

/** A new character without any right, so each test owns its thread. */
async function character(request: APIRequestContext, name: string) {
  const model = (await pcView(request)).bots[0];
  const response = await request.post(`${TOOLS}/api/commands`, {
    headers: HEADERS,
    data: {
      type: "bot.create",
      requestId: crypto.randomUUID(),
      name,
      title: "sans service relié",
      shape: model?.shape,
      color: model?.color,
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  const botId: string = (await response.json()).result.botId;
  return botId;
}

async function openThread(page: Page, name: string) {
  await page.goto(TOOLS);
  if ((page.viewportSize()?.width ?? 1100) < 600)
    await page
      .getByRole("button", { name: "Ouvrir le menu", exact: true })
      .click();
  await page
    .locator(".threads")
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
}

async function say(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Envoyer le message" }).click();
}

const card = (page: Page, service: string) =>
  page.getByRole("region", { name: `Connexion proposée ${service}` });

/** Every call a page makes to the provider-backed routes, to prove a card calls nothing by itself. */
function providerCalls(page: Page) {
  const calls: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/tools/") && path !== "/api/tools/commands")
      calls.push(`${request.method()} ${path}`);
  });
  return calls;
}

const simulatedProvider = (page: Page) =>
  page.context().route(`https://${PROVIDER}/**`, (route) =>
    route.fulfill({
      body: "<p>Fournisseur simulé. Revenez dans EzraBot.</p>",
      contentType: "text/html",
    }),
  );

/** The fake provider reads the outcome in the account name: « attente » waits, « refus » fails. */
const nameAccount = (page: Page, alias: () => string) =>
  page.route("**/api/tools/connections/*/link", (route) =>
    route.continue({
      postData: JSON.stringify({
        ...route.request().postDataJSON(),
        alias: alias(),
      }),
    }),
  );

test.beforeAll(() => mkdirSync(EVIDENCE, { recursive: true }));

test("un personnage sans droit propose une carte ; la personne connecte, l’état vient du fournisseur et aucun droit n’est donné", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1100, height: 950 });
  const botId = await character(request, "Lien A");
  const calls = providerCalls(page);
  await simulatedProvider(page);
  await openThread(page, "Lien A");
  await page.screenshot({ path: `${EVIDENCE}/fil-avant-demande-1100.png` });

  await say(page, "Publie un message sur Slack");
  const slack = card(page, "slack");
  await expect(slack).toBeVisible();
  await expect(slack).toHaveAttribute("data-state", "proposed");
  await expect(slack).toContainText(
    "Aucune connexion n’a encore été lancée depuis cette carte.",
  );
  await expect(slack).toContainText(
    "Relier un compte ne donne aucun droit à Lien A.",
  );
  await expect(slack).not.toContainText("déjà connecté");
  expect(calls, "the proposal alone calls no provider route").toEqual([]);
  expect((await pcView(request)).tools.accounts).not.toContainEqual(
    expect.objectContaining({ toolkit: "slack" }),
  );
  await page.screenshot({ path: `${EVIDENCE}/carte-proposee-1100.png` });

  const opened = page.waitForEvent("popup");
  await slack
    .getByRole("button", { name: "Connecter slack" })
    .click({ clickCount: 2 });
  const popup = await opened;
  await expect(popup).toHaveURL(new RegExp(PROVIDER));
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await expect(slack).toContainText(
    "Terminez la connexion chez le fournisseur.",
  );
  await page.screenshot({ path: `${EVIDENCE}/carte-attente-1100.png` });
  await popup.close();
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(slack).toHaveAttribute("data-state", "active");
  await expect(slack).toContainText(
    /Compte « slack » connecté\. Dernier contrôle chez le fournisseur : .+\./,
  );
  expect(
    calls.filter((call) => call.includes("/connections/")),
    "one start for a double click",
  ).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    ),
  ).not.toContain(PROVIDER);
  const view = await pcView(request);
  expect(view.tools.grants[botId]).toBeUndefined();
  expect(JSON.stringify(view)).not.toContain(PROVIDER);
  await expect(slack).toContainText(
    "Relier un compte ne donne aucun droit à Lien A.",
  );
  await page.screenshot({ path: `${EVIDENCE}/carte-connectee-1100.png` });

  await page.reload();
  await expect(card(page, "slack")).toHaveAttribute("data-state", "active");
  await card(page, "slack")
    .getByRole("button", { name: "Voir les droits de Lien A" })
    .click();
  await expect(
    page.getByText("Lien A n’a aucun droit pour le moment."),
  ).toBeVisible();
  await page.screenshot({ path: `${EVIDENCE}/droits-vides-1100.png` });
});

test("fenêtre bloquée sur petit écran : l’attente survit au rechargement, la vérification reprend au clic, un échec se relance", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await character(request, "Lien B");
  let alias = "Compte attente du fil";
  await nameAccount(page, () => alias);
  const calls = providerCalls(page);
  await openThread(page, "Lien B");
  await say(page, "Lis mes derniers courriels Gmail");
  const gmail = card(page, "gmail");
  await expect(gmail).toBeVisible();

  await gmail.getByRole("button", { name: "Connecter gmail" }).click();
  const fallback = gmail.getByRole("link", {
    name: "Ouvrir la page de connexion",
  });
  await expect(fallback).toHaveAttribute("href", new RegExp(PROVIDER));
  await expect(fallback).toHaveAttribute("rel", "noopener noreferrer");
  await expect(gmail).toHaveAttribute("data-state", "waiting");
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    "the card fits a phone-sized screen",
  ).toBe(true);
  await page.screenshot({
    path: `${EVIDENCE}/carte-attente-390.png`,
    fullPage: true,
  });
  await gmail.getByRole("button", { name: "Arrêter la vérification" }).click();
  await expect(gmail).toHaveAttribute("data-state", "pending");

  await page.reload();
  const reloaded = card(page, "gmail");
  await expect(reloaded).toHaveAttribute("data-state", "pending");
  await expect(reloaded).toContainText(
    "Connexion en attente de votre autorisation chez le fournisseur.",
  );
  await expect(
    reloaded.getByRole("link", { name: "Ouvrir la page de connexion" }),
  ).toHaveCount(0);
  const beforeResume = calls.length;
  await page.waitForTimeout(1_500);
  expect(
    calls.slice(beforeResume),
    "a reload checks nothing by itself",
  ).toEqual([]);
  await page.screenshot({
    path: `${EVIDENCE}/carte-reprise-390.png`,
    fullPage: true,
  });

  await reloaded.getByRole("button", { name: "Vérifier la connexion" }).click();
  await reloaded.getByRole("button", { name: "Vérifier maintenant" }).click();
  await expect
    .poll(() => calls.filter((call) => call.endsWith("/check")).length)
    .toBeGreaterThan(0);
  await expect(reloaded).toHaveAttribute("data-state", "waiting");
  await reloaded
    .getByRole("button", { name: "Arrêter la vérification" })
    .click();
  await expect(reloaded).toHaveAttribute("data-state", "pending");

  alias = "Compte refus du fil";
  await reloaded.getByRole("button", { name: "Relancer la connexion" }).click();
  await reloaded.getByRole("button", { name: "Vérifier maintenant" }).click();
  await expect(reloaded).toHaveAttribute("data-state", "failed");
  await expect(reloaded).toContainText(
    "La connexion n’a pas abouti. Aucun compte n’a été relié.",
  );
  await expect(
    reloaded.getByRole("button", { name: "Relancer la connexion" }),
  ).toBeEnabled();
  await expect(
    reloaded.getByRole("link", { name: "Ouvrir la page de connexion" }),
  ).toHaveCount(0);
  await expect(reloaded.getByRole("alert")).toHaveCount(0);
  await page.screenshot({
    path: `${EVIDENCE}/carte-echec-390.png`,
    fullPage: true,
  });
});

test("service hors catalogue, compte déjà connecté, puis droit donné : la carte dit chaque fois l’état exact", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1100, height: 950 });
  const botId = await character(request, "Lien C");
  await simulatedProvider(page);
  await openThread(page, "Lien C");

  await say(page, "Regarde mon agenda de demain");
  const agenda = card(page, "agenda");
  await expect(agenda).toBeVisible();
  await agenda.getByRole("button", { name: "Connecter agenda" }).click();
  await expect(agenda.getByRole("alert")).toContainText(
    "Ce serveur ne propose pas le service « agenda » à la connexion. Rien n’a été relié.",
  );
  await expect(agenda).toHaveAttribute("data-state", "proposed");
  await expect(
    agenda.getByRole("button", { name: "Connecter agenda" }),
  ).toBeEnabled();
  await page.screenshot({ path: `${EVIDENCE}/carte-hors-catalogue-1100.png` });

  const link: ToolsReplyOf<"link"> = await (
    await request.post(`${TOOLS}/api/tools/link`, {
      headers: HEADERS,
      data: { serviceId: "ac_synthetique_gmail", alias: "Courriel de Lien C" },
    })
  ).json();
  await request.post(`${TOOLS}/api/tools/links/${link.linkId}/check`, {
    headers: HEADERS,
    data: {},
  });
  await say(page, "Lis mes derniers courriels Gmail");
  const gmail = card(page, "gmail");
  await expect(gmail).toContainText(
    /Un compte gmail est déjà connecté sur ce PC \(« .+ »\)\. Vous pouvez choisir les droits de Lien C sans relier un autre compte\./,
  );
  await expect(gmail).toContainText(
    "Relier un compte ne donne aucun droit à Lien C.",
  );
  await page.screenshot({ path: `${EVIDENCE}/carte-compte-existant-1100.png` });

  const account = (await pcView(request)).tools.accounts.find(
    (candidate) => candidate.alias === "Courriel de Lien C",
  );
  const granted = await request.post(`${TOOLS}/api/tools/commands`, {
    headers: HEADERS,
    data: {
      type: "tools.grant",
      requestId: crypto.randomUUID(),
      botId,
      accountId: account?.id,
      toolSlugs: ["GMAIL_SEND_EMAIL"],
    },
  });
  expect(granted.status()).toBe(200);
  await expect(gmail).toContainText(
    "Lien C a déjà des droits sur gmail : GMAIL_SEND_EMAIL. Chaque action attend votre confirmation.",
  );
  await expect(gmail).toHaveAttribute("data-state", "proposed");
  await page.screenshot({ path: `${EVIDENCE}/carte-droits-donnes-1100.png` });
});
