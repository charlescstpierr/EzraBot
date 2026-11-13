// Isolated browser QA: synthetic SQLite data, deliberately unavailable engine, no provider calls.
// With MINO_QA_TOOLS=1 the chat lane runs the real engine against the fake App Server process,
// and connected services use the fake provider: every account, action and result is synthetic.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHttpServer } from "../server/dist/src/http.js";
import { openStore } from "../server/dist/src/store.js";
import { loadMascots } from "../server/dist/src/domain.js";
import { createWorker } from "../server/dist/src/worker.js";
import { openMissions } from "../server/dist/src/missions.js";
import { createAgentRoutes } from "../server/dist/src/agent-http.js";
import { createCodexEngine } from "../server/dist/src/engine.js";
import { createActionDesk } from "../server/dist/src/tool-desk.js";
import { createFakeProvider } from "../server/dist/test/fixtures/fake-composio.js";
const root = resolve("server"),
  data = mkdtempSync(join(tmpdir(), "mimobot-react-qa-"));
const port = Number(process.env.MINO_QA_PORT ?? 4399);
const withTools = process.env.MINO_QA_TOOLS === "1";
if (withTools)
  process.env.MINO_TEST_CATALOG = join(
    root,
    "test/fixtures/engine-catalogue.json",
  );
const store = openStore({
  path: join(data, "mino.sqlite"),
  mascots: loadMascots(join(root, "assets/mascots.json")),
  serviceTools: withTools,
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
const chat = withTools
  ? createCodexEngine({
      command: process.execPath,
      args: [
        resolve(root, "dist/test/fixtures/fake-app-server.js"),
        "tool-call",
      ],
      workDir: data,
      clientVersion: "qa",
      dynamicTools: true,
    })
  : engine;
// Without the tools mode there is no provider at all: the page shows the missing key state.
const desk = createActionDesk({
  store,
  provider: withTools ? createFakeProvider() : null,
  port,
  wake: () => worker.kick(),
});
const worker = createWorker({
  store,
  engines: { chat, doc: engine },
  tools: desk,
});
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
  engine: chat,
  root,
  port,
  csrfToken: "test-only-token",
  agents,
  actions: desk,
});
server.listen(port, "127.0.0.1", () =>
  console.log(`QA http://127.0.0.1:${port} — isolated, no AI calls`),
);
async function stop() {
  server.closeAllConnections();
  server.close();
  await Promise.all([worker.close(), desk.close()]);
  await chat.close();
  store.close();
  missions.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
