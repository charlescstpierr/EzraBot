import { test, expect, type Page } from "@playwright/test";
import type { AppView, MessageView, WorkView } from "../server/src/protocol";

const toolsBase = `http://127.0.0.1:${process.env.MINO_QA_TOOLS_PORT ?? "4398"}`;

function message(
  id: string,
  role: MessageView["role"],
  text: string,
  minute: number,
): MessageView {
  return {
    id,
    threadBotId: "mino",
    botId: "mino",
    role,
    text,
    workId: `w-${id}`,
    mentions: [],
    attachments: [],
    createdAt: new Date(Date.UTC(2026, 10, 12, 14, minute)).toISOString(),
    stamp:
      role === "assistant"
        ? {
            model: "gpt-6.1-sol",
            effort: "medium",
            speed: "standard",
            threadId: "t",
            turnId: "u",
          }
        : null,
    taskStep: null,
    handoff: null,
  };
}

async function thread(page: Page, messages: MessageView[]) {
  const view: AppView = await (await page.request.get("/api/view")).json();
  view.activeBotId = "mino";
  view.tasks = [];
  view.works = [];
  view.messages = messages;
  await page.route("**/api/view*", (route) => route.fulfill({ json: view }));
  return view;
}

const gaze = (page: Page) =>
  page
    .locator(".ez-chat-scroll .mascot-live .mascot-gaze")
    .evaluate((node) =>
      ((node as SVGGElement).style.transform.match(/-?[\d.]+/g) ?? []).map(
        (n) => Math.round(Number(n) * 10) / 10 || 0,
      ),
    );

test("une seule mascotte vivante suit le pointeur à gauche de la dernière réponse", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await thread(page, [
    message("q1", "user", "Bonjour", 0),
    message("a1", "assistant", "Salut, que puis-je faire ?", 1),
    message("q2", "user", "Un plan de semaine", 2),
    message("a2", "assistant", "Voici un plan **simple**.", 3),
  ]);
  await page.goto("/");
  const chat = page.locator(".ez-chat-scroll");
  await expect(chat.getByText("Voici un plan")).toBeVisible();
  await expect(chat.locator(".mascot")).toHaveCount(2);
  await expect(chat.getByText(/gpt-6\.1-sol|medium · standard/)).toHaveCount(0);
  const live = chat.locator(".mascot-live");
  await expect(live).toHaveAttribute("data-activity", "idle");
  await expect(live.locator(".mascot-eyes")).toHaveCount(1);
  const reply = await chat
    .locator('[data-message-id="a2"] .ez-chat-bubble')
    .boundingBox();
  const box = (await live.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(reply!.x);
  expect(Math.abs(box.y + box.height - reply!.y - reply!.height)).toBeLessThan(
    2,
  );

  await page.mouse.move(1270, box.y + box.height / 2);
  await expect.poll(() => gaze(page)).toEqual([3.2, 0]);
  await page.mouse.move(0, box.y + box.height / 2);
  await expect.poll(() => gaze(page)).toEqual([-3.2, 0]);
  await page.mouse.move(box.x + box.width / 2, 790);
  await expect.poll(() => gaze(page)).toEqual([0, 3.2]);
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2);
  await expect.poll(() => gaze(page)).toEqual([0.8, 0]);
});

test("le mouvement réduit garde le regard neutre et la mascotte immobile", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await thread(page, [
    message("q1", "user", "Bonjour", 0),
    message("a1", "assistant", "Salut.", 1),
  ]);
  await page.goto("/");
  const eyes = page.locator(".ez-chat-scroll .mascot-eyes");
  await expect(eyes).toHaveCount(1);
  await page.mouse.move(5, 5);
  await page.mouse.move(900, 600);
  await expect.poll(() => gaze(page)).toEqual([0, 0]);
  expect(
    await eyes.evaluate((node) => getComputedStyle(node).animationName),
  ).toBe("none");
});

test("la réponse partielle grandit sans déplacer une lecture plus haut, puis laisse une seule réponse finale", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  const history = Array.from({ length: 12 }, (_, i) =>
    message(
      `h${i}`,
      i % 2 ? "assistant" : "user",
      `Échange ${i}\n\n${"Ligne.\n\n".repeat(3)}`,
      i,
    ),
  );
  const view = await thread(page, [
    ...history,
    message("ask", "user", "Et ensuite ?", 20),
  ]);
  const work: WorkView = {
    id: "w-live",
    threadBotId: "mino",
    taskId: null,
    botId: "mino",
    requestMessageId: "ask",
    state: "running",
    title: "",
    createdAt: history[0].createdAt,
    updatedAt: history[0].createdAt,
    attempt: null,
    attempts: 1,
    versions: [],
    proposals: [],
    replyPreview: null,
  };
  view.works = [work];
  await page.goto("/");
  const scroll = page.locator(".ez-chat-scroll");
  const status = scroll.getByRole("status");
  await expect(status).toContainText("Mino prépare une réponse");
  await expect(status.locator(".mascot-live")).toHaveAttribute(
    "data-activity",
    "thinking",
  );
  await expect(scroll.locator(".mascot")).toHaveCount(7);
  await expect(scroll.locator(".mascot-live")).toHaveCount(1);

  work.replyPreview = "Ensuite, **on range** le bureau";
  view.rev++;
  await expect(scroll.locator(".ez-chat-partial strong")).toHaveText(
    "on range",
  );
  await expect(status).toContainText("Mino écrit");
  await expect(status.locator(".mascot-live")).toHaveAttribute(
    "data-activity",
    "speaking",
  );
  await expect
    .poll(() =>
      scroll.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight),
    )
    .toBeLessThan(4);

  await scroll.evaluate((n) => (n.scrollTop = 0));
  await page.waitForTimeout(100);
  work.replyPreview = `${work.replyPreview}, puis on planifie lundi.`;
  view.rev++;
  await expect(scroll.getByText("puis on planifie lundi")).toBeAttached();
  expect(await scroll.evaluate((n) => n.scrollTop)).toBe(0);

  work.state = "done";
  work.replyPreview = null;
  view.messages.push({
    ...message(
      "final",
      "assistant",
      "Ensuite, **on range** le bureau, puis on planifie lundi.",
      21,
    ),
    workId: work.id,
  });
  view.rev++;
  await expect(scroll.locator(".ez-chat-partial")).toHaveCount(0);
  await expect(scroll.getByText("puis on planifie lundi")).toHaveCount(1);
  await expect(scroll.getByRole("status")).toHaveCount(0);
  await expect(scroll.locator(".mascot-live")).toHaveAttribute(
    "data-activity",
    "idle",
  );
});

test("Mino se modifie vraiment : personnalité et modèle restent après rechargement", async ({
  page,
}) => {
  await page.goto(toolsBase);
  await page.locator(".threads").getByRole("button", { name: /^Mino/ }).click();
  await expect(
    page.locator("main > header").getByRole("button", { name: /^Modèle/ }),
  ).toHaveCount(0);
  const open = async () => {
    await page.locator("main > header .bot-title").click();
    await page.getByRole("menuitem", { name: "Modifier Mino" }).click();
    return page.getByRole("dialog", { name: "Modifier Mino", exact: true });
  };
  const sheet = await open();
  const personality = `Tu réponds en deux phrases. ${Date.now().toString(36)}`;
  await sheet
    .getByLabel("Personnalité et instructions", { exact: true })
    .fill(personality);
  const model = sheet.getByRole("button", { name: /^Modèle de Mino :/ });
  await model.click();
  await sheet.getByRole("option", { name: /Fake Sol/ }).click();
  await expect(model).toContainText("Fake Sol");
  await sheet.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await page.reload();
  const view: AppView = await (
    await page.request.get(`${toolsBase}/api/view`)
  ).json();
  expect(view.bots.find((bot) => bot.id === "mino")).toMatchObject({
    instructions: personality,
    choice: { model: "fake-sol" },
  });
  const again = await open();
  await expect(
    again.getByLabel("Personnalité et instructions", { exact: true }),
  ).toHaveValue(personality);
  await expect(model).toContainText("Fake Sol");
  const restored = await page.evaluate(async () => {
    const csrf =
      document.querySelector<HTMLMetaElement>('meta[name="mino-csrf"]')
        ?.content ?? "";
    const response = await fetch("/api/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-mino-csrf": csrf },
      body: JSON.stringify({
        type: "bot.configure",
        requestId: crypto.randomUUID(),
        botId: "mino",
        model: null,
        effort: null,
        speed: "standard",
      }),
    });
    return response.ok;
  });
  expect(
    restored,
    "Mino retrouve le modèle par défaut pour les tests suivants",
  ).toBe(true);
});

test("deux demandes gardent une seule mascotte vivante et la réponse courante après la précédente", async ({
  page,
}) => {
  const view = await thread(page, [
    message("q1", "user", "Première question", 0),
    message("q2", "user", "Autre question", 1),
  ]);
  const makeWork = (id: string, state: WorkView["state"]): WorkView => ({
    id: `w-${id}`,
    threadBotId: "mino",
    botId: "mino",
    taskId: null,
    requestMessageId: id,
    state,
    title: "",
    createdAt: "2026-11-12T14:00:00Z",
    updatedAt: "2026-11-12T14:00:00Z",
    attempt: null,
    attempts: 1,
    versions: [],
    proposals: [],
    replyPreview: null,
  });
  const first = makeWork("q1", "running"),
    second = makeWork("q2", "pending");
  view.works = [first, second];
  await page.goto("/");
  await expect.soft(page.locator(".ez-chat-scroll .mascot")).toHaveCount(1);
  first.state = "done";
  second.state = "running";
  second.replyPreview = "La deuxième réponse commence";
  view.messages.push(
    message("a1", "assistant", "La première réponse est terminée.", 2),
  );
  view.rev++;
  const previous = page
    .getByRole("article")
    .filter({ hasText: "La première réponse est terminée." });
  const partial = page.locator(".ez-chat-partial");
  await expect(partial).toContainText(second.replyPreview);
  const previousBox = await previous.boundingBox(),
    partialBox = await partial.boundingBox();
  expect(partialBox!.y).toBeGreaterThanOrEqual(
    previousBox!.y + previousBox!.height,
  );
  await expect(page.locator(".ez-chat-scroll .mascot")).toHaveCount(2);
  await expect(page.locator(".ez-chat-scroll .mascot-live")).toHaveCount(1);
});

test("le travail suivant retrouve ses propres commandes après une annulation incertaine", async ({
  page,
}) => {
  const view = await thread(page, [
    message("q1", "user", "Première", 0),
    message("q2", "user", "Seconde", 1),
  ]);
  const first: WorkView = {
    id: "w-q1",
    threadBotId: "mino",
    botId: "mino",
    taskId: null,
    requestMessageId: "q1",
    state: "running",
    title: "",
    createdAt: "2026-11-12T14:00:00Z",
    updatedAt: "2026-11-12T14:00:00Z",
    attempt: null,
    attempts: 1,
    versions: [],
    proposals: [],
  };
  const second: WorkView = {
    ...first,
    id: "w-q2",
    requestMessageId: "q2",
    state: "pending",
  };
  view.works = [first, second];
  const commands: { workId: string; requestId: string }[] = [];
  await page.route("**/api/commands", async (route) => {
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) await route.abort("failed");
    else {
      second.state = "cancelled";
      view.rev++;
      await route.fulfill({
        json: { ok: true, result: { kind: "work", workId: second.id }, view },
      });
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Arrêter", exact: true }).click();
  await expect(
    page.getByText("Résultat inconnu", { exact: true }),
  ).toBeVisible();
  first.state = "done";
  second.state = "running";
  view.rev++;
  const current = page.locator('[data-work-id="w-q2"]');
  await expect(
    current.getByRole("button", { name: "Arrêter", exact: true }),
  ).toBeEnabled();
  await expect(
    current.getByText("Résultat inconnu", { exact: true }),
  ).toHaveCount(0);
  await current.getByRole("button", { name: "Arrêter", exact: true }).click();
  expect(commands.map((command) => command.workId)).toEqual([
    first.id,
    second.id,
  ]);
  expect(commands[0].requestId).not.toBe(commands[1].requestId);
});

for (const width of [1280, 390]) {
  test(`les avatars et les bulles partagent une colonne à ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const view = await thread(page, [
      message("q1", "user", "Préparons le jardin.", 0),
      message("a1", "assistant", "Choisissons deux plants de tomates.", 1),
      message("q2", "user", "Et pour les arroser ?", 2),
      message("a2", "assistant", "Arrosons le matin, au pied des plants.", 3),
    ]);
    await page.goto("/");
    const scroll = page.locator(".ez-chat-scroll");
    await expect(
      scroll.getByText("Arrosons le matin, au pied des plants."),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`placement-${width}.png`),
    });
    for (const id of ["a1", "a2"]) {
      const row = scroll.locator(`[data-message-id="${id}"]`);
      const avatar = row.locator(".mascot");
      await expect(avatar).toBeVisible();
      const a = (await avatar.boundingBox())!;
      const b = (await row.locator(".ez-chat-bubble").boundingBox())!;
      expect(a.x + a.width).toBeLessThanOrEqual(b.x);
      expect(Math.abs(a.y + a.height - b.y - b.height)).toBeLessThan(2);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await expect(scroll.locator(".mascot-live")).toHaveCount(1);
    const incomingX = (await scroll
      .locator('[data-message-id="a2"] .ez-chat-bubble')
      .boundingBox())!.x;
    const work: WorkView = {
      id: "layout-work",
      threadBotId: "mino",
      botId: "mino",
      taskId: null,
      requestMessageId: "q2",
      state: "running",
      title: "",
      createdAt: "2026-11-12T14:00:00Z",
      updatedAt: "2026-11-12T14:00:00Z",
      attempt: null,
      attempts: 1,
      versions: [],
      proposals: [],
      replyPreview: null,
    };
    view.works = [work];
    view.rev++;
    const current = scroll.locator('[data-work-id="layout-work"]');
    await expect(current).toContainText("Mino prépare une réponse");
    for (const preview of [null, "Vérifions la terre avant chaque arrosage."]) {
      work.replyPreview = preview;
      view.rev++;
      if (preview)
        await expect(current.locator(".ez-chat-bubble")).toHaveText(preview);
      const avatar = (await current.locator(".mascot-live").boundingBox())!;
      const bubble = (await current.locator(".ez-chat-bubble").boundingBox())!;
      expect(bubble.x).toBe(incomingX);
      expect(avatar.x + avatar.width).toBeLessThanOrEqual(bubble.x);
      expect(
        Math.abs(avatar.y + avatar.height - bubble.y - bubble.height),
      ).toBeLessThan(2);
      await expect(scroll.locator(".mascot-live")).toHaveCount(1);
    }
    await page.screenshot({
      path: testInfo.outputPath(`placement-progressive-${width}.png`),
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}

test("un groupe garde son avatar final et un invité garde son identité", async ({
  page,
}) => {
  const view = await thread(page, [
    message("a1", "assistant", "Première partie du plan.", 0),
    message("a2", "assistant", "Dernière partie du plan.", 1),
    {
      ...message("guest", "assistant", "Je vérifie le matériel.", 2),
      botId: "guest",
    },
  ]);
  view.bots.push({
    ...view.bots[0],
    id: "guest",
    name: "Jardinier invité",
    color: "#aabbcc",
  });
  await page.goto("/");
  const scroll = page.locator(".ez-chat-scroll");
  await expect(scroll.locator('[data-message-id="a1"] .mascot')).toHaveCount(0);
  await expect(scroll.locator('[data-message-id="a2"] .mascot')).toBeVisible();
  const guest = scroll.locator('[data-message-id="guest"]');
  await expect(guest).toHaveAccessibleName("Jardinier invité");
  await expect(guest.locator(".ez-chat-guest")).toHaveText("Jardinier invité");
  await expect(guest.locator(".mascot-live svg")).toHaveAttribute(
    "style",
    /#aabbcc/,
  );
  await expect(scroll.locator(".mascot-live")).toHaveCount(1);
});
