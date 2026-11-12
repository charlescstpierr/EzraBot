import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const mobile = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = process.env.MINO_REPO_ROOT || resolve(mobile, "..");
const catalog = JSON.parse(
  await readFile(resolve(repo, "assets/mascots.json"), "utf8"),
);
const symbols = await readFile(resolve(repo, "assets/symbols.svg"), "utf8");
const shapes = catalog.shapes.map((shape) => {
  const match = [
    ...symbols.matchAll(
      /<symbol\s+id="([^"]+)"\s+viewBox="([^"]+)"[^>]*>([\s\S]*?)<\/symbol>/g,
    ),
  ].find((m) => m[1] === shape.symbol);
  if (!match) throw Error(`Missing public symbol ${shape.symbol}`);
  return {
    ...shape,
    xml: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${match[2]}">${match[3]}</svg>`,
  };
});
await writeFile(
  resolve(mobile, "src/generated/mascots.json"),
  JSON.stringify({ ...catalog, shapes }, null, 2),
);
console.info(`Generated ${shapes.length} mascots from public assets only.`);
