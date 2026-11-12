import { test, expect, type Page } from "@playwright/test";
import type {
  AgentCommand,
  AgentsView,
  MissionDetail,
  MissionResponse,
} from "../server/src/agent-protocol";
import type { AppView, MessageView } from "../server/src/protocol";

const project = {
  id: "qa-project",
  name: "Projet de recette",
  path: "/tmp/ezra-qa-project",
  git: true,
  checkCommand: ["npm", "test"],
  archived: false,
  createdAt: "2026-01-01",
  leadBotId: null,
};
function mission(): MissionDetail {
  return {
    id: "qa-mission",
    projectId: project.id,
    title: "Mission de recette contrôlée",
    originMessageId: null,
    status: "waiting",
    goalRev: 1,
    attemptsUsed: 1,
    maxAttempts: 3,
    threadId: null,
    acceptedAttemptId: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    mode: "coordinated",
    parentId: null,
    lead: null,
    waiting: "Choisir la prochaine étape",
    tree: { used: 4, max: 8 },
    goals: [
      {
        rev: 1,
        text: "Un objectif explicite",
        createdAt: "2026-01-01",
        origin: "person",
        decisionId: null,
      },
    ],
    attempts: [],
    events: [
      {
        id: "qa-event",
        attemptId: "qa-attempt",
        seq: 1,
        at: "2026-01-01",
        kind: "blocked_tool",
        data: { message: "Outil refusé dans cette fixture" },
      },
    ],
    eventsOmitted: 2,
    can: {
      stop: false,
      resume: false,
      continue: true,
      revise: true,
      review: false,
      accept: null,
      budget: true,
    },
    acceptBlocked: "Contrôle non confirmé",
    live: null,
    children: [],
    decisions: [
      {
        id: "qa-decision",
        n: 1,
        attemptId: "qa-attempt",
        attemptN: 1,
        goalRev: 1,
        kind: null,
        decision: null,
        raw: "Décision brute de recette",
        outcome: "refused",
        refusal: "Décision illisible",
        childId: null,
        createdAt: "2026-01-01",
      },
    ],
    origin: null,
    parent: null,
    tokens: { total: 12, unknownAttempts: 1 },
    synthesis: null,
  };
}
async function fixtures(page: Page, detail = mission()) {
  const view: AgentsView = {
    rev: 1,
    projects: [project],
    missions: [],
    engine: { state: "unavailable", message: "Fixture sans appel IA" },
    queue: [],
  };
  await page.route("**/api/agents/view*", (route) =>
    route.fulfill({ json: view }),
  );
  await page.route("**/api/agents/missions/*", (route) =>
    route.fulfill({
      json: {
        rev: view.rev,
        mission: detail,
        project,
      } satisfies MissionResponse,
    }),
  );
  return view;
}
async function newMission(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Missions", exact: true }).click();
  await page
    .getByRole("button", { name: "Nouvelle mission", exact: true })
    .click();
}

test("préparer ne démarre rien et un résultat inconnu garde la même commande", async ({
  page,
}) => {
  const detail = mission();
  const view = await fixtures(page, detail);
  const commands: AgentCommand[] = [];
  await page.route("**/api/agents/commands", async (route) => {
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) return route.abort();
    view.missions = [detail];
    view.rev++;
    return route.fulfill({
      json: { ok: true, id: detail.id, replayed: true, view },
    });
  });
  await newMission(page);
  expect(commands).toHaveLength(0);
  await expect(page.getByLabel("Dossier de la mission")).toHaveValue("");
  await page.getByLabel("Dossier de la mission").selectOption(project.id);
  await page.getByLabel("Objectif à confier").fill("Préparer la recette");
  await page
    .getByLabel("Organisation de la mission")
    .selectOption("coordinated");
  const lead = page.getByLabel("Responsable de la mission");
  await expect(lead.locator('option[value="mino"]')).toHaveCount(0);
  await lead.selectOption({ label: "Nova" });
  await page.locator(".missions-form").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(page.getByRole("alert")).toContainText("inconnu");
  await expect(page.getByLabel("Objectif à confier")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Fermer la préparation" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Réessayer le même envoi" }).click();
  await expect(
    page.getByRole("heading", { name: detail.title, exact: true }),
  ).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[0]).toMatchObject({
    type: "mission.create",
    mode: "coordinated",
    leadBotId: "nova",
  });
  await expect(page.getByText("Essais locaux · 1/3")).toBeVisible();
  await expect(page.getByText("Budget partagé de l’arbre · 4/8")).toBeVisible();
  await expect(page.getByText(/consommation inconnue pour 1/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Arrêter", exact: true }),
  ).toHaveCount(0);
  await page
    .getByText("Décision 1 · illisible · refusée", { exact: true })
    .click();
  await expect(
    page.getByText("Décision brute de recette", { exact: true }),
  ).toBeVisible();
  await page
    .getByText("Activité des outils · 1 événements", { exact: true })
    .click();
  await page
    .getByText("blocked_tool · 2026-01-01 · #1", { exact: true })
    .click();
  await expect(page.getByText(/Outil refusé dans cette fixture/)).toBeVisible();
});

test("une précision, une révision sans relance et un refus restent distincts", async ({
  page,
}) => {
  const detail = mission();
  const view = await fixtures(page, detail);
  view.missions = [detail];
  const commands: AgentCommand[] = [];
  await page.route("**/api/agents/commands", (route) => {
    commands.push(route.request().postDataJSON());
    return route.fulfill({
      status: 409,
      json: {
        ok: false,
        code: "state",
        message: "Refus de recette persistant",
        view,
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Missions", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(detail.title) }).click();
  await page
    .getByRole("button", { name: "Préciser à Mino", exact: true })
    .click();
  await page.getByLabel("Précision pour Mino").fill("Garder la contrainte");
  await page
    .getByRole("button", { name: "Envoyer la précision", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "state · Refus de recette persistant",
  );
  expect(commands[0]).toMatchObject({
    type: "mission.continue",
    note: "Garder la contrainte",
  });
  await page
    .getByRole("button", { name: "Modifier l’objectif", exact: true })
    .click();
  await page.getByLabel("Nouvel objectif").fill("Objectif révisé");
  await expect(
    page.getByLabel("Relancer après enregistrement"),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "Enregistrer l’objectif", exact: true })
    .click();
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toMatchObject({
    type: "mission.revise",
    goal: "Objectif révisé",
    start: false,
  });
  await expect(page.getByLabel("Nouvel objectif")).toHaveValue(
    "Objectif révisé",
  );
});

test("la proposition conserve son origine et ouvre la mission dédupliquée", async ({
  page,
}) => {
  const detail = mission();
  detail.originMessageId = "qa-proposal";
  const view = await fixtures(page, detail);
  const proposal: MessageView = {
    id: "qa-proposal",
    threadBotId: "mino",
    role: "assistant",
    botId: "mino",
    text: "Proposition de recette",
    workId: "",
    attachments: [],
    mentions: [],
    createdAt: "2026-01-01",
    stamp: null,
    taskStep: null,
    handoff: {
      goal: "Vérifier une proposition",
      coordinated: false,
      why: "Travail dans le dossier autorisé",
    },
  };
  await page.route("**/api/view*", async (route) => {
    const response = await route.fetch();
    const app: AppView = await response.json();
    app.messages.push(proposal);
    await route.fulfill({ json: app });
  });
  const commands: AgentCommand[] = [];
  await page.route("**/api/agents/commands", (route) => {
    commands.push(route.request().postDataJSON());
    view.missions = [detail];
    view.rev++;
    return route.fulfill({ json: { ok: true, id: detail.id, view } });
  });
  await page.goto("/");
  const card = page.getByRole("region", { name: "Mission avec Mino" });
  await card.getByLabel("Dossier de la mission").selectOption(project.id);
  await card
    .getByRole("button", { name: "Confier la mission", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: detail.title, exact: true }),
  ).toBeVisible();
  expect(commands[0]).toMatchObject({
    type: "mission.create",
    origin: { messageId: proposal.id },
  });
  await page.locator(".threads").getByRole("button", { name: /Mino/ }).click();
  await expect(
    card.getByRole("button", { name: /Consulter la mission/ }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Confier la mission", exact: true }),
  ).toHaveCount(0);
});
