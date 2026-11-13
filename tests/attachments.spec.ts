import { test, expect, type Page } from "@playwright/test";

async function syntheticPng(page: Page, size = 512) {
  const base64 = await page.evaluate((size) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const pixels = ctx.createImageData(size, size);
    let state = 11;
    for (let i = 0; i < pixels.data.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      pixels.data[i] = i % 4 === 3 ? 255 : state >>> 24;
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1];
  }, size);
  return Buffer.from(base64, "base64");
}

test("les images restent dans le brouillon puis dans la commande exacte après une réponse perdue", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Ajouter des pièces jointes" }),
  ).toBeVisible();
  const png = await syntheticPng(page);
  await page
    .getByLabel("Joindre photos et fichiers")
    .setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });
  await expect(
    page.getByRole("button", { name: "Retirer pixel.png" }),
  ).toBeVisible();
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
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
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
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
  await expect(
    page.getByRole("button", { name: "Ajouter des pièces jointes" }),
  ).toBeVisible();
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
  await expect(
    page.getByRole("button", { name: "Ajouter des pièces jointes" }),
  ).toBeVisible();
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
    const metadata = new File(["metadata"], ".DS_Store");
    Object.defineProperty(metadata, "webkitRelativePath", {
      value: "dossier/.DS_Store",
    });
    dt.items.add(metadata);
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
  await expect(page.getByRole("alert")).toContainText(
    "1 fichier(s) système ignoré(s)",
  );
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
  await expect(
    page.getByRole("button", { name: "Ajouter des pièces jointes" }),
  ).toBeVisible();
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
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Ajouter des pièces jointes" }),
  ).toBeVisible();
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
  await expect(
    other.getByRole("button", { name: "Ajouter des pièces jointes" }),
  ).toBeVisible();
  await expect(
    other.getByText("Brouillon d’une autre page", { exact: false }),
  ).toBeVisible();
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
    other.getByText("Brouillon d’une autre page", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
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
  await expect(
    page.getByRole("button", { name: "Ajouter des pièces jointes" }),
  ).toBeVisible();
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

test("le dépôt dans un fil actif garde la page et ajoute la photo", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".ez-chat")).toBeVisible();
  const png = await syntheticPng(page);
  const prevented = await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "depot.png", { type: "image/png" }));
    const chat = document.querySelector(".ez-chat")!;
    const drag = new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    chat.dispatchEvent(drag);
    const drop = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    chat.dispatchEvent(drop);
    return [drag.defaultPrevented, drop.defaultPrevented];
  }, png.toString("base64"));
  expect(prevented).toEqual([true, true]);
  await expect(
    page.getByRole("button", { name: "Retirer depot.png" }),
  ).toBeVisible();
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
});

test("IndexedDB indisponible ne bloque pas le texte après retrait", async ({
  page,
}) => {
  await page.addInitScript(() => {
    indexedDB.open = () => {
      throw new DOMException("test open", "UnknownError");
    };
  });
  await page.goto("/");
  await page.getByLabel("Joindre photos et fichiers").setInputFiles({
    name: "open.png",
    mimeType: "image/png",
    buffer: await syntheticPng(page),
  });
  await expect(
    page.getByText("Le stockage local est indisponible", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retirer open.png" }).click();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("texte sans IndexedDB");
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/commands"));
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  expect((await sent).postDataJSON().text).toBe("texte sans IndexedDB");
});

test("quota garde la version validée, avertit puis récupère sans rechargement", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (Reflect.get(window, "failAttachmentPut"))
        queueMicrotask(() => this.transaction.abort());
      return request;
    };
  });
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("version validée");
  await page.getByLabel("Joindre photos et fichiers").setInputFiles({
    name: "quota.png",
    mimeType: "image/png",
    buffer: await syntheticPng(page),
  });
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retirer quota.png" }),
  ).toBeVisible();
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
  const pointer = await page.evaluate(() =>
    Object.entries(localStorage).find(([k]) => k.startsWith("mino.draft.v2|"))!,
  );
  await page.evaluate(() => Reflect.set(window, "failAttachmentPut", true));
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("version en mémoire");
  await expect(
    page.getByText("Le stockage local est indisponible", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), pointer[0]),
  ).toBe(pointer[1]);
  const other = await context.newPage();
  await other.goto("/");
  await expect(
    other.getByText("Brouillon d’une autre page · version validée"),
  ).toBeVisible();
  await page.evaluate(() => Reflect.set(window, "failAttachmentPut", false));
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("version récupérée");
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Le stockage local est indisponible", { exact: false }),
  ).toHaveCount(0);
  await expect(
    other.getByText("Brouillon d’une autre page · version récupérée"),
  ).toBeVisible();
  await other.getByRole("button", { name: "Reprendre ce brouillon" }).click();
  await expect(
    other.getByRole("button", { name: "Retirer quota.png" }),
  ).toBeVisible();
  await expect(
    other.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
  await other.reload();
  await expect(
    other.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("version récupérée");
  await expect(
    other.getByRole("button", { name: "Retirer quota.png" }),
  ).toBeVisible();
  await other.close();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("version récupérée");
  await expect(
    page.getByRole("button", { name: "Retirer quota.png" }),
  ).toBeVisible();
});

test("la saisie rapide regroupe la sauvegarde et conserve le dernier brouillon exact", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    Reflect.set(window, "attachmentPuts", 0);
    IDBObjectStore.prototype.put = function (...args) {
      Reflect.set(
        window,
        "attachmentPuts",
        Number(Reflect.get(window, "attachmentPuts")) + 1,
      );
      return put.apply(this, args);
    };
  });
  await page.goto("/");
  const png = await syntheticPng(page, 1024);
  await page.getByLabel("Joindre photos et fichiers").setInputFiles([
    { name: "a.png", mimeType: "image/png", buffer: png },
    { name: "b.png", mimeType: "image/png", buffer: png },
  ]);
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Retirer / })).toHaveCount(2);
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    Reflect.set(window, "attachmentPuts", 0);
    const input = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    for (let i = 0; i < 100; i++) {
      setter.call(input, `dernier texte ${i}`);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "attachmentPuts")))
    .toBe(1);
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("dernier texte 99");
  await expect(page.getByRole("button", { name: /^Retirer / })).toHaveCount(2);
});

test("un envoi attend le commit de sa commande figée puis reprend les mêmes octets", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    Reflect.set(window, "failPending", true);
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (
        typeof args[0] === "string" &&
        args[0].includes('"command"') &&
        Reflect.get(window, "failPending")
      ) {
        Reflect.set(window, "frozenPending", args[0]);
        queueMicrotask(() => this.transaction.abort());
      }
      return request;
    };
  });
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("commande originale");
  const png = await syntheticPng(page);
  await page
    .getByLabel("Joindre photos et fichiers")
    .setInputFiles({ name: "figee.png", mimeType: "image/png", buffer: png });
  await expect(
    page.getByRole("button", { name: "Retirer figee.png" }),
  ).toBeVisible();
  let sends = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/commands")) sends++;
  });
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect(page.getByRole("alert")).toContainText("Envoi arrêté");
  expect(sends).toBe(0);
  const frozen = await page.evaluate(
    () => JSON.parse(String(Reflect.get(window, "frozenPending"))).command,
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("nouveau brouillon");
  await page.evaluate(() => Reflect.set(window, "failPending", false));
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/commands"));
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  expect((await sent).postDataJSON()).toEqual(frozen);
  expect(frozen.attachments[0].base64).toBe(png.toString("base64"));
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("nouveau brouillon");
  await expect(
    page.getByText("Sauvegarde du brouillon en cours.", { exact: false }),
  ).toHaveCount(0);
});
