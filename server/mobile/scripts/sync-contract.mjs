import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const mobile = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = process.env.MINO_REPO_ROOT || resolve(mobile, "..");
await mkdir(resolve(mobile, "src/generated"), { recursive: true });
const files = ["mobile-protocol.ts", "protocol.ts", "constants.ts", "agent-protocol.ts"];
for (const file of files) {
  const source = await readFile(resolve(repo, "src", file));
  const target = resolve(mobile, "src/generated", file);
  if (!process.argv.includes("--check")) await writeFile(target, source);
  if (!(await readFile(target)).equals(source))
    throw Error(`Contract drift: ${file}`);
}
console.info(`All ${files.length} contracts match authoritative source byte for byte.`);
