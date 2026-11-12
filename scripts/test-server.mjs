// Isolated browser QA: synthetic SQLite data, deliberately unavailable engine, no provider calls.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHttpServer } from "../server/dist/src/http.js";
import { openStore } from "../server/dist/src/store.js";
import { loadMascots } from "../server/dist/src/domain.js";
import { createWorker } from "../server/dist/src/worker.js";
import { openMissions } from "../server/dist/src/missions.js";
import { createAgentRoutes } from "../server/dist/src/agent-http.js";
const root = resolve("server"),
  data = mkdtempSync(join(tmpdir(), "mimobot-react-qa-"));
const store = openStore({
  path: join(data, "mino.sqlite"),
  mascots: loadMascots(join(root, "assets/mascots.json")),
});
const engine = {
  status: () => ({
    state: "unavailable",
    message: "Moteur volontairement désactivé pour les tests locaux.",
  }),
  catalog: async () => engine.status(),
  onUsage: () => () => {},
  run: async () => ({
    kind: "failed",
    code: "unavailable",
    message: "Moteur désactivé pour les tests.",
  }),
  close: async () => {},
};
const worker = createWorker({ store, engines: { chat: engine, doc: engine } });
const missions = openMissions({
  path: join(data, "missions.sqlite"),
  minoRoot: root,
  dataDir: data,
});
const agents = createAgentRoutes({
  missions,
  worker: { sync() {} },
  engine: {
    status: () => ({ state: "unavailable" }),
    catalog: async () => ({ ok: false, message: "Désactivé" }),
  },
});
const server = createHttpServer({
  store,
  worker,
  engine,
  root,
  port: 4399,
  csrfToken: "test-only-token",
  agents,
});
server.listen(4399, "127.0.0.1", () =>
  console.log("QA http://127.0.0.1:4399 — isolated, no AI calls"),
);
async function stop() {
  server.closeAllConnections();
  server.close();
  await worker.close();
  store.close();
  missions.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
