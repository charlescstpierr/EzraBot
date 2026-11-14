// Isolated browser QA: synthetic SQLite data, deliberately unavailable engine, no provider calls.
// With MINO_QA_TOOLS=1 the chat lane runs the real engine against the fake App Server process,
// and connected services use the fake provider: every account, action and result is synthetic.
// With MINO_QA_HONCHO=1 the chat lane also runs against the fake App Server, and the memory desk
// talks to a fake Honcho on a loopback port: no real workspace, key or message exists.
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
import { startFakeHoncho } from "../server/dist/test/fixtures/fake-honcho.js";
import { DEFAULT_POLICY } from "../server/dist/src/admission.js";
import { withMemoryCapabilities } from "../server/dist/src/memory-ledger.js";
import { createMemoryDesk } from "../server/dist/src/memory-desk.js";
const root = resolve("server"),
  data = mkdtempSync(join(tmpdir(), "mimobot-react-qa-"));
const port = Number(process.env.MINO_QA_PORT ?? 4399);
const withTools = process.env.MINO_QA_TOOLS === "1";
const honcho =
  process.env.MINO_QA_HONCHO === "1" ? await startFakeHoncho() : null;
// A request that names this word gets a 503 from the fake search, to show a turn answered without memory.
if (honcho)
  honcho.intercept = (request) =>
    request.path.endsWith("/search") &&
    /panne-synthétique/.test(request.body?.query ?? "")
      ? { status: 503, body: {} }
      : undefined;
const store = openStore({
  path: join(data, "mino.sqlite"),
  mascots: loadMascots(join(root, "assets/mascots.json")),
  serviceTools: withTools,
  ...(honcho
    ? {
        memory: { workspacePrefix: "ezra-qa" },
        policy: withMemoryCapabilities({
          ...DEFAULT_POLICY,
          budgets: { ...DEFAULT_POLICY.budgets, honcho: { callsPerDay: 500 } },
        }),
      }
    : {}),
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
const chat =
  withTools || honcho
    ? createCodexEngine({
        command: process.execPath,
        args: [
          resolve(root, "dist/test/fixtures/fake-app-server.js"),
          withTools ? "tool-call" : "reply",
        ],
        workDir: data,
        clientVersion: "qa",
        ...(withTools ? { dynamicTools: true } : {}),
      })
    : engine;
const memoryDesk = honcho
  ? createMemoryDesk({
      store,
      config: {
        baseUrl: honcho.url,
        apiKey: honcho.key,
        workspacePrefix: "ezra-qa",
        timeoutMs: 2000,
      },
      allowLoopbackHttpForTests: true,
    })
  : null;
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
  ...(memoryDesk ? { memory: memoryDesk } : {}),
});
const missions = openMissions({
  path: join(data, "missions.sqlite"),
  minoRoot: root,
  dataDir: data,
  admission: store.admission,
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
  await Promise.all([worker.close(), desk.close(), memoryDesk?.close()]);
  await chat.close();
  await honcho?.close();
  store.close();
  missions.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
