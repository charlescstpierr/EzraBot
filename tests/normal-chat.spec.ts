import { test, expect } from "@playwright/test";
import type { AppView } from "../server/src/protocol";

test("un échange ordinaire attend à gauche sans carte documentaire", async ({
  page,
  request,
}) => {
  const view: AppView = await (await request.get("/api/view")).json();
  view.activeBotId = "mino";
  view.tasks = [];
  view.messages = [
    {
      id: "salut",
      threadBotId: "mino",
      botId: "mino",
      role: "user",
      text: "Allo",
      workId: "chat",
      mentions: [],
      attachments: [],
      createdAt: "2026-11-12T14:00:00Z",
      stamp: null,
      taskStep: null,
      handoff: null,
    },
  ];
  view.works = [
    {
      id: "chat",
      threadBotId: "mino",
      taskId: null,
      botId: "mino",
      requestMessageId: "salut",
      state: "pending",
      title: "",
      createdAt: "2026-11-12T14:00:00Z",
      updatedAt: "2026-11-12T14:00:00Z",
      attempt: null,
      attempts: 0,
      versions: [],
      proposals: [],
    },
  ];
  await page.route("**/api/view*", (route) => route.fulfill({ json: view }));
  await page.goto("/");
  await expect(
    page.getByRole("main").getByText("Allo", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Aucune version enregistrée.", { exact: true }),
  ).toHaveCount(0);
  const waiting = page.getByRole("status").filter({ hasText: "Mino" });
  await expect(waiting).toContainText("Prépare une réponse");
  const pendingBox = await waiting.boundingBox();
  const userBox = await page
    .locator(".ez-chat-user .ez-chat-bubble")
    .boundingBox();
  expect(pendingBox!.x).toBeLessThan(userBox!.x);
  await expect(waiting.locator(".mascot")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Annuler", exact: true }),
  ).toBeVisible();
  view.works[0].state = "done";
  view.rev++;
  view.messages.push({
    ...view.messages[0],
    id: "reponse",
    role: "assistant",
    text: "Bonjour !",
  });
  await expect(
    page.getByRole("main").getByText("Bonjour !", { exact: true }),
  ).toBeVisible();
  await expect(waiting).toHaveCount(0);
  await expect(page.locator(".ez-doc-card")).toHaveCount(0);
});
