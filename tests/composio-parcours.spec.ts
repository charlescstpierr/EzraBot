import { mkdirSync } from "node:fs";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { Command } from "../server/src/protocol";
import type { PcView, ToolsReplyOf } from "../server/src/tools-protocol";

// Real isolated store, worker and HTTP server. The provider and the App Server are fakes started by scripts/test-server.mjs:
// every account, action, address and result on these pages is synthetic.

const TOOLS = "http://127.0.0.1:4398";
const EVIDENCE = ".audit/composio-ux/evidence";
const HEADERS = { origin: TOOLS, "x-mino-csrf": "test-only-token" };

async function pcView(request: APIRequestContext): Promise<PcView> {
  return (await request.get(`${TOOLS}/api/view`)).json();
}

/** Connects a synthetic account and grants one action through the real PC routes, for tests that start after the setup. */
async function grantByRoutes(request: APIRequestContext, botId: string) {
  const link: ToolsReplyOf<"link"> = await (
    await request.post(`${TOOLS}/api/tools/link`, {
      headers: HEADERS,
      data: { serviceId: "ac_synthetique_gmail", alias: `Compte de ${botId}` },
    })
  ).json();
  await request.post(`${TOOLS}/api/tools/links/${link.linkId}/check`, {
    headers: HEADERS,
    data: {},
  });
  const account = (await pcView(request)).tools.accounts.find(
    (candidate) => candidate.alias === `Compte de ${botId}`,
  );
  expect(account?.status).toBe("ACTIVE");
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
}

async function openThread(page: Page, name: string) {
  await page.goto(TOOLS);
  await page
    .locator(".threads")
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
}

async function sendMessage(page: Page, text: string): Promise<Command> {
  const sent = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/commands") && request.method() === "POST",
  );
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  return (await sent).postDataJSON();
}

const card = (page: Page) =>
  page.getByRole("region", { name: "Action proposée GMAIL_SEND_EMAIL" });

test.beforeAll(() => mkdirSync(EVIDENCE, { recursive: true }));

test("parcours complet : relier un compte, donner un droit, proposer, approuver l’action exacte et lire le compte rendu", async ({
  page,
  request,
}) => {
  await page.goto(TOOLS);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
  expect((await pcView(request)).tools.grants).toEqual({});

  await page.getByRole("button", { name: /^Préférences/ }).click();
  const preferences = page.getByRole("dialog");
  const connections = preferences.getByRole("region", {
    name: "Services connectés",
  });
  await expect(
    connections.getByRole("button", { name: "Connecter", exact: true }),
  ).toBeEnabled();
  const service = connections.getByLabel("Service à relier");
  await expect(service.locator("option")).toHaveText([
    "Courriel (synthétique)",
    "Messagerie d’équipe (synthétique)",
    "Notes par clé (synthétique) (indisponible)",
  ]);
  await connections
    .getByText("Services indisponibles", { exact: true })
    .click();
  await expect(connections).toContainText("Seul OAuth 2 est pris en charge");
  await service.selectOption({ label: "Courriel (synthétique)" });
  await connections
    .getByText("Nom du compte (facultatif)", { exact: true })
    .click();
  await connections.getByLabel("Nom de ce compte").fill("Courriel de recette");
  await page
    .context()
    .route("https://connexion-synthetique.invalid/**", (route) =>
      route.fulfill({ body: "Fournisseur simulé", contentType: "text/plain" }),
    );
  const opened = page.waitForEvent("popup");
  await connections
    .getByRole("button", { name: "Connecter", exact: true })
    .click();
  const popup = await opened;
  await expect
    .poll(() => popup.url())
    .toMatch(/^https:\/\/connexion-synthetique\.invalid\/lien\//);
  await popup.close();
  await page.bringToFront();
  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
  );
  expect(stored).not.toContain("connexion-synthetique");
  expect(JSON.stringify(await pcView(request))).not.toContain(
    "connexion-synthetique",
  );
  await expect(connections).toContainText("Compte connecté.");
  await expect(
    connections
      .getByRole("listitem")
      .filter({ hasText: "Courriel de recette" }),
  ).toContainText("Connecté");
  await page.screenshot({
    path: `${EVIDENCE}/apres-composio-preferences.png`,
    fullPage: true,
  });
  await preferences.getByRole("button", { name: "Fermer" }).click();

  await page.getByRole("button", { name: "Personnages", exact: true }).click();
  await page.getByRole("button", { name: "Modifier Nova" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Mémoire et réglages" })
    .click();
  const rights = page.getByRole("region", { name: "Services connectés" });
  await expect(rights).toContainText("Nova n’a aucun droit pour le moment.");
  await rights
    .getByLabel("Compte à utiliser")
    .selectOption({ label: "Courriel de recette · gmail" });
  await rights
    .getByRole("button", { name: "Voir les outils de ce compte" })
    .click();
  await expect(rights.getByRole("checkbox")).toHaveCount(3);
  await expect(
    rights.getByRole("checkbox", { name: /GMAIL_LIST_LABELS/ }),
  ).toBeDisabled();
  await expect(rights).toContainText(
    "Le fournisseur n’annonce pas de version pour cet outil",
  );
  await expect(rights).not.toContainText("COMPOSIO_MULTI_EXECUTE_TOOL");
  await rights.getByRole("checkbox", { name: /GMAIL_SEND_EMAIL/ }).check();
  await rights
    .getByRole("button", { name: "Enregistrer les droits de Nova" })
    .click();
  await expect(rights.getByRole("listitem")).toContainText([
    "GMAIL_SEND_EMAIL",
  ]);
  await expect(rights.getByRole("listitem").first()).toContainText(
    "gmail · Courriel de recette",
  );
  await page.screenshot({
    path: `${EVIDENCE}/apres-composio-droits.png`,
    fullPage: true,
  });

  await page.getByRole("button", { name: "Discuter", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: /Utiliser les services connectés/ }),
  ).toBeChecked();
  const command = await sendMessage(page, "Envoie le bilan du mois à l’équipe");
  expect(command.type).toBe("message.send");
  expect(command).not.toHaveProperty("document");

  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText("gmail");
  await expect(card(page)).toContainText("Courriel de recette");
  await expect(card(page)).toContainText(
    "GMAIL_SEND_EMAIL · version 20260101_00",
  );
  await expect(card(page)).toContainText(
    '"subject": "Envoie le bilan du mois à l’équipe"',
  );
  await expect(card(page)).toContainText('"to": "personne@exemple.invalid"');
  await expect(card(page)).toContainText("En attente de votre décision");
  const before = (await pcView(request)).tools.proposals.at(-1);
  expect(before?.execution).toBeNull();
  await page.screenshot({
    path: `${EVIDENCE}/apres-composio-carte.png`,
    fullPage: true,
  });

  await card(page)
    .getByRole("button", { name: "Approuver cette action exacte" })
    .click();
  await expect(card(page)).toContainText("Le service confirme l’exécution.");
  await expect(card(page)).toContainText(
    "Journal du service : log_synthetique_1",
  );
  await expect(
    card(page).getByRole("button", { name: "Approuver cette action exacte" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("main")
      .getByText("Compte rendu : l’action est dans l’état completed."),
  ).toBeVisible();
  const after = await pcView(request);
  const done = after.tools.proposals.find(
    (proposal) => proposal.id === before?.id,
  );
  expect(done?.execution?.state).toBe("completed");
  expect(done?.execution?.report).toBe("done");
  expect(
    after.messages.filter(
      (message) =>
        message.workId === done?.workId && message.role === "assistant",
    ),
  ).toHaveLength(2);
  expect(JSON.stringify(after)).not.toContain("jeton-synthetique");
  await page.screenshot({
    path: `${EVIDENCE}/apres-composio-recu.png`,
    fullPage: true,
  });
});

test("un résultat inconnu reste visible et n’offre aucun nouvel envoi ; un compte rendu en échec se relance sans renvoyer l’action", async ({
  page,
  request,
}) => {
  await grantByRoutes(request, "pixel");
  await openThread(page, "Pixel");

  await sendMessage(page, "Envoi au résultat inconnu");
  await card(page)
    .getByRole("button", { name: "Approuver cette action exacte" })
    .click();
  await expect(card(page)).toContainText(
    "Résultat inconnu : le service n’a pas confirmé. L’action a peut-être eu lieu. EzraBot ne la renvoie pas.",
  );
  await expect(
    page
      .getByRole("main")
      .getByText("Compte rendu : l’action est dans l’état unknown."),
  ).toBeVisible();
  await expect(card(page).getByRole("button")).toHaveCount(0);
  await page.screenshot({
    path: `${EVIDENCE}/apres-composio-inconnu.png`,
    fullPage: true,
  });

  await sendMessage(page, "Envoi avec rapport fragile");
  const second = card(page).last();
  await second
    .getByRole("button", { name: "Approuver cette action exacte" })
    .click();
  await expect(second).toContainText(
    "Le compte rendu du personnage a échoué. Le relancer ne renvoie pas l’action.",
  );
  const executions = async () =>
    (await pcView(request)).tools.proposals
      .filter((proposal) => proposal.botId === "pixel")
      .map((proposal) => proposal.execution?.state);
  expect(await executions()).toEqual(["unknown", "completed"]);
  await second
    .getByRole("button", { name: "Relancer le compte rendu" })
    .click();
  await expect(
    page
      .getByRole("main")
      .getByText("Compte rendu : l’action est dans l’état completed."),
  ).toBeVisible();
  await expect(
    second.getByRole("button", { name: "Relancer le compte rendu" }),
  ).toHaveCount(0);
  expect(await executions()).toEqual(["unknown", "completed"]);
});

test("un envoi vers les services garde sa commande exacte après un rechargement, et le choix décoché garde la voie des documents", async ({
  page,
  request,
}) => {
  await grantByRoutes(request, "atlas");
  await openThread(page, "Atlas");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const services = page.getByRole("checkbox", {
    name: /Utiliser les services connectés/,
  });
  await expect(services).toBeChecked();

  const commands: Command[] = [];
  let pass = false;
  await page.route("**/api/commands", async (route) => {
    commands.push(route.request().postDataJSON());
    if (pass) await route.continue();
    else await route.abort();
  });
  await input.fill("  Envoie le rappel de demain  ");
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(services).toBeDisabled();
  await input.fill("Brouillon plus récent");
  await page.reload();
  await expect(input).toHaveValue("Brouillon plus récent");
  await expect(page.getByText("Un envoi attend sa confirmation")).toBeVisible();
  pass = true;
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[0]?.type).toBe("message.send");
  expect(commands[0]).toMatchObject({ text: "Envoie le rappel de demain" });
  expect(commands[0]).not.toHaveProperty("document");
  expect(commands[1]).toEqual(commands[0]);
  await expect(card(page)).toContainText(
    '"subject": "Envoie le rappel de demain"',
  );
  await expect(input).toHaveValue("Brouillon plus récent");

  await services.uncheck();
  await input.fill("Rédige un document de bilan");
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect.poll(() => commands.length).toBe(3);
  expect(commands[2]?.type).toBe("message.say");
  await expect
    .poll(async () => (await pcView(request)).tasks.length)
    .toBeGreaterThan(0);
  const view = await pcView(request);
  expect(view.tasks.at(-1)?.threadBotId).toBe("atlas");
  expect(
    view.tools.proposals.filter((proposal) => proposal.botId === "atlas"),
  ).toHaveLength(1);
});

test("sans clé Composio, les préférences et la page du personnage l’indiquent, et le composeur garde son envoi habituel", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("checkbox", { name: /Utiliser les services connectés/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Préférences/ }).click();
  const connections = page
    .getByRole("dialog")
    .getByRole("region", { name: "Services connectés" });
  await expect(connections).toContainText(
    "Aucune clé Composio n’est configurée sur ce serveur.",
  );
  await expect(connections.getByRole("button")).toHaveCount(0);
  await page.screenshot({
    path: `${EVIDENCE}/apres-composio-sans-cle.png`,
    fullPage: true,
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Fermer" })
    .click();
  await page.getByRole("button", { name: "Personnages", exact: true }).click();
  await page.getByRole("button", { name: "Modifier Mino" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Mémoire et réglages" })
    .click();
  await expect(
    page.getByRole("region", { name: "Services connectés" }),
  ).toContainText("Aucune clé Composio n’est configurée sur ce serveur.");
});
