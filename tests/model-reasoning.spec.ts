import { mkdirSync, readFileSync } from "node:fs";
import { test, expect, type Locator, type Page } from "@playwright/test";
import type { AppView, BotChoice } from "../server/src/protocol";

const TOOLS = `http://127.0.0.1:${process.env.MINO_QA_TOOLS_PORT ?? "4398"}`;
const OFFLINE = `http://127.0.0.1:${process.env.MINO_QA_PORT ?? "4399"}`;
const EVIDENCE = process.env.MINO_EVIDENCE_DIR;

type Listed = {
  id: string;
  displayName: string;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  defaultReasoningEffort: string;
  serviceTiers: { id: string; name: string }[];
};
const listed: Listed[] = JSON.parse(
  readFileSync("server/test/fixtures/engine-catalogue.json", "utf8"),
).models;
const efforts = (model: Listed) =>
  model.supportedReasoningEfforts.map((e) => e.reasoningEffort);
function pick(found: Listed | undefined): Listed {
  if (!found) throw Error("L’instantané du moteur n’a plus ce modèle");
  return found;
}
const withUltra = pick(
  listed.find(
    (m) =>
      efforts(m).includes("ultra") &&
      efforts(m).includes("max") &&
      m.serviceTiers.some((t) => t.id === "priority"),
  ),
);
const withoutUltra = pick(
  listed.find(
    (m) => efforts(m).includes("max") && !efforts(m).includes("ultra"),
  ),
);

const shot = async (page: Page, name: string) => {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${EVIDENCE}/${name}.png` });
};
const choiceCommands = (page: Page) => {
  const seen: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/commands")) return;
    const body = request.postDataJSON();
    if (body?.type === "bot.create" || body?.type === "bot.configure")
      seen.push(body);
  });
  return seen;
};
const uniqueName = (base: string) =>
  `${base} ${Date.now() % 100000}`.slice(0, 24);
async function newSheet(page: Page, base: string) {
  await page.goto(base);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Nouveau personnage" })
    .click();
  return page.getByRole("dialog", { name: "Nouveau personnage", exact: true });
}
async function editSheet(page: Page, name: string) {
  await page
    .locator(".threads")
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();
  await page.locator("main > header .bot-title").click();
  await page.getByRole("menuitem", { name: `Modifier ${name}` }).click();
  return page.getByRole("dialog", { name: `Modifier ${name}`, exact: true });
}

async function chooseModel(sheet: Locator, model: Listed) {
  await sheet.getByRole("button", { name: /^Modèle de / }).click();
  await sheet
    .getByRole("combobox", { name: "Chercher un modèle" })
    .fill(model.id);
  await expect(sheet.getByRole("option")).toHaveCount(1);
  await sheet.getByRole("option").click();
}
const levels = (sheet: Locator, legend: "Réflexion" | "Vitesse") =>
  sheet.getByRole("group", { name: legend });
const offered = (group: Locator) =>
  group
    .getByRole("radio")
    .evaluateAll((radios) => radios.map((r) => (r as HTMLInputElement).value));
const level = (group: Locator, value: string) =>
  group.locator(`input[type="radio"][value="${value}"]`);
const chip = (group: Locator, value: string) =>
  group.locator(`label:has(input[type="radio"][value="${value}"])`);
async function choiceOf(page: Page, base: string, name: string) {
  const view: AppView = await (
    await page.request.get(base + "/api/view")
  ).json();
  const bots = view.bots.filter((b) => b.name === name);
  expect(bots).toHaveLength(1);
  return bots[0].choice;
}
async function createByCommand(
  page: Page,
  name: string,
  choice: Partial<BotChoice>,
) {
  await page.evaluate(
    async (command) => {
      const csrf =
        document.querySelector<HTMLMetaElement>('meta[name="mino-csrf"]')
          ?.content ?? "";
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-mino-csrf": csrf },
        body: JSON.stringify(command),
      });
      if (!response.ok) throw Error("Création de préparation refusée");
    },
    {
      type: "bot.create",
      requestId: crypto.randomUUID(),
      name,
      title: "",
      shape: "sprout",
      color: "#8de343",
      ...choice,
    },
  );
}

test("à la création, chaque modèle montre son identifiant exact et ses propres niveaux", async ({
  page,
}) => {
  const sent = choiceCommands(page);
  const sheet = await newSheet(page, TOOLS);
  const trigger = sheet.getByRole("button", {
    name: /^Modèle de ce personnage/,
  });
  await expect(trigger).toContainText("Fake Sol");
  await expect(trigger).toContainText("fake-sol");
  expect(await offered(levels(sheet, "Réflexion"))).toEqual([
    "",
    "low",
    "high",
  ]);
  await expect(level(levels(sheet, "Réflexion"), "")).toBeChecked();
  await expect(
    levels(sheet, "Réflexion").getByRole("radio", {
      name: "Par défaut (low)",
      exact: true,
    }),
  ).toBeChecked();
  expect(await offered(levels(sheet, "Vitesse"))).toEqual([
    "standard",
    "priority",
  ]);
  await expect(level(levels(sheet, "Vitesse"), "standard")).toBeChecked();

  await trigger.click();
  const search = sheet.getByRole("combobox", { name: "Chercher un modèle" });
  for (const model of listed) {
    const option = sheet.getByRole("option").filter({ hasText: model.id });
    await expect(option).toContainText(model.displayName);
  }
  await shot(page, "01-creation-liste-noms-et-identifiants");
  const named = pick(listed.find((m) => m.displayName.toLowerCase() !== m.id));
  await search.fill(named.displayName.toLowerCase());
  await expect(sheet.getByRole("option")).toHaveCount(1);
  await expect(sheet.getByRole("option")).toContainText(named.id);
  await search.fill(withUltra.id);
  await expect(sheet.getByRole("option")).toHaveCount(1);
  await expect(sheet.getByRole("option")).toContainText(withUltra.displayName);
  await sheet.getByRole("option").click();
  await expect(trigger).toContainText(withUltra.displayName);
  await expect(trigger).toContainText(withUltra.id);
  expect(await offered(levels(sheet, "Réflexion"))).toEqual([
    "",
    ...efforts(withUltra),
  ]);
  for (const token of efforts(withUltra))
    await expect(chip(levels(sheet, "Réflexion"), token)).toContainText(token);
  await expect(
    levels(sheet, "Réflexion").getByRole("radio", {
      name: `Par défaut (${withUltra.defaultReasoningEffort})`,
      exact: true,
    }),
  ).toBeChecked();
  await shot(page, "02-creation-niveaux-du-modele-avec-ultra");

  await chooseModel(sheet, withoutUltra);
  await expect(trigger).toContainText(withoutUltra.id);
  expect(await offered(levels(sheet, "Réflexion"))).toEqual([
    "",
    ...efforts(withoutUltra),
  ]);
  await expect(level(levels(sheet, "Réflexion"), "ultra")).toHaveCount(0);
  await shot(page, "03-creation-niveaux-du-modele-sans-ultra");
  expect(sent).toEqual([]);
});

test("le modèle, le niveau et la vitesse choisis à la création partent en une commande et restent après recharge", async ({
  page,
}) => {
  const name = uniqueName("Réglé ultra");
  const sent = choiceCommands(page);
  const sheet = await newSheet(page, TOOLS);
  await sheet.getByLabel("Nom", { exact: true }).fill(name);
  await chooseModel(sheet, withUltra);
  await chip(levels(sheet, "Réflexion"), "ultra").click();
  await chip(levels(sheet, "Vitesse"), "priority").click();
  await expect(level(levels(sheet, "Réflexion"), "ultra")).toBeChecked();
  expect(sent).toEqual([]);
  await shot(page, "04-creation-ultra-et-priority-avant-envoi");
  await sheet.getByRole("button", { name: "Créer et discuter" }).click();
  await expect(sheet).toHaveCount(0);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "bot.create",
    name,
    model: withUltra.id,
    effort: "ultra",
    speed: "priority",
  });
  const chosen = { model: withUltra.id, effort: "ultra", speed: "priority" };
  expect(await choiceOf(page, TOOLS, name)).toEqual(chosen);

  await page.reload();
  const edit = await editSheet(page, name);
  await expect(edit.getByRole("button", { name: /^Modèle de / })).toContainText(
    withUltra.id,
  );
  await expect(level(levels(edit, "Réflexion"), "ultra")).toBeChecked();
  await expect(level(levels(edit, "Vitesse"), "priority")).toBeChecked();
  await shot(page, "05-edition-apres-recharge-ultra-et-priority");
  expect(await choiceOf(page, TOOLS, name)).toEqual(chosen);
  expect(sent).toHaveLength(1);
});

test("changer de modèle garde un niveau proposé et remet les autres au défaut", async ({
  page,
}) => {
  const sheet = await newSheet(page, TOOLS);
  const effort = levels(sheet, "Réflexion");
  const speed = levels(sheet, "Vitesse");
  await chooseModel(sheet, withUltra);
  await chip(effort, "ultra").click();
  await chip(speed, "priority").click();

  await chooseModel(sheet, withoutUltra);
  await expect(level(effort, "")).toBeChecked();
  await expect(level(speed, "priority")).toBeChecked();
  await chip(effort, "max").click();

  await chooseModel(sheet, withUltra);
  await expect(level(effort, "max")).toBeChecked();

  await sheet.getByRole("button", { name: /^Modèle de / }).click();
  await sheet
    .getByRole("button", { name: "Modèle par défaut", exact: true })
    .click();
  expect(await offered(effort)).toEqual(["", "low", "high"]);
  await expect(level(effort, "")).toBeChecked();
  await expect(level(speed, "priority")).toBeChecked();
});

test("un niveau choisi sans modèle garde le modèle par défaut", async ({
  page,
}) => {
  const name = uniqueName("Niveau seul");
  const sent = choiceCommands(page);
  const sheet = await newSheet(page, TOOLS);
  await sheet.getByLabel("Nom", { exact: true }).fill(name);
  await chip(levels(sheet, "Réflexion"), "high").click();
  await sheet.getByRole("button", { name: "Créer et discuter" }).click();
  await expect(sheet).toHaveCount(0);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: "bot.create", effort: "high" });
  expect(sent[0].model ?? null).toBeNull();
  expect(await choiceOf(page, TOOLS, name)).toEqual({
    model: null,
    effort: "high",
    speed: "standard",
  });
});

test("la modification règle un seul personnage et envoie les valeurs exactes", async ({
  page,
}) => {
  const tuned = uniqueName("Réglable");
  const untouched = uniqueName("Témoin");
  await page.goto(TOOLS);
  await createByCommand(page, tuned, { model: withUltra.id });
  await createByCommand(page, untouched, {});
  await page.reload();
  const sent = choiceCommands(page);
  const sheet = await editSheet(page, tuned);
  const effort = levels(sheet, "Réflexion");
  expect(await offered(effort)).toEqual(["", ...efforts(withUltra)]);

  await chip(effort, "xhigh").click();
  await expect(level(effort, "xhigh")).toBeChecked();
  await chip(levels(sheet, "Vitesse"), "priority").click();
  await expect(level(levels(sheet, "Vitesse"), "priority")).toBeChecked();
  await shot(page, "06-edition-xhigh-et-priority");
  expect(sent.map(({ requestId: _id, ...command }) => command)).toEqual([
    {
      type: "bot.configure",
      botId: expect.any(String),
      model: withUltra.id,
      effort: "xhigh",
      speed: "standard",
    },
    {
      type: "bot.configure",
      botId: expect.any(String),
      model: withUltra.id,
      effort: "xhigh",
      speed: "priority",
    },
  ]);
  expect(await choiceOf(page, TOOLS, tuned)).toEqual({
    model: withUltra.id,
    effort: "xhigh",
    speed: "priority",
  });
  expect(await choiceOf(page, TOOLS, untouched)).toEqual({
    model: null,
    effort: null,
    speed: "standard",
  });

  await page.keyboard.press("Escape");
  const other = await editSheet(page, untouched);
  expect(await offered(levels(other, "Réflexion"))).toEqual([
    "",
    "low",
    "high",
  ]);
  await chip(levels(other, "Réflexion"), "high").click();
  await expect(level(levels(other, "Réflexion"), "high")).toBeChecked();
  expect(sent.at(-1)).toMatchObject({ model: null, effort: "high" });
  expect(await choiceOf(page, TOOLS, untouched)).toEqual({
    model: null,
    effort: "high",
    speed: "standard",
  });
  expect(await choiceOf(page, TOOLS, tuned)).toEqual({
    model: withUltra.id,
    effort: "xhigh",
    speed: "priority",
  });
});

test("sans catalogue, la feuille l’annonce et la création garde les réglages par défaut", async ({
  page,
}) => {
  const name = uniqueName("Hors catalogue");
  const sheet = await newSheet(page, OFFLINE);
  await sheet.getByLabel("Nom", { exact: true }).fill(name);
  await expect(
    sheet.getByRole("radio", { name: /low|high|ultra/ }),
  ).toHaveCount(0);
  await expect(sheet.locator(".model-settings")).toContainText(
    "réflexion par défaut du modèle",
  );
  await expect(sheet.locator(".model-settings")).toContainText("standard");
  await shot(page, "07-creation-sans-catalogue");
  await sheet.getByRole("button", { name: "Créer et discuter" }).click();
  await expect(sheet).toHaveCount(0);
  expect(await choiceOf(page, OFFLINE, name)).toEqual({
    model: null,
    effort: null,
    speed: "standard",
  });
});

test("une réponse perdue rejoue la même création avec le même réglage, sans doublon", async ({
  page,
}) => {
  const name = uniqueName("Réponse perdue");
  const sent = choiceCommands(page);
  let lost = false;
  await page.route("**/api/commands", async (route) => {
    if (!lost && route.request().postDataJSON()?.type === "bot.create") {
      lost = true;
      await route.fetch();
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  const sheet = await newSheet(page, TOOLS);
  await sheet.getByLabel("Nom", { exact: true }).fill(name);
  await chooseModel(sheet, withoutUltra);
  await chip(levels(sheet, "Réflexion"), "max").click();
  await sheet.getByRole("button", { name: "Créer et discuter" }).click();
  await expect(
    sheet.getByRole("button", { name: "Réessayer la même action" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Nouveau personnage" })
    .click();
  await expect(
    sheet.getByRole("button", { name: /^Modèle de / }),
  ).toContainText(withoutUltra.id);
  await expect(level(levels(sheet, "Réflexion"), "max")).toBeChecked();
  await sheet.getByRole("button", { name: "Réessayer la même action" }).click();
  await expect(sheet).toHaveCount(0);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[0]).toMatchObject({ model: withoutUltra.id, effort: "max" });
  expect(await choiceOf(page, TOOLS, name)).toEqual({
    model: withoutUltra.id,
    effort: "max",
    speed: "standard",
  });
});

test("la modification attend la confirmation avant un autre réglage", async ({
  page,
}) => {
  const name = uniqueName("Confirmation");
  await page.goto(TOOLS);
  await createByCommand(page, name, { model: withUltra.id });
  await page.reload();
  const sheet = await editSheet(page, name);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received = () => {};
  const started = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route(
    "**/api/commands",
    async (route) => {
      if (route.request().postDataJSON()?.type !== "bot.configure")
        return route.continue();
      const response = await route.fetch();
      received();
      await held;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await chip(levels(sheet, "Réflexion"), "high").click();
  await started;
  try {
    await expect
      .soft(level(levels(sheet, "Vitesse"), "priority"))
      .toBeDisabled({ timeout: 1000 });
    await expect
      .soft(sheet.getByRole("button", { name: /^Modèle de / }))
      .toBeDisabled({ timeout: 1000 });
  } finally {
    release();
  }
  await expect(level(levels(sheet, "Réflexion"), "high")).toBeChecked();
  await chip(levels(sheet, "Vitesse"), "priority").click();
  await expect(level(levels(sheet, "Vitesse"), "priority")).toBeChecked();
  expect(await choiceOf(page, TOOLS, name)).toEqual({
    model: withUltra.id,
    effort: "high",
    speed: "priority",
  });
});

test("un résultat inconnu fige aussi le modèle et réessaie le même réglage", async ({
  page,
}) => {
  const name = uniqueName("Incertain");
  await page.goto(TOOLS);
  await createByCommand(page, name, { model: withUltra.id });
  await page.reload();
  const sent = choiceCommands(page);
  const sheet = await editSheet(page, name);
  let lost = false;
  await page.route("**/api/commands", async (route) => {
    if (!lost && route.request().postDataJSON()?.type === "bot.configure") {
      lost = true;
      await route.fetch();
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await chip(levels(sheet, "Réflexion"), "ultra").click();
  const retry = sheet.getByRole("button", { name: "Réessayer la même action" });
  await expect(retry).toBeVisible();
  await expect(
    sheet.getByRole("button", { name: /^Modèle de / }),
  ).toBeDisabled();
  await expect(level(levels(sheet, "Réflexion"), "max")).toBeDisabled();
  await retry.click();
  await expect(retry).toHaveCount(0);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  await chooseModel(sheet, withoutUltra);
  await expect(
    sheet.getByRole("button", { name: /^Modèle de / }),
  ).toContainText(withoutUltra.id);
  expect(sent).toHaveLength(3);
  expect(sent[2].requestId).not.toBe(sent[0].requestId);
  expect(await choiceOf(page, TOOLS, name)).toEqual({
    model: withoutUltra.id,
    effort: null,
    speed: "standard",
  });
});
