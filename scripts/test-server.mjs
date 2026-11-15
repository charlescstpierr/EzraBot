// Isolated browser QA: synthetic SQLite data, deliberately unavailable engine, no provider calls.
// With MINO_QA_TOOLS=1 the chat lane runs the real engine against the fake App Server process,
// and connected services use the fake provider: every account, action and result is synthetic.
import { missionOrigins } from "../server/dist/src/routines.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
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
import { createEventIngress } from "../server/dist/src/event-ingress.js";
const root = resolve("server"),
  data = mkdtempSync(join(tmpdir(), "mimobot-react-qa-"));
const port = Number(process.env.MINO_QA_PORT ?? 4399);
const withTools = process.env.MINO_QA_TOOLS === "1";
// Synthetic service events: a fake transport, secret and account, never a provider. The signed listener shares
// this QA port only because the QA ports are fixed; the real server gives it its own port.
const withEvents = process.env.MINO_QA_EVENTS === "1";
const EVENTS = { transport: "qa-projet", secret: "whsec_qa_synthetique_0001" };
const honcho =
  process.env.MINO_QA_HONCHO === "1" ? await startFakeHoncho() : null;
if (honcho)
  honcho.intercept = (request) =>
    request.path.endsWith("/search") &&
    /panne-synthétique/.test(request.body?.query ?? "")
      ? { status: 503, body: {} }
      : undefined;
// Routine slots follow a clock a spec can move: a shift in milliseconds, read from this file at each reading.
const clockFile = join(tmpdir(), `mino-qa-clock-${port}`);
const ownerFile = join(tmpdir(), `mino-qa-owner-${port}`);
writeFileSync(clockFile, "0");
const now = () => {
  let shift = 0;
  try {
    shift = Number(readFileSync(clockFile, "utf8")) || 0;
  } catch {}
  return new Date(Date.now() + shift).toISOString();
};
const startedAt = now();
const store = openStore({
  path: join(data, "mino.sqlite"),
  now,
  missions: () => missionOrigins(missions),
  mascots: loadMascots(join(root, "assets/mascots.json")),
  serviceTools: withTools,
  ...(withEvents ? { events: { transport: EVENTS.transport } } : {}),
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
const pc = createHttpServer({
  store,
  worker,
  engine: chat,
  root,
  port,
  csrfToken: "test-only-token",
  agents,
  actions: desk,
});
if (withEvents) {
  store.tools.observeAccount({
    id: "ca_qa_github",
    toolkit: "github",
    alias: "Compte GitHub synthétique",
    status: "ACTIVE",
  });
  writeFileSync(ownerFile, store.tools.ownerId);
}
const ingress = withEvents
  ? createEventIngress({
      config: {
        transport: EVENTS.transport,
        secrets: [Buffer.from(EVENTS.secret)],
        port,
        bind: "127.0.0.1",
      },
      ownerId: store.tools.ownerId,
      receive: (delivery) => store.receiveEvent(delivery),
      wake: () => worker.kick(),
    })
  : null;
const server = ingress
  ? createServer((req, res) =>
      (req.url ?? "").startsWith("/events/")
        ? ingress.emit("request", req, res)
        : pc.emit("request", req, res),
    )
  : pc;
const routineClock = setInterval(() => {
  if (store.tickRoutines(startedAt) > 0) worker.kick();
}, 1000);
server.listen(port, "127.0.0.1", () =>
  console.log(`QA http://127.0.0.1:${port} — isolated, no AI calls`),
);
async function stop() {
  try {
    clearInterval(routineClock);
    server.closeAllConnections();
    server.close();
    await Promise.all([worker.close(), desk.close(), memoryDesk?.close()]);
    await chat.close();
    await honcho?.close();
    store.close();
    missions.close();
  } finally {
    rmSync(data, { recursive: true, force: true });
    for (const path of [clockFile, ...(withEvents ? [ownerFile] : [])])
      rmSync(path, { force: true });
  }
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
