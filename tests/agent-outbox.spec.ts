import { test, expect } from "@playwright/test";
import type {
  AgentCommand,
  AgentsView,
  ProjectView,
} from "../server/src/agent-protocol";
import type { KeyValueStorage } from "../server/web/drafts";
import type { AgentsOutcome } from "../src/port";
import { describeCommand } from "../src/agent-outbox/describe";
import {
  OUTBOX_KEY,
  commandOwners,
  openAgentOutbox,
  type OutboxEntry,
} from "../src/agent-outbox/store";

const unknown: AgentsOutcome = { kind: "unknown", message: "Résultat inconnu" };
const view: AgentsView = {
  rev: 1,
  projects: [],
  missions: [],
  queue: [],
  engine: { state: "idle" },
};
const accepted: AgentsOutcome = {
  kind: "accepted",
  result: { id: "qa-id" },
  replayed: true,
  view,
};
const refused: AgentsOutcome = {
  kind: "refused",
  view,
  code: "state",
  message: "Refus de recette",
};
const rejected: AgentsOutcome = {
  kind: "rejected",
  status: 403,
  message: "Session expirée",
};

function mission(
  goal = "Mission de recette",
): Extract<AgentCommand, { type: "mission.create" }> {
  return {
    type: "mission.create",
    requestId: crypto.randomUUID(),
    projectId: "qa-project",
    goal,
    mode: "direct",
    model: null,
    effort: null,
  };
}
function browser() {
  const items = new Map<string, string>();
  const storage: KeyValueStorage = {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem(key, value) {
      if (state.full) throw new Error("QuotaExceededError");
      items.set(key, value);
    },
    removeItem(key) {
      items.delete(key);
    },
  };
  const state = { storage, items, full: false };
  return state;
}
function service(...outcomes: AgentsOutcome[]) {
  const sent: AgentCommand[] = [];
  return {
    sent,
    async send(command: AgentCommand) {
      sent.push(command);
      return outcomes.shift() ?? unknown;
    },
  };
}
function page(
  storage: KeyValueStorage | null,
  send: (command: AgentCommand) => Promise<AgentsOutcome>,
  spaceId = "espace-a",
) {
  return openAgentOutbox({ spaceId, storage, send });
}
function seed(storage: KeyValueStorage, entry: OutboxEntry) {
  storage.setItem(
    `${OUTBOX_KEY}${encodeURIComponent(entry.spaceId)}|${entry.command.requestId}`,
    JSON.stringify(entry),
  );
}

test("la commande est conservée avant l’envoi et se retrouve après rechargement sans renvoi automatique", async () => {
  const { storage } = browser();
  const command = mission();
  let savedDuringPost: readonly unknown[] = [];
  const first = page(storage, async () => {
    savedDuringPost = page(storage, service().send).pending();
    return unknown;
  });
  expect((await first.run(command, [])).kind).toBe("unknown");
  expect(savedDuringPost).toMatchObject([{ command }]);
  expect(first.pending()).toMatchObject([
    { command, sending: false, durable: true },
  ]);

  const pc = service(accepted);
  const reloaded = page(storage, pc.send);
  expect(pc.sent).toHaveLength(0);
  const [saved] = reloaded.pending();
  expect(saved?.command).toEqual(command);
  expect(await reloaded.run(saved!.command, [])).toBe(accepted);
  expect(pc.sent).toEqual([command]);
  expect(reloaded.pending()).toHaveLength(0);
  expect(page(storage, service().send).pending()).toHaveLength(0);
});

test("seul un résultat définitif retire la commande", async () => {
  for (const outcome of [accepted, refused, rejected]) {
    const { storage } = browser();
    const command = mission();
    const outbox = page(storage, service(unknown, outcome).send);
    await outbox.run(command, []);
    expect(outbox.holds(command)).toBe(true);
    expect(await outbox.run(command, [])).toBe(outcome);
    expect(outbox.holds(command)).toBe(false);
    expect(page(storage, service().send).pending()).toHaveLength(0);
  }
});

test("une commande identique reprend l’identifiant d’origine, même après une résolution ailleurs", async () => {
  const { storage } = browser();
  const original = mission();
  const pc = service();
  const outbox = page(storage, pc.send);
  await outbox.run(original, []);
  const twin = { ...mission(), requestId: crypto.randomUUID() };
  await outbox.run(twin, []);
  expect(pc.sent).toEqual([original, original]);
  expect(outbox.pending()).toHaveLength(1);

  const elsewhere = page(storage, service(accepted).send);
  await elsewhere.run(original, []);
  outbox.sync();
  expect(outbox.holds(twin)).toBe(false);
  await outbox.run(twin, []);
  expect(pc.sent.map((command) => command.requestId)).toEqual([
    original.requestId,
    original.requestId,
    original.requestId,
  ]);
});

test("une autre commande est refusée sans envoi et sans toucher à la commande en attente", async () => {
  const { storage } = browser();
  const original = mission();
  const pc = service();
  const outbox = page(storage, pc.send);
  await outbox.run(original, []);

  const other = await outbox.run(mission("Un autre objectif"), []);
  expect(other).toMatchObject({ kind: "rejected", status: 409 });
  expect(other.kind === "rejected" && other.message).toContain(
    "Réessayer la commande en attente",
  );
  const forged = await outbox.run({ ...original, goal: "Objectif changé" }, []);
  expect(forged).toMatchObject({ kind: "rejected", status: 409 });
  expect(pc.sent).toEqual([original]);
  expect(page(storage, service().send).pending()).toMatchObject([
    { command: original },
  ]);
});

test("une commande incertaine ne bloque pas l’arrêt d’une mission", async () => {
  const { storage } = browser();
  const original = mission();
  const pc = service(unknown, accepted);
  const outbox = page(storage, pc.send);
  await outbox.run(original, []);
  const stop: AgentCommand = {
    type: "mission.stop",
    requestId: crypto.randomUUID(),
    missionId: "mission-active",
  };
  expect(await outbox.run(stop, [])).toBe(accepted);
  expect(pc.sent).toEqual([original, stop]);
  expect(outbox.pending()).toMatchObject([{ command: original }]);
});

test("deux envois simultanés de la même commande ne font qu’un POST", async () => {
  const { storage } = browser();
  const command = mission();
  const pc = service(accepted);
  const outbox = page(storage, pc.send);
  const both = [
    outbox.run(command, []),
    outbox.run({ ...command }, []),
    outbox.run({ ...command, requestId: crypto.randomUUID() }, []),
  ];
  const during = await outbox.run(mission("Pendant l’envoi"), []);
  expect(during).toMatchObject({ kind: "rejected", status: 409 });
  expect(await Promise.all(both)).toEqual([accepted, accepted, accepted]);
  expect(pc.sent).toEqual([command]);
});

test("sans stockage, la commande reste dans la page et le signale", async () => {
  const quota = browser();
  quota.full = true;
  for (const storage of [quota.storage, null]) {
    const command = mission();
    const pc = service(unknown, accepted);
    const outbox = page(storage, pc.send);
    await outbox.run(command, []);
    expect(outbox.pending()).toMatchObject([{ command, durable: false }]);
    expect(page(storage, service().send).pending()).toHaveLength(0);
    expect(await outbox.run(command, [])).toBe(accepted);
    expect(pc.sent).toEqual([command, command]);
    expect(outbox.pending()).toHaveLength(0);
  }
});

test("une autre page apprend la résolution et ignore les données invalides", async () => {
  const { storage, items } = browser();
  const command = mission();
  const first = page(storage, service(unknown, accepted).send);
  await first.run(command, []);
  const second = page(storage, service().send);
  let notified = 0;
  second.subscribe(() => notified++);
  expect(second.pending()).toHaveLength(1);
  await first.run(command, []);
  second.sync();
  expect(second.pending()).toHaveLength(0);
  expect(notified).toBe(1);

  const valid = { spaceId: "espace-a", command: mission(), ownerBotIds: [] };
  const key = (id: string) => `${OUTBOX_KEY}espace-a|${id}`;
  items.set(key("illisible-1"), "{");
  items.set(
    key(valid.command.requestId),
    JSON.stringify({ ...valid, spaceId: "espace-b" }),
  );
  items.set(key("autre-identifiant"), JSON.stringify(valid));
  items.set(
    key("commande-invalide"),
    JSON.stringify({
      ...valid,
      command: { ...valid.command, requestId: "commande-invalide", goal: "" },
    }),
  );
  expect(page(storage, service().send).pending()).toHaveLength(0);
  expect(items.size).toBe(4);
});

test("une commande inconnue d’un autre onglet devient visible à la synchronisation", async () => {
  const { storage } = browser();
  const second = page(storage, service().send);
  const first = page(storage, service().send);
  const command = mission();
  await first.run(command, []);
  second.sync();
  expect(second.pending()).toMatchObject([{ command, durable: true }]);
});

test("une purge reçue avant l’événement de stockage ne cache pas une commande étrangère", async () => {
  const { storage } = browser();
  const observing = page(storage, service().send);
  const command = mission();
  await page(storage, service().send).run(command, ["nova"]);
  observing.purge(["ancien-bot"]);
  observing.sync();
  expect(observing.holds(command)).toBe(true);
  expect(observing.pending()).toMatchObject([{ command, durable: true }]);
});

test("les espaces sont séparés et la suppression d’un bot retire ses commandes", async () => {
  const { storage } = browser();
  const fromNova = mission("Objectif venu du fil de Nova");
  const fromMino = mission("Objectif venu du fil de Mino");
  seed(storage, {
    spaceId: "espace-a",
    command: fromNova,
    ownerBotIds: ["nova"],
  });
  seed(storage, {
    spaceId: "espace-a",
    command: fromMino,
    ownerBotIds: ["mino"],
  });
  expect(page(storage, service().send, "espace-b").pending()).toHaveLength(0);

  const outbox = page(storage, service().send);
  expect(outbox.pending()).toHaveLength(2);
  outbox.purge(["nova"]);
  expect(outbox.pending()).toMatchObject([{ command: fromMino }]);
  expect(page(storage, service().send).pending()).toMatchObject([
    { command: fromMino },
  ]);
});

test("une commande appartient au responsable et au fil d’origine de son objectif", () => {
  const known = {
    messages: [{ id: "proposition", threadBotId: "nova" }],
    missions: [
      {
        id: "qa-mission",
        originMessageId: "proposition",
        lead: { botId: "atlas" },
      },
    ],
  };
  expect(
    commandOwners(
      {
        ...mission(),
        leadBotId: "atlas",
        origin: { messageId: "proposition" },
      },
      known,
    ),
  ).toEqual(["atlas", "nova"]);
  expect(
    commandOwners(
      {
        type: "mission.revise",
        requestId: crypto.randomUUID(),
        missionId: "qa-mission",
        goal: "Objectif révisé",
        start: false,
      },
      known,
    ),
  ).toEqual(["atlas", "nova"]);
  expect(
    commandOwners(
      {
        type: "project.archive",
        requestId: crypto.randomUUID(),
        projectId: "qa-project",
      },
      known,
    ),
  ).toEqual([]);
});

test("la commande en attente se lit avec son type et ses valeurs", () => {
  expect(
    describeCommand(
      {
        ...mission("Préparer la recette"),
        mode: "coordinated",
        leadBotId: "nova",
      },
      {
        bots: [{ id: "nova", name: "Nova" }],
        projects: [{ id: "qa-project", name: "Projet de recette" }],
        missions: [],
      },
    ),
  ).toEqual({
    label: "Confier une mission",
    fields: [
      ["Projet", "Projet de recette"],
      ["Objectif", "Préparer la recette"],
      ["Organisation", "Avec un responsable"],
      ["Responsable", "Nova"],
    ],
  });
});

const retryPending = {
  name: "Réessayer la commande en attente",
  exact: true,
} as const;

test("après une navigation, le panneau racine reprend la commande et bloque toute autre commande", async ({
  page,
}) => {
  await page.route("**/api/agents/view*", (route) =>
    route.fulfill({ json: view }),
  );
  const commands: AgentCommand[] = [];
  await page.route("**/api/agents/commands", (route) => {
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) return route.abort();
    return route.fulfill({
      json: { ok: true, id: "qa-project", replayed: true, view },
    });
  });
  await page.goto("/");
  const add = async (path: string) => {
    await page.getByRole("button", { name: "Projets", exact: true }).click();
    await page
      .getByRole("button", { name: "Ajouter un dossier", exact: true })
      .click();
    await page.getByLabel("Chemin complet du dossier").fill(path);
    await page
      .getByRole("button", { name: "Confier ce dossier", exact: true })
      .click();
  };
  const dialog = page.getByRole("dialog");
  await add("/tmp/ezra-reprise");
  await expect(dialog.getByRole("alert")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.getByRole("button", { name: "Missions", exact: true }).click();
  const recovery = page.getByRole("region", {
    name: "Commandes en attente de confirmation",
  });
  await expect(recovery).toContainText("Ajouter un dossier");
  await expect(recovery).toContainText("/tmp/ezra-reprise");

  await add("/tmp/ezra-autre-dossier");
  await expect(dialog.getByRole("alert")).toContainText("HTTP 409");
  await expect(dialog.getByRole("alert")).toContainText(retryPending.name);
  expect(commands).toHaveLength(1);
  await dialog.getByRole("button", { name: "Fermer", exact: true }).click();

  await recovery.getByRole("button", retryPending).click();
  await expect(recovery.getByRole("status")).toContainText("déjà accepté");
  await expect(recovery.getByRole("button", retryPending)).toHaveCount(0);
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
});

test("une reprise par le panneau racine libère le formulaire resté ouvert", async ({
  page,
}) => {
  const project: ProjectView = {
    id: "qa-project",
    name: "Projet de recette",
    path: "/tmp/ezra-qa-project",
    git: true,
    checkCommand: null,
    archived: false,
    createdAt: "2026-01-01",
    leadBotId: null,
  };
  await page.route("**/api/agents/view*", (route) =>
    route.fulfill({ json: { ...view, projects: [project] } }),
  );
  const commands: AgentCommand[] = [];
  await page.route("**/api/agents/commands", (route) => {
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) return route.abort();
    return route.fulfill({
      json: { ok: true, id: "qa-mission", view: { ...view, rev: 2 } },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Missions", exact: true }).click();
  await page
    .getByRole("button", { name: "Nouvelle mission", exact: true })
    .click();
  await page.getByLabel("Dossier de la mission").selectOption(project.id);
  await page.getByLabel("Objectif à confier").fill("Objectif repris ailleurs");
  await page
    .getByRole("button", { name: "Confier la mission", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("inconnu");
  await expect(page.getByLabel("Objectif à confier")).toBeDisabled();

  await page.getByRole("button", retryPending).click();
  await expect(page.getByLabel("Objectif à confier")).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText(/Cette commande a été réglée ailleurs/),
  ).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
});
