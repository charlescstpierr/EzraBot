import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { PcView } from "../server/src/tools-protocol";

// The QA server on this port answers with the fake App Server and reads its routine clock from this file.
const QA = "http://127.0.0.1:4397";
const CLOCK = join(tmpdir(), "mino-qa-clock-4397");
const EVIDENCE = "test-results/routines-parcours";
const shiftClock = (ms: number) => writeFileSync(CLOCK, String(ms));

async function view(page: Page): Promise<PcView> {
  return (await page.request.get(`${QA}/api/view`)).json();
}
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${EVIDENCE}/${name}.png`, fullPage: true });

test.afterEach(() => shiftClock(0));

test("une routine se crée inactive, montre ses créneaux, s’active, envoie une seule demande à l’heure, puis se met en pause et reprend", async ({
  page,
}) => {
  mkdirSync(EVIDENCE, { recursive: true });
  shiftClock(0);
  const slot = new Date(Date.now() + 3 * 60_000);
  const time = slot.toISOString().slice(11, 16);
  const endsOn = new Date(Date.now() + 10 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  await page.goto(QA);
  await page.getByRole("button", { name: "Routines" }).click();
  await expect(
    page.getByRole("heading", { name: "Une demande, à heure fixe." }),
  ).toBeVisible();
  await expect(
    page.getByText("Pas de recherche ni d’export Honcho pour cette demande.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("le coût est indisponible, jamais compté comme zéro", {
      exact: false,
    }),
  ).toBeVisible();
  await shot(page, "01-page-vide");

  await page.getByRole("button", { name: "Nouvelle routine" }).click();
  const form = page.getByRole("form", { name: "Nouvelle routine" });
  await form.getByLabel("Personnage").selectOption("atlas");
  await form
    .getByLabel("Texte envoyé dans le fil")
    .fill("Résume mes trois priorités du jour.");
  await form.getByLabel("Heure locale").fill(time);
  await form.getByLabel("Fuseau horaire").fill("UTC");
  for (const day of ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."]) {
    const box = form.getByRole("checkbox", { name: day });
    if (!(await box.isChecked())) await box.check();
  }
  await form.getByLabel("Dernier jour").fill(endsOn);
  await form.getByLabel("Demandes au plus, sur toute sa vie").fill("5");
  await form.getByRole("button", { name: "Enregistrer sans activer" }).click();

  const card = page.getByRole("article", { name: "Routine de Atlas" });
  await expect(card.getByText("Inactive")).toBeVisible();
  await expect(card.getByRole("listitem")).toHaveCount(5);
  await expect(card.getByText(`${time} (UTC+00:00)`).first()).toBeVisible();
  expect((await view(page)).routines[0]?.state).toBe("inactive");
  await shot(page, "02-apercu-inactive");

  await card
    .getByRole("button", {
      name: "Activer : autoriser ces demandes automatiques",
    })
    .click();
  await expect(card.getByText("Active", { exact: true })).toBeVisible();
  await shot(page, "03-active");

  const first = await view(page);
  expect(
    first.messages.filter((m) => m.trigger?.kind === "routine"),
  ).toHaveLength(0);
  shiftClock(slot.getTime() + 30_000 - Date.now());
  await expect
    .poll(
      async () =>
        (await view(page)).works.find((w) => w.botId === "atlas")?.state,
      { timeout: 15_000 },
    )
    .toBe("done");
  await expect(
    card.getByText("demande envoyée dans le fil", { exact: false }),
  ).toBeVisible();
  await shot(page, "04-decision");
  await page.waitForTimeout(2500);
  const after = await view(page);
  expect(
    after.messages.filter((m) => m.trigger?.kind === "routine"),
    "une seule demande pour ce créneau",
  ).toHaveLength(1);

  await card
    .getByRole("button", { name: "Voir la demande et son résultat" })
    .click();
  const request = page
    .locator("article.ez-chat-user")
    .filter({ hasText: "Résume mes trois priorités du jour." });
  await expect(request.getByText("Routine", { exact: true })).toBeVisible();
  await expect(
    request.getByRole("button", { name: /que personne n’a tapée/ }),
  ).toBeVisible();
  await expect(page.locator("article.ez-chat-assistant").last()).toBeVisible();
  await shot(page, "05-fil-routine");

  await request.getByRole("button", { name: /Voir la routine/ }).click();
  await card.getByRole("button", { name: "Mettre en pause" }).click();
  await expect(card.getByText("En pause")).toBeVisible();
  await shot(page, "06-pause");
  await card.getByRole("button", { name: "Reprendre" }).click();
  await expect(card.getByText("Active", { exact: true })).toBeVisible();
  await shot(page, "07-reprise");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  await shot(page, "08-telephone-largeur");
});

test("une modification périmée ne remplace pas celle d’un autre onglet", async ({
  page,
  context,
}) => {
  const initial = "Routine de conflit " + Date.now();
  const fresh = initial + " enregistrée par B";
  const stale = initial + " brouillon A";
  await page.goto(QA);
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  await page
    .getByRole("button", { name: "Nouvelle routine", exact: true })
    .click();
  const create = page.getByRole("form", { name: "Nouvelle routine" });
  await create.getByLabel("Personnage").selectOption("nova");
  await create.getByLabel("Texte envoyé dans le fil").fill(initial);
  await create
    .getByLabel("Dernier jour")
    .fill(new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10));
  await create
    .getByRole("button", { name: "Enregistrer sans activer", exact: true })
    .click();
  const id = (await view(page)).routines.find((r) => r.text === initial)?.id;
  expect(id).toBeTruthy();
  await page
    .getByRole("article")
    .filter({ hasText: initial })
    .getByRole("button", { name: "Modifier", exact: true })
    .click();
  const first = page.getByRole("form", { name: "Modifier la routine" });
  await first.getByLabel("Texte envoyé dans le fil").fill(stale);
  const secondPage = await context.newPage();
  try {
    await secondPage.goto(QA);
    await secondPage
      .getByRole("button", { name: "Routines", exact: true })
      .click();
    await secondPage
      .getByRole("article")
      .filter({ hasText: initial })
      .getByRole("button", { name: "Modifier", exact: true })
      .click();
    const second = secondPage.getByRole("form", {
      name: "Modifier la routine",
    });
    await second.getByLabel("Texte envoyé dans le fil").fill(fresh);
    await second
      .getByRole("button", { name: "Enregistrer la modification", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await view(page)).routines.find((r) => r.id === id)?.revision,
      )
      .toBe(2);
    await expect(
      page.getByRole("article").filter({ hasText: fresh }),
    ).toContainText("révision 2");
    await expect(first.getByLabel("Texte envoyé dans le fil")).toHaveValue(
      stale,
    );
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" && r.url().endsWith("/api/commands"),
    );
    await first
      .getByRole("button", { name: "Enregistrer la modification", exact: true })
      .click();
    const sent = await response;
    await page.screenshot({
      path: "test-results/routines-conflit.png",
      fullPage: true,
    });
    expect(sent.status()).toBe(409);
    expect((await sent.json()).code).toBe("stale_base");
    expect((await view(page)).routines.find((r) => r.id === id)?.text).toBe(
      fresh,
    );
    expect((await view(page)).routines.find((r) => r.id === id)?.revision).toBe(
      2,
    );
    await expect(first.getByLabel("Texte envoyé dans le fil")).toHaveValue(
      stale,
    );
  } finally {
    await secondPage.close();
  }
});
