import { test, expect } from "@playwright/test";
import type { AppView } from "../server/src/protocol";
test("preuves visuelles du client avec un espace synthétique vide", async ({
  page,
  request,
}, info) => {
  const view: AppView = await (await request.get("/api/view")).json();
  const fixture = {
    ...view,
    activeBotId: "mino",
    bots: view.bots.filter((b) =>
      ["mino", "nova", "atlas", "pixel"].includes(b.id),
    ),
    messages: [],
    works: [],
    tasks: [],
    carnet: [],
  };
  await page.route("**/api/view*", (route) => route.fulfill({ json: fixture }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "Salut, moi c’est Mino." }),
  ).toBeVisible();
  const placement = await page.locator(".ez-chat-welcome").evaluate((node) => {
    const mascot = node.querySelector(".mascot")?.getBoundingClientRect();
    const area = node.getBoundingClientRect();
    const scroll = node.closest(".ez-chat-scroll");
    return {
      offset: mascot
        ? Math.abs(mascot.x + mascot.width / 2 - area.x - area.width / 2)
        : 999,
      scrollTop: scroll?.scrollTop,
    };
  });
  expect(placement.offset).toBeLessThan(2);
  expect(placement.scrollTop).toBe(0);
  await page.screenshot({
    path: info.outputPath("apres-chat-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Personnages", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Un compagnon à votre image." }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("apres-personnages-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("apres-chat-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
