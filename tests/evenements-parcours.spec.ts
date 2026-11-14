import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { PcView } from "../server/src/tools-protocol";
import {
  eventBody,
  signHeaders,
  type EventInput,
} from "../server/test/fixtures/signed-event";

// This QA server receives synthetic signed events beside its PC routes, with a fake transport, secret and account.
const QA = "http://127.0.0.1:4397";
const SECRET = "whsec_qa_synthetique_0001";
const EVIDENCE = "test-results/evenements-parcours";
const owner = () =>
  readFileSync(join(tmpdir(), "mino-qa-owner-4397"), "utf8").trim();

async function view(page: Page): Promise<PcView> {
  return (await page.request.get(`${QA}/api/view`)).json();
}
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage: true });
async function deliver(page: Page, input: EventInput = {}, id?: string) {
  const event = eventBody(owner(), {
    triggerId: "ti_qa_1",
    accountId: "ca_qa_github",
    ...input,
    ...(id ? { id } : {}),
  });
  const response = await page.request.post(`${QA}/events/composio`, {
    headers: signHeaders(SECRET, event.id, event.body),
    data: event.body,
  });
  return { id: event.id, status: response.status() };
}

test("un abonnement se crée inactif, refuse avant activation, crée une seule demande avec sa source, puis se met en pause et se révoque", async ({
  page,
}) => {
  mkdirSync(EVIDENCE, { recursive: true });
  await page.goto(QA);
  await page.getByRole("button", { name: "Routines" }).click();
  await page.getByRole("button", { name: /^Événements de service/ }).click();
  await expect(
    page.getByRole("heading", {
      name: "Une demande, quand un service l’annonce.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Réception configurée localement")).toBeVisible();
  await expect(
    page.getByText("Ce n’est pas la preuve que le fournisseur joint ce PC", {
      exact: false,
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Nouvel abonnement" }).click();
  const form = page.getByRole("form", { name: "Nouvel abonnement" });
  await form.getByLabel("Personnage").selectOption("nova");
  await form.getByLabel("Identifiant du déclencheur").fill("ti_qa_1");
  await form.getByLabel("Type d’événement").fill("GITHUB_ISSUE_ADDED_EVENT");
  await form
    .getByLabel("Consigne envoyée dans le fil")
    .fill("Résume ce ticket synthétique en une phrase.");
  await form.getByLabel("Champs copiés", { exact: false }).fill("title");
  await form.getByRole("button", { name: "Enregistrer sans activer" }).click();
  const card = page.getByRole("article", {
    name: "Abonnement GITHUB_ISSUE_ADDED_EVENT de Nova",
  });
  await expect(card.getByText("Inactif", { exact: true })).toBeVisible();
  await expect(
    card.getByText("Compte GitHub synthétique (github)", { exact: false }),
  ).toBeVisible();
  await expect(
    card.getByText("dernier état connu ACTIVE", { exact: false }),
  ).toBeVisible();

  expect((await deliver(page)).status).toBe(200);
  await expect(
    card.getByText("refusé, l’abonnement n’était pas encore activé", {
      exact: false,
    }),
  ).toBeVisible();
  await shot(page, "1-inactif-refus-visible");

  await card
    .getByRole("button", {
      name: "Activer : accepter ces demandes automatiques",
    })
    .click();
  await expect(card.getByText("Actif", { exact: true })).toBeVisible();
  const first = await deliver(page, {
    data: { title: "Ticket synthétique 42", body: "jamais copié" },
  });
  expect(first.status).toBe(200);
  expect(
    (
      await deliver(
        page,
        { data: { title: "Ticket synthétique 42", body: "jamais copié" } },
        first.id,
      )
    ).status,
  ).toBe(200);
  expect(
    (await deliver(page, { data: { title: "Autre contenu" } }, first.id))
      .status,
  ).toBe(409);
  await expect(card.getByText("demande créée", { exact: false })).toBeVisible();
  await expect(
    card.getByText("1 copie au contenu différent, ignorée", { exact: false }),
  ).toBeVisible();
  const requests = (await view(page)).messages.filter(
    (m) => m.trigger?.kind === "event",
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]?.text).toContain("title : Ticket synthétique 42");
  expect(requests[0]?.text).not.toContain("jamais copié");
  await shot(page, "2-actif-une-demande");

  await card
    .getByRole("button", { name: "Voir la demande et son résultat" })
    .click();
  await expect(
    page.getByRole("button", {
      name: /Demande créée par l’événement GITHUB_ISSUE_ADDED_EVENT, compte « Compte GitHub synthétique », que personne n’a tapée/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByText("Bonjour depuis le faux moteur."),
  ).toBeVisible();
  await shot(page, "3-fil-source-et-resultat");

  await page
    .getByRole("button", {
      name: /Demande créée par l’événement GITHUB_ISSUE_ADDED_EVENT/,
    })
    .click();
  await card.getByRole("button", { name: "Modifier" }).click();
  const edit = page.getByRole("form", { name: "Modifier l’abonnement" });
  await expect(edit.getByLabel("Identifiant du déclencheur")).toBeDisabled();
  const id = (await view(page)).events.subscriptions[0]?.id ?? "";
  const paused = await page.request.post(`${QA}/api/commands`, {
    headers: { origin: QA, "x-mino-csrf": "test-only-token" },
    data: {
      type: "subscription.pause",
      requestId: crypto.randomUUID(),
      subscriptionId: id,
    },
  });
  expect(paused.status()).toBe(200);
  await edit
    .getByLabel("Consigne envoyée dans le fil")
    .fill("Consigne d’un onglet périmé.");
  await edit
    .getByRole("button", { name: "Enregistrer la modification" })
    .click();
  await expect(
    edit.getByText("Cet abonnement a changé depuis son affichage", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(card.getByText("En pause", { exact: true })).toBeVisible();
  expect((await deliver(page)).status).toBe(200);
  await expect(
    card.getByText("refusé, l’abonnement était en pause", { exact: false }),
  ).toBeVisible();
  await shot(page, "4-pause-et-onglet-perime");

  await card.getByRole("button", { name: "Révoquer" }).click();
  await card.getByRole("button", { name: "Confirmer la révocation" }).click();
  await expect(card.getByText("Révoqué", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Reprendre" })).toHaveCount(0);
  expect(
    (await view(page)).messages.filter((m) => m.trigger?.kind === "event"),
  ).toHaveLength(1);
  await shot(page, "5-revoque");
});
