import { mkdirSync } from "node:fs";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import type { PcView, ToolsReplyOf } from "../server/src/tools-protocol";


const BOTH = "http://127.0.0.1:4396";
const EVIDENCE = "test-results/memoire-action-parcours";
const HEADERS = { origin: BOTH, "x-mino-csrf": "test-only-token" };

const pcView = async (request: APIRequestContext): Promise<PcView> =>
  (await request.get(`${BOTH}/api/view`)).json();

async function command(
  request: APIRequestContext,
  route: "commands" | "memory/commands" | "tools/commands",
  data: Record<string, unknown>,
) {
  const response = await request.post(`${BOTH}/api/${route}`, {
    headers: HEADERS,
    data: { requestId: crypto.randomUUID(), ...data },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

async function characterWithMemoryAndRight(
  request: APIRequestContext,
  name: string,
) {
  const created = await command(request, "commands", {
    type: "bot.create",
    name,
    title: "Personnage de recette",
    shape: "radish",
    color: "#8de343",
  });
  const botId: string = created.result.botId;
  await command(request, "memory/commands", {
    type: "memory.enable",
    botId,
    label: `Projet de ${name}`,
    acknowledged: true,
  });
  await expect
    .poll(
      async () =>
        (await pcView(request)).memory.scopes.find(
          (scope) => scope.botId === botId,
        )?.state,
    )
    .toBe("active");
  const alias = `Courriel de ${name}`;
  const link: ToolsReplyOf<"link"> = await (
    await request.post(`${BOTH}/api/tools/link`, {
      headers: HEADERS,
      data: { serviceId: "ac_synthetique_gmail", alias },
    })
  ).json();
  await request.post(`${BOTH}/api/tools/links/${link.linkId}/check`, {
    headers: HEADERS,
    data: {},
  });
  const account = (await pcView(request)).tools.accounts.find(
    (candidate) => candidate.alias === alias,
  );
  await command(request, "tools/commands", {
    type: "tools.grant",
    botId,
    accountId: account?.id,
    toolSlugs: ["GMAIL_SEND_EMAIL"],
  });
  return botId;
}

async function openThread(page: Page, name: string) {
  await page.goto(BOTH);
  await page
    .locator(".threads")
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
}

const card = (page: Page) =>
  page.getByRole("region", { name: "Action proposée GMAIL_SEND_EMAIL" });

const SIZE = { width: 1280, height: 1100 };
test.use({ viewport: SIZE, video: { mode: "on", size: SIZE } });

test.beforeAll(() => mkdirSync(EVIDENCE, { recursive: true }));

test("une demande exclue de la mémoire périme l’action préparée dans son tour : la carte le dit, l’approbation disparaît, rien n’est envoyé", async ({
  page,
  request,
}) => {
  const botId = await characterWithMemoryAndRight(request, "Verveine");
  await openThread(page, "Verveine");
  const REQUEST = "Envoie le bilan synthétique à l’équipe";
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill(REQUEST);
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect(card(page)).toContainText("En attente de votre décision");
  await expect(
    card(page).getByRole("button", { name: "Approuver cette action exacte" }),
  ).toBeVisible();
  await card(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}/01-action-en-attente.png` });

  const asked = page.locator(".ez-chat-user").filter({ hasText: REQUEST });
  await asked.getByRole("button", { name: "Exclure de la mémoire" }).click();
  await asked.getByRole("button", { name: "Confirmer l’exclusion" }).click();
  await expect(asked).toContainText("Demande exclue de la mémoire Honcho.");

  await expect(card(page)).toContainText(
    "Périmée : une source de la mémoire de cette conversation a été corrigée, exclue ou oubliée depuis votre demande. Rien n’a été envoyé.",
  );
  await expect(card(page)).not.toContainText("document");
  await expect(
    card(page).getByRole("button", { name: "Approuver cette action exacte" }),
  ).toHaveCount(0);
  const [closed] = (await pcView(request)).tools.proposals.filter(
    (proposal) => proposal.botId === botId,
  );
  expect([closed?.state, closed?.staleReason, closed?.execution]).toEqual([
    "stale",
    "source_changed",
    null,
  ]);
  await card(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}/02-action-perimee.png` });
});
