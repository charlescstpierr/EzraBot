import { test, expect, type Page } from "@playwright/test";

async function syntheticPng(page: Page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d")!;
    const pixels = ctx.createImageData(512, 512);
    let state = 11;
    for (let i = 0; i < pixels.data.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = i % 4 === 3 ? 255 : state >>> 24;
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  return Buffer.from(base64, "base64");
}

test("les images restent dans le brouillon puis dans la commande exacte après une réponse perdue", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("Joindre un dossier")).toBeVisible();
  const png = await syntheticPng(page);
  await page
    .getByLabel("Joindre photos et fichiers")
    .setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  await expect(
    page.getByRole("button", { name: "Retirer pixel.png" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Retirer pixel.png" }),
  ).toBeVisible();
  let sent: unknown;
  await page.route("**/api/commands", async (route) => {
    sent = route.request().postDataJSON();
    await route.fetch();
    await route.abort();
  });
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect(
    page.getByText("Un envoi attend sa confirmation.", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Un envoi attend sa confirmation.", { exact: false }),
  ).toBeVisible();
  await page.unroute("**/api/commands");
  const retried = page.waitForRequest((r) => r.url().endsWith("/api/commands"));
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  expect((await retried).postDataJSON()).toEqual(sent);
  await expect(
    page.getByRole("button", { name: "Retirer pixel.png" }),
  ).toHaveCount(0);
  await expect(page.locator("img.ez-attachment-preview").first()).toBeVisible();
});

test("un lot avec un binaire interdit ne garde aucun fichier", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("Joindre un dossier")).toBeVisible();
  await page.getByLabel("Joindre photos et fichiers").setInputFiles([
    { name: "bon.txt", mimeType: "text/plain", buffer: Buffer.from("texte") },
    {
      name: "document.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF"),
    },
  ]);
  await expect(page.getByRole("alert")).toContainText(
    "format non pris en charge",
  );
  await expect(
    page.getByRole("button", { name: "Retirer bon.txt" }),
  ).toHaveCount(0);
});

test("un dossier mixte conserve ses chemins et les trois formats image", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("Joindre un dossier")).toBeVisible();
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    canvas.getContext("2d")!.fillRect(0, 0, 32, 32);
    const dt = new DataTransfer();
    for (const [mime, ext] of [
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/webp", "webp"],
    ]) {
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!), mime),
      );
      const file = new File([blob], `image.${ext}`, { type: mime });
      Object.defineProperty(file, "webkitRelativePath", {
        value: `dossier/image.${ext}`,
      });
      dt.items.add(file);
    }
    const text = new File(["notes synthétiques"], "notes.txt", {
      type: "text/plain",
    });
    Object.defineProperty(text, "webkitRelativePath", {
      value: "dossier/notes.txt",
    });
    dt.items.add(text);
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Joindre un dossier"]',
    )!;
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(
    page.getByText("dossier/notes.txt", { exact: false }),
  ).toBeVisible();
  await expect(
    page
      .locator("li")
      .filter({ has: page.getByRole("button", { name: /^Retirer / }) })
      .locator("img.ez-attachment-preview"),
  ).toHaveCount(3);
  await page.getByRole("button", { name: "Retirer image.jpg" }).click();
  await expect(
    page
      .locator("li")
      .filter({ has: page.getByRole("button", { name: /^Retirer / }) })
      .locator("img.ez-attachment-preview"),
  ).toHaveCount(2);
  const request = page.waitForRequest((r) => r.url().endsWith("/api/commands"));
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  const files = (await request).postDataJSON().attachments;
  expect(files.map((f: { relativePath: string }) => f.relativePath)).toEqual([
    "dossier/image.png",
    "dossier/image.webp",
    "dossier/notes.txt",
  ]);
});

test("la suppression efface les images du brouillon dans les deux onglets", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("Joindre un dossier")).toBeVisible();
  const botId = await page.evaluate(async () => {
    const csrf = document.querySelector<HTMLMetaElement>(
      'meta[name="mino-csrf"]',
    )!.content;
    const view = await (await fetch("/api/view")).json();
    const response = await fetch("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mino-csrf": csrf },
      body: JSON.stringify({
        type: "bot.create",
        requestId: crypto.randomUUID(),
        name: "Pièces test",
        title: "Synthétique",
        shape: view.bots[0].shape,
        color: "#123456",
      }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(JSON.stringify(result));
    const botId = result.result.botId;
    await fetch("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mino-csrf": csrf },
      body: JSON.stringify({
        type: "bot.select",
        requestId: crypto.randomUUID(),
        botId,
      }),
    });
    return botId;
  });
  await page.reload();
  await expect(page.getByLabel("Joindre un dossier")).toBeVisible();
  const png = await syntheticPng(page);
  await page.getByLabel("Joindre photos et fichiers").setInputFiles({
    name: "a-effacer.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(
    page.getByRole("button", { name: "Retirer a-effacer.png" }),
  ).toBeVisible();
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByLabel("Joindre un dossier")).toBeVisible();
  await page.evaluate(async (botId) => {
    const view = await (await fetch("/api/view")).json();
    const bot = view.bots.find((bot: { id: string }) => bot.id === botId);
    const csrf = document.querySelector<HTMLMetaElement>(
      'meta[name="mino-csrf"]',
    )!.content;
    const response = await fetch("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mino-csrf": csrf },
      body: JSON.stringify({
        type: "bot.delete",
        requestId: crypto.randomUUID(),
        botId,
        confirmName: bot.name,
        expected: bot.deletion,
      }),
    });
    if (!response.ok) throw Error(await response.text());
  }, botId);
  await expect(
    page.getByRole("button", { name: "Retirer a-effacer.png" }),
  ).toHaveCount(0);
  await expect(
    other.getByText("Autre brouillon", { exact: false }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Retirer a-effacer.png" }),
  ).toHaveCount(0);
  const remaining = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("ezra-chat-durable-v1");
      request.onsuccess = () => resolve(request.result);
    });
    return new Promise<boolean>((resolve) => {
      const request = db.transaction("values").objectStore("values").getAll();
      request.onsuccess = () => {
        resolve(
          request.result.some((value) =>
            String(value).includes("a-effacer.png"),
          ),
        );
        db.close();
      };
    });
  });
  expect(remaining).toBe(false);
  await other.close();
});

test("une image corrompue ou trop grande laisse le brouillon intact", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("Joindre un dossier")).toBeVisible();
  const input = page.getByLabel("Joindre photos et fichiers");
  await input.setInputFiles({
    name: "corrompue.png",
    mimeType: "image/png",
    buffer: Buffer.from("ceci ne contient aucune image"),
  });
  await expect(page.getByRole("alert")).toContainText("image corrompue");
  await input.setInputFiles({
    name: "trop-grande.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(4 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole("alert")).toContainText("dépasse 4 Mio");
  await expect(page.getByRole("button", { name: /^Retirer / })).toHaveCount(0);
});
