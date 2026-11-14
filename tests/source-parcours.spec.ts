import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { Command } from "../server/src/protocol";
import type { PcView, ToolsReplyOf } from "../server/src/tools-protocol";

// Real isolated store, worker and HTTP server. The provider and the App Server are fakes started by scripts/test-server.mjs.
// The fake engine writes a synthetic note, and copies the version it receives into the body of the action it proposes.
// Every account, document, action and result on these pages is synthetic.

const TOOLS = "http://127.0.0.1:4398";
const HEADERS = { origin: TOOLS, "x-mino-csrf": "test-only-token" };
const V1 = "Première version de la note synthétique.";
const V2 = "Deuxième version de la note, modifiée par la personne.";

const pcView = async (request: APIRequestContext): Promise<PcView> =>
  (await request.get(`${TOOLS}/api/view`)).json();

async function command(request: APIRequestContext, data: object) {
  const response = await request.post(`${TOOLS}/api/commands`, {
    headers: HEADERS,
    data: { requestId: crypto.randomUUID(), ...data },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

/** A new bot with one saved note of two versions, written through the real chat lane before the bot has any right. */
async function botWithNote(request: APIRequestContext, name: string) {
  const shape = (await pcView(request)).bots[0];
  const created = await command(request, {
    type: "bot.create",
    name,
    title: "notes synthétiques",
    shape: shape?.shape,
    color: shape?.color,
  });
  const botId: string = created.result.botId;
  await command(request, {
    type: "message.send",
    botId,
    text: "Rédige la note synthétique",
    attachments: [],
  });
  await expect
    .poll(async () => noteOf(await pcView(request), botId)?.versions.length)
    .toBe(1);
  const note = noteOf(await pcView(request), botId);
  await command(request, {
    type: "version.edit",
    workId: note?.id,
    baseVersionId: note?.versions[0]?.id,
    title: "Note synthétique",
    body: V2,
  });
  const versions = noteOf(await pcView(request), botId)?.versions ?? [];
  expect(versions.map((version) => version.body)).toEqual([V1, V2]);
  return { botId, workId: note?.id ?? "", versions };
}

const proposalsOf = async (request: APIRequestContext, botId: string) =>
  (await pcView(request)).tools.proposals.filter(
    (proposal) => proposal.botId === botId,
  );

const noteOf = (view: PcView, botId: string) =>
  view.works.find((work) => work.botId === botId && work.versions.length > 0);

async function grant(request: APIRequestContext, botId: string, name: string) {
  const alias = `Courriel de ${name}`;
  const link: ToolsReplyOf<"link"> = await (
    await request.post(`${TOOLS}/api/tools/link`, {
      headers: HEADERS,
      data: { serviceId: "ac_synthetique_gmail", alias },
    })
  ).json();
  await request.post(`${TOOLS}/api/tools/links/${link.linkId}/check`, {
    headers: HEADERS,
    data: {},
  });
  const account = (await pcView(request)).tools.accounts.find(
    (candidate) => candidate.alias === alias,
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
}

async function openNote(page: Page, name: string) {
  await page.goto(TOOLS);
  await page
    .locator(".threads")
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await page.getByRole("button", { name: "Ouvrir le document" }).click();
  await expect(
    page.getByRole("heading", { name: "Note synthétique" }),
  ).toBeVisible();
}

const action = (page: Page) =>
  page.getByRole("region", { name: "Action sur un service" });
const card = (page: Page) =>
  page.getByRole("region", { name: "Action proposée GMAIL_SEND_EMAIL" });

async function sendMessage(page: Page, text: string): Promise<Command> {
  const sent = page.waitForRequest(
    (request) =>
      request.url().endsWith("/api/commands") && request.method() === "POST",
  );
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  return (await sent).postDataJSON();
}

test("depuis une ancienne version enregistrée : état sans droit, saisie non enregistrée, puis action exacte relue, approuvée et envoyée une fois", async ({
  page,
  request,
}, testInfo) => {
  const { botId, workId, versions } = await botWithNote(request, "Lison");
  const [v1] = versions;

  await openNote(page, "Lison");
  await expect(
    action(page).getByRole("button", {
      name: "Préparer une action avec la version 2",
    }),
  ).toBeDisabled();
  await expect(action(page).locator("p")).toHaveText(
    "Lison n’a aucun service connecté. Donnez-lui un droit dans sa page de personnage. Rien ne peut être préparé.",
  );
  await page.screenshot({
    path: testInfo.outputPath("apres-1-lecteur-sans-droit.png"),
    fullPage: true,
  });
  expect(await proposalsOf(request, botId)).toEqual([]);

  await grant(request, botId, "Lison");
  await page.reload();
  await page.getByRole("button", { name: "Ouvrir le document" }).click();
  await page.getByRole("button", { name: "Modifier" }).click();
  await page.getByLabel("Contenu").fill("Saisie jamais enregistrée.");
  await page.getByRole("button", { name: "Lire", exact: true }).click();
  await expect(
    action(page).getByRole("button", {
      name: "Préparer une action avec la version 2",
    }),
  ).toBeDisabled();
  await expect(action(page).locator("p")).toContainText(
    "Enregistrez ou abandonnez d’abord votre saisie",
  );
  await page.getByRole("button", { name: /^Modifier/ }).click();
  await page.getByRole("button", { name: "Abandonner ma saisie" }).click();
  await page.getByRole("button", { name: "Lire", exact: true }).click();

  await page.getByRole("button", { name: "Lire la version 1" }).click();
  await expect(page.locator(".ez-doc-reader")).toContainText(V1);
  const prepare = action(page).getByRole("button", {
    name: "Préparer une action avec la version 1",
  });
  await expect(prepare).toBeEnabled();
  await expect(action(page)).toContainText(
    "La version 1 enregistrée est transmise (ancienne version : la version actuelle est la 2).",
  );
  await page.screenshot({
    path: testInfo.outputPath("apres-2-lecteur-version-1.png"),
    fullPage: true,
  });

  await prepare.click();
  const chosen = page.locator(".ez-chat-source");
  await expect(chosen).toContainText(
    "Version source « Note synthétique », version 1 · ancienne version : la version actuelle est la 2",
  );
  await expect(chosen).toContainText(
    "Seule cette version enregistrée sera transmise à Lison.",
  );
  await expect(page.getByText("Utiliser les services connectés")).toHaveCount(
    0,
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Envoie la première version à l’équipe");
  await page.screenshot({
    path: testInfo.outputPath("apres-3-composeur-version-source.png"),
  });

  const sent = await sendMessage(page, "Envoie la première version à l’équipe");
  expect(sent).toMatchObject({
    type: "message.send",
    botId,
    source: { workId, versionId: v1?.id },
  });
  expect(JSON.stringify(sent)).not.toContain(V1);
  await expect(chosen).toHaveCount(0);

  await expect(card(page)).toContainText("En attente de votre décision");
  await expect(card(page)).toContainText(
    "« Note synthétique », version 1 · ancienne version : la version actuelle était la 2",
  );
  await expect(card(page).locator(".ez-tools-arguments").first()).toContainText(
    `"body": "${V1}"`,
  );
  await expect(page.locator(".ez-source-note")).toContainText(
    "Version source : « Note synthétique », version 1",
  );
  const [open, ...others] = await proposalsOf(request, botId);
  expect(others).toEqual([]);
  expect(open?.source).toMatchObject({
    versionId: v1?.id,
    versionN: 1,
    headN: 2,
    state: "holds",
  });
  expect(open?.execution).toBeNull();
  await card(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("apres-4-carte-version-source.png"),
  });

  await card(page)
    .getByRole("button", { name: "Approuver cette action exacte" })
    .click();
  await expect(card(page)).toContainText("Le service confirme l’exécution.");
  const [done] = await proposalsOf(request, botId);
  expect([done?.id, done?.execution?.state]).toEqual([open?.id, "completed"]);
  expect(done?.arguments.body).toBe(V1);
  await page.screenshot({
    path: testInfo.outputPath("apres-5-carte-envoyee.png"),
  });

  await card(page).getByRole("button", { name: "Lire la version 1" }).click();
  await expect(page.locator(".ez-doc-reader")).toContainText(V1);
  await expect(
    page.getByRole("heading", { name: "Version 1 · ancienne" }),
  ).toBeVisible();
});

test("une nouvelle version après la préparation périme la carte : plus d’approbation possible, rien n’est envoyé", async ({
  page,
  request,
}, testInfo) => {
  const { botId, workId, versions } = await botWithNote(request, "Maelle");
  await grant(request, botId, "Maelle");

  await openNote(page, "Maelle");
  await action(page)
    .getByRole("button", { name: "Préparer une action avec la version 2" })
    .click();
  await expect(page.locator(".ez-chat-source")).toContainText(
    "version 2 · version actuelle",
  );
  await sendMessage(page, "Envoie la note actuelle");
  await expect(card(page)).toContainText("En attente de votre décision");
  await expect(card(page)).toContainText(
    "version 2 · version actuelle au moment de la demande",
  );

  await command(request, {
    type: "version.edit",
    workId,
    baseVersionId: versions[1]?.id,
    title: "Note synthétique",
    body: "Troisième version, écrite après la préparation.",
  });
  await expect(card(page)).toContainText(
    "Périmée : le document source a changé depuis votre demande. Rien n’a été envoyé.",
  );
  await expect(card(page)).toContainText("le document a changé depuis");
  await expect(
    card(page).getByRole("button", { name: "Approuver cette action exacte" }),
  ).toHaveCount(0);
  const [stale] = await proposalsOf(request, botId);
  expect([stale?.state, stale?.staleReason, stale?.execution]).toEqual([
    "stale",
    "source_changed",
    null,
  ]);
  await card(page).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("apres-6-carte-perimee.png"),
  });
});
