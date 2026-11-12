import { test, expect } from "@playwright/test";
import type {
  AgentCommand,
  AgentsView,
  ProjectView,
} from "../server/src/agent-protocol";

test("ajout rejouable, contrôle refusé puis corrigé et archivage confirmé", async ({
  page,
}) => {
  const project: ProjectView = {
    id: "qa-project",
    name: "Projet de recette",
    path: "/tmp/ezra-projet-recette",
    git: false,
    checkCommand: null,
    archived: false,
    createdAt: "2026-01-01",
    leadBotId: null,
  };
  const view: AgentsView = {
    rev: 1,
    projects: [],
    missions: [],
    queue: [],
    engine: { state: "unavailable", message: "Fixture sans IA" },
  };
  await page.route("**/api/agents/view*", (route) =>
    route.fulfill({ json: view }),
  );
  const commands: AgentCommand[] = [];
  await page.route("**/api/agents/commands", (route) => {
    const command: AgentCommand = route.request().postDataJSON();
    commands.push(command);
    if (command.type === "project.add" && commands.length === 1)
      return route.abort();
    if (command.type === "project.add") view.projects = [project];
    if (command.type === "project.update") {
      if (command.checkCommand.includes("|"))
        return route.fulfill({
          status: 409,
          json: {
            ok: false,
            code: "invalid_command",
            message: "Commande sans shell requise",
            view,
          },
        });
      project.checkCommand = ["npm", "test"];
    }
    if (command.type === "project.archive") project.archived = true;
    view.rev++;
    return route.fulfill({ json: { ok: true, id: project.id, view } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Projets", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Tout commence par un dossier." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Ajouter un dossier", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Chemin complet du dossier").fill(project.path);
  await dialog.getByLabel("Nom affiché").fill(project.name);
  await dialog.locator("form").evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Chemin complet du dossier")).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Fermer", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Réessayer le même envoi" }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  await expect(
    page.getByText("Sans commande de contrôle", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Pas un dépôt Git/)).toBeVisible();
  await page.getByRole("button", { name: "Modifier le contrôle" }).click();
  await page.getByLabel("Commande de contrôle").fill("npm test | cat");
  await page.getByRole("button", { name: "Enregistrer le contrôle" }).click();
  await expect(page.getByRole("alert")).toContainText("invalid_command");
  await expect(page.getByLabel("Commande de contrôle")).toHaveValue(
    "npm test | cat",
  );
  await page.getByLabel("Commande de contrôle").fill("npm test");
  await page.getByRole("button", { name: "Enregistrer le contrôle" }).click();
  await expect(page.getByText('["npm","test"]', { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Archiver", exact: true }).click();
  expect(
    commands.filter((command) => command.type === "project.archive"),
  ).toHaveLength(0);
  await expect(
    page.getByText(/Le dossier et ses fichiers restent sur le PC/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Garder le projet" }).click();
  await page.getByRole("button", { name: "Archiver", exact: true }).click();
  await page.getByRole("button", { name: "Confirmer l’archivage" }).click();
  await expect(
    page.getByText("Projets archivés · 1", { exact: true }),
  ).toBeVisible();
  expect(
    commands.filter((command) => command.type === "project.archive"),
  ).toHaveLength(1);
  expect(commands.every((command) => command.type.startsWith("project."))).toBe(
    true,
  );
});

test("aller vers les missions prépare le formulaire sans démarrer de travail", async ({
  page,
}) => {
  const project: ProjectView = {
    id: "qa-project",
    name: "Projet de recette",
    path: "/tmp/ezra-projet-recette",
    git: true,
    checkCommand: ["node", "--test"],
    archived: false,
    createdAt: "2026-01-01",
    leadBotId: null,
  };
  const view: AgentsView = {
    rev: 1,
    projects: [project],
    missions: [],
    queue: [],
    engine: { state: "unavailable" },
  };
  await page.route("**/api/agents/view*", (route) =>
    route.fulfill({ json: view }),
  );
  let commands = 0;
  await page.route("**/api/agents/commands", (route) => {
    commands++;
    return route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Projets", exact: true }).click();
  await expect(
    page.getByText("Dépôt Git détecté", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Préparer une mission", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Nouvelle mission", exact: true })
    .click();
  await expect(page.getByLabel("Objectif à confier")).toBeVisible();
  expect(commands).toBe(0);
});
