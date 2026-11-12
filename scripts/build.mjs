import { build } from "esbuild";
import { fileURLToPath } from "node:url";
await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/main.tsx"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: "server/dist/web",
  entryNames: "react-app",
  minify: true,
  sourcemap: true,
});
