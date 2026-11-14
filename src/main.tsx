import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  Plus,
  MessageCircle,
  Folder,
  BookOpen,
  Monitor,
  Settings,
  PanelLeft,
  ChevronDown,
  X,
  Download,
  MoreHorizontal,
  Sparkles,
  Users,
} from "lucide-react";
import type { CommandOf } from "../server/src/protocol";
import type { PcView } from "../server/src/tools-protocol";
import type { AgentsView } from "../server/src/agent-protocol";
import { openDrafts, type KeyValueStorage } from "../server/web/drafts";
import { forgetSearch } from "../server/web/search";
import { createRunner, getAppView, getAgentsView, uid } from "./api";
import type { CommandRunner, Port, Route } from "./port";
import {
  AgentOutboxProvider,
  AgentRecovery,
  OUTBOX_KEY,
  commandOwners,
  openAgentOutbox,
} from "./agent-outbox";
import { Mascot } from "./Mascot";
import { Markdown } from "./Markdown";
import { ChatPage } from "./chat";
import { storageWrite } from "./chat/pending";
import { SearchBox } from "./search";
import { TaskCard, DocumentPanel } from "./documents";
import { sourceChoice } from "./documents/source";
import { MissionProposal, MissionList, MissionPanel } from "./missions";
import { ProjectsPage } from "./projects";
import { CharacterPanel, CharacterCreate } from "./characters";
import { ToolCards, ToolConnections } from "./tools";
import { MemoryTrace } from "./memory";
import { ResultsPage } from "./results";
import "./style.css";
function browserStorage(
  kind: "localStorage" | "sessionStorage",
): KeyValueStorage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}
function App() {
  const [view, setView] = useState<PcView | null>(null),
    [agents, setAgents] = useState<AgentsView | null>(null),
    [offline, setOffline] = useState(""),
    [error, setError] = useState(""),
    [sidebar, setSidebar] = useState(false),
    [dialog, setDialog] = useState<"computer" | "settings" | null>(null),
    [fan, setFan] = useState(false),
    [route, setRoute] = useState<Route>({ page: "chat", botId: "" });
  const [selectionPending, setSelectionPending] =
    useState<CommandOf<"bot.select"> | null>(null);
  const drafts = useMemo(
    () =>
      openDrafts({
        local: browserStorage("localStorage"),
        session: browserStorage("sessionStorage"),
      }),
    [],
  );
  const retiredSpaces = useRef(new Set<string>()),
    currentSpace = useRef<string | null>(null),
    press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyApp = useCallback(
    (next: PcView) => {
      if (retiredSpaces.current.has(next.spaceId)) return;
      if (
        currentSpace.current !== null &&
        currentSpace.current !== next.spaceId
      )
        retiredSpaces.current.add(currentSpace.current);
      currentSpace.current = next.spaceId;
      drafts.useSpace(next.spaceId);
      setView((previous) =>
        previous?.spaceId === next.spaceId && previous.rev > next.rev
          ? previous
          : next,
      );
    },
    [drafts],
  );
  const applyAgents = useCallback(
    (next: AgentsView) =>
      setAgents((previous) =>
        previous && previous.rev > next.rev ? previous : next,
      ),
    [],
  );
  const runner = useMemo(
    () => createRunner({ app: applyApp, agents: applyAgents }),
    [applyApp, applyAgents],
  );
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let polling = false;
    async function poll() {
      if (polling || abort.signal.aborted) return;
      polling = true;
      const responses = await Promise.allSettled([
        getAppView(abort.signal),
        getAgentsView(abort.signal),
      ]);
      if (abort.signal.aborted) {
        polling = false;
        return;
      }
      const [app, agent] = responses;
      if (app.status === "fulfilled") applyApp(app.value);
      if (agent.status === "fulfilled") applyAgents(agent.value);
      const failure = responses.find((r) => r.status === "rejected");
      setOffline(
        failure?.status === "rejected"
          ? failure.reason instanceof Error
            ? failure.reason.message
            : "Connexion interrompue"
          : "",
      );
      polling = false;
      timer = setTimeout(poll, 1200);
    }
    void poll();
    const foreground = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", foreground);
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [applyApp, applyAgents]);
  const space = view?.spaceId;
  const outbox = useMemo(
    () =>
      space === undefined
        ? null
        : openAgentOutbox({
            spaceId: space,
            storage: browserStorage("localStorage"),
            send: runner.agents,
          }),
    [space, runner],
  );
  const shown = useRef({ view, agents });
  shown.current = { view, agents };
  const run = useMemo<CommandRunner | null>(
    () =>
      outbox && {
        app: runner.app,
        tools: runner.tools,
        memory: runner.memory,
        agents: (command) =>
          outbox.run(
            command,
            commandOwners(command, {
              messages: shown.current.view?.messages ?? [],
              missions: shown.current.agents?.missions ?? [],
            }),
          ),
      },
    [runner, outbox],
  );
  useEffect(() => {
    if (!outbox) return;
    const changed = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(OUTBOX_KEY)) outbox.sync();
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [outbox]);
  useEffect(() => {
    if (!view) return;
    drafts.useSpace(view.spaceId);
    setRoute(
      view.activeBotId
        ? { page: "chat", botId: view.activeBotId }
        : { page: "characters" },
    );
    setFan(false);
    setDialog(null);
    setSelectionPending(null);
  }, [space, drafts]);
  useEffect(() => {
    if (!view) return;
    const scopes = [
      ...view.purged.botIds.map((botId) => ({
        kind: "prompt" as const,
        botId,
      })),
      ...view.purged.workIds.map((workId) => ({
        kind: "version" as const,
        workId,
      })),
    ];
    drafts.purge(view.spaceId, scopes);
    outbox?.purge(view.purged.botIds);
    if (scopes.length) {
      forgetSearch();
      for (const id of view.purged.botIds) {
        storageWrite(`mimobot:${view.spaceId}:${id}:draft`, null);
        storageWrite(`mimobot:${view.spaceId}:${id}:pending`, null);
      }
      if (route.page === "chat" && !view.bots.some((b) => b.id === route.botId))
        setRoute(
          view.activeBotId
            ? { page: "chat", botId: view.activeBotId }
            : { page: "characters" },
        );
      if (
        route.page === "characters" &&
        route.botId &&
        !view.bots.some((b) => b.id === route.botId)
      )
        setRoute({ page: "characters" });
    }
  }, [view, drafts, outbox, route]);
  useEffect(() => {
    if (!dialog) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const modal = document.querySelector<HTMLElement>(".modal");
    const focusables = () =>
      Array.from(
        modal?.querySelectorAll<HTMLElement>(
          "button:not([disabled]),a[href],input,textarea,select",
        ) ?? [],
      );
    focusables()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDialog(null);
      if (e.key === "Tab") {
        const items = focusables(),
          first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [dialog]);
  async function select(command: CommandOf<"bot.select">) {
    const result = await runner.app(command);
    if (result.kind === "unknown") {
      setError(result.message);
      setSelectionPending(command);
    } else {
      setSelectionPending(null);
      if (result.kind !== "accepted") {
        setError(result.message);
        if (result.kind === "refused" && result.code === "not_found")
          setRoute({ page: "chat", botId: result.view.activeBotId });
      } else setError("");
    }
  }
  function go(next: Route) {
    setRoute(next);
    setSidebar(false);
    setDialog(null);
    setFan(false);
    if (next.page === "chat" && next.botId && next.botId !== view?.activeBotId)
      void select({ type: "bot.select", requestId: uid(), botId: next.botId });
  }
  const port: Port | null = view && run ? { view, agents, run, go } : null;
  const selectedBot = view?.bots.find(
    (b) =>
      b.id ===
      (route.page === "chat"
        ? route.botId
        : route.page === "characters"
          ? route.botId
          : view.activeBotId),
  );
  const nav = [
    { id: "chat", label: "Conversation", Icon: MessageCircle },
    { id: "missions", label: "Missions", Icon: Sparkles },
    { id: "projects", label: "Projets", Icon: Folder },
    { id: "results", label: "Tous mes résultats", Icon: BookOpen },
    { id: "carnet", label: "Carnet", Icon: BookOpen },
    { id: "characters", label: "Personnages", Icon: Users },
  ];
  function openHome() {
    const bot = view?.bots.find((b) => b.id === "mino");
    go(
      bot
        ? { page: "chat", botId: bot.id }
        : view?.activeBotId
          ? { page: "chat", botId: view.activeBotId }
          : { page: "characters" },
    );
  }
  const shell = (
    <div className="app">
      <aside className={sidebar ? "sidebar open" : "sidebar"}>
        <a href="/" className="brand">
          <span className="brand-icon">
            e<span>·</span>
          </span>{" "}
          ezrabot<span className="local-label">LOCAL</span>
        </a>
        <button
          className="mobile-close icon"
          aria-label="Fermer le menu"
          onClick={() => setSidebar(false)}
        >
          <X size={20} />
        </button>
        <button className="new-chat" onClick={openHome}>
          <Plus size={18} />
          Parler à Mino
          <ArrowRight size={16} />
        </button>
        {port && <SearchBox port={port} />}
        <nav>
          {nav.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={route.page === id ? "nav-item selected" : "nav-item"}
              onClick={() => {
                if (id === "chat") openHome();
                else if (id === "missions") go({ page: "missions" });
                else if (id === "results") go({ page: "results" });
                else if (id === "projects") go({ page: "projects" });
                else if (id === "characters")
                  go({
                    page: "characters",
                    botId: view?.activeBotId || undefined,
                  });
                else go({ page: "carnet" });
              }}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="section-label">
          CONVERSATIONS<span>{view?.bots.length ?? "—"}</span>
        </div>
        <div className="threads">
          {view?.bots.map((bot) => (
            <button
              key={bot.id}
              className={
                route.page === "chat" && route.botId === bot.id
                  ? "thread current"
                  : "thread"
              }
              onClick={() => go({ page: "chat", botId: bot.id })}
            >
              <Mascot shape={bot.shape} color={bot.color} size={34} />
              <span>
                <strong>{bot.name}</strong>
                <small>
                  {view.messages.filter((m) => m.threadBotId === bot.id).at(-1)
                    ?.text ?? bot.title}
                </small>
              </span>
              {route.page === "chat" && route.botId === bot.id && (
                <span className="thread-dot" />
              )}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button className="computer" onClick={() => setDialog("computer")}>
            <span className="computer-icon">
              <Monitor size={20} />
            </span>
            <span>
              <strong>Mon ordinateur</strong>
              <small>
                <i className={offline ? "dot muted" : "dot"} />
                {offline
                  ? "Connexion interrompue"
                  : view
                    ? "Service local connecté"
                    : "Connexion…"}
              </small>
            </span>
            <ChevronDown size={14} />
          </button>
          <button className="settings" onClick={() => setDialog("settings")}>
            <Settings size={17} />
            Préférences<span>↗</span>
          </button>
        </div>
      </aside>
      {sidebar && (
        <button
          className="scrim"
          aria-label="Fermer le menu"
          onClick={() => setSidebar(false)}
        />
      )}
      <main>
        <header>
          <div className="header-left">
            <button
              className="icon menu"
              aria-label="Ouvrir le menu"
              onClick={() => setSidebar(!sidebar)}
            >
              <PanelLeft size={20} />
            </button>
            {selectedBot && route.page === "chat" ? (
              <button
                className="bot-title"
                onClick={() =>
                  go({ page: "characters", botId: selectedBot.id })
                }
                onPointerDown={() => {
                  press.current = setTimeout(() => setFan(true), 550);
                }}
                onPointerUp={() => {
                  if (press.current) clearTimeout(press.current);
                }}
                onPointerLeave={() => {
                  if (press.current) clearTimeout(press.current);
                }}
              >
                <Mascot
                  shape={selectedBot.shape}
                  color={selectedBot.color}
                  size={30}
                />
                <strong>{selectedBot.name}</strong>
                <ChevronDown size={13} />
              </button>
            ) : (
              <strong>
                {route.page === "document"
                  ? "Document"
                  : nav.find((n) => n.id === route.page)?.label}
              </strong>
            )}
          </div>
          <div className="header-right">
            <span className="private">
              <span className="lock-dot" />
              Espace personnel
            </span>
            <button
              className="icon"
              aria-label="Ordinateur et connexion téléphone"
              onClick={() => setDialog("computer")}
            >
              <Monitor size={19} />
            </button>
            <button
              className="icon"
              aria-label="Options de la conversation"
              onClick={() => setDialog("settings")}
            >
              <MoreHorizontal size={22} />
            </button>
          </div>
        </header>
        {(error || offline) && (
          <div className="error" role="alert">
            {error || offline}
            {selectionPending && (
              <button
                className="outline"
                onClick={() => void select(selectionPending)}
              >
                Réessayer la sélection
              </button>
            )}
            <button
              className="icon"
              aria-label="Fermer l’erreur"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {view?.erasure === "incomplete" && (
          <div className="error" role="status">
            Le nettoyage des copies locales n’est pas terminé.
            <button
              className="outline"
              onClick={async () => {
                const result = await runner.app({
                  type: "storage.purge",
                  requestId: uid(),
                });
                if (result.kind !== "accepted") setError(result.message);
              }}
            >
              Réessayer le nettoyage
            </button>
          </div>
        )}
        {port && <AgentRecovery port={port} />}
        {!port ? (
          <div className="empty">
            <h2>Connexion à votre ordinateur…</h2>
            <p>
              Les échanges ne sont affichés qu’après la réponse du service
              local.
            </p>
          </div>
        ) : route.page === "chat" ? (
          <ChatPage
            port={port}
            botId={route.botId}
            focusMessageId={route.messageId}
            source={
              route.source &&
              sourceChoice(port, route.botId, route.source, () =>
                go({ page: "chat", botId: route.botId }),
              )
            }
            drafts={drafts}
            slots={{
              task: (message) => <TaskCard port={port} message={message} />,
              mission: (message) => (
                <MissionProposal port={port} message={message} />
              ),
              tools: (message) => <ToolCards port={port} message={message} />,
              memory: (message) => (
                <MemoryTrace port={port} message={message} />
              ),
            }}
          />
        ) : (
          <div className="app-page">
            {route.page === "document" ? (
              <DocumentPanel
                key={`${port.view.spaceId}:${route.workId}`}
                port={port}
                workId={route.workId}
                drafts={drafts}
                versionId={route.versionId}
              />
            ) : route.page === "results" ? (
              <ResultsPage port={port} unavailable={Boolean(offline)} />
            ) : route.page === "projects" ? (
              <ProjectsPage port={port} />
            ) : route.page === "missions" ? (
              route.missionId ? (
                <MissionPanel port={port} missionId={route.missionId} />
              ) : (
                <MissionList port={port} />
              )
            ) : route.page === "characters" ? (
              <>
                <div className="character-tabs">
                  {port.view.bots.map((bot) => (
                    <button
                      className="outline"
                      key={bot.id}
                      onClick={() => go({ page: "characters", botId: bot.id })}
                    >
                      <Mascot shape={bot.shape} color={bot.color} size={25} />
                      {bot.name}
                    </button>
                  ))}
                  <button
                    className="outline"
                    onClick={() => go({ page: "characters" })}
                  >
                    <Plus size={16} />
                    Nouveau personnage
                  </button>
                </div>
                {route.botId ? (
                  <CharacterPanel
                    key={route.botId}
                    port={port}
                    botId={route.botId}
                  />
                ) : (
                  <CharacterCreate port={port} />
                )}
              </>
            ) : (
              <div className="content-page">
                <div className="eyebrow">VOTRE CARNET LOCAL</div>
                <h1>Les idées à garder.</h1>
                {port.view.carnet.map((publication) => (
                  <article key={publication.id} className="publication">
                    <span className="card-label">
                      PUBLIÉ · VERSION {publication.versionN} ·{" "}
                      {new Date(publication.createdAt).toLocaleDateString(
                        "fr-CA",
                      )}
                    </span>
                    <h2>{publication.title}</h2>
                    <Markdown text={publication.body} />
                    <div className="actions">
                      <a
                        className="outline"
                        href={`/api/publications/${publication.id}/download`}
                      >
                        <Download size={16} />
                        Télécharger
                      </a>
                      <button
                        className="outline"
                        onClick={() =>
                          go({
                            page: "document",
                            workId: publication.workId,
                            versionId: publication.versionId,
                          })
                        }
                      >
                        Ouvrir la version publiée
                        <ArrowRight size={16} />
                      </button>
                    </div>
                  </article>
                ))}
                {!port.view.carnet.length && (
                  <div className="empty">
                    <BookOpen size={38} />
                    <h3>Votre carnet attend ses premières idées.</h3>
                    <p>
                      Un document doit être confirmé avant sa publication
                      locale.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {fan && (
          <div className="shell-fan">
            <div className="fan-heading">
              Changer de compagnon
              <button
                className="icon"
                onClick={() => setFan(false)}
                aria-label="Fermer"
              >
                <X size={16} />
              </button>
            </div>
            {view?.bots.map((bot) => (
              <button
                key={bot.id}
                onClick={() => go({ page: "chat", botId: bot.id })}
              >
                <Mascot shape={bot.shape} color={bot.color} size={45} />
                {bot.name}
              </button>
            ))}
          </div>
        )}
        <footer>
          <span className="brand-tiny">ezrabot</span>
          <span>À vos côtés, sur votre ordinateur.</span>
          <span className="footer-dot">✳</span>
        </footer>
      </main>
      {dialog && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDialog(null);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Préférences et connexion"
          >
            <button
              className="modal-close icon"
              aria-label="Fermer"
              onClick={() => setDialog(null)}
            >
              <X size={20} />
            </button>
            {dialog === "computer" ? (
              <>
                <Monitor size={32} />
                <h2>Votre ordinateur, votre espace.</h2>
                <p>
                  Le PC conserve les échanges et exécute les missions acceptées.
                  Il doit rester allumé pendant le travail.
                </p>
                <div className="info-row">
                  <span>Service PC</span>
                  <strong>
                    {offline ? "Déconnecté" : "Connecté en local"}
                  </strong>
                </div>
                <div className="info-row">
                  <span>Moteur Codex</span>
                  <strong>
                    {view?.engine.state === "ready"
                      ? "Disponible"
                      : "Indisponible"}
                  </strong>
                </div>
                {view?.engine.state === "unavailable" && (
                  <p className="notice">{view.engine.message}</p>
                )}
                <a className="black" href="/devices">
                  Connecter mon téléphone
                  <ArrowRight size={16} />
                </a>
                <small>
                  Connexion privée HTTPS et Tailscale requise. L’association
                  doit être approuvée sur le PC.
                </small>
              </>
            ) : (
              <>
                <Settings size={28} />
                <h2>Votre espace personnel</h2>
                <p>
                  React et Three.js avec les données conservées sur votre PC.
                </p>
                <a
                  className="outline"
                  href={`/api/export?threadBotId=${encodeURIComponent(view?.activeBotId ?? "")}`}
                >
                  <Download size={16} />
                  Exporter la conversation
                </a>
                {selectedBot && (
                  <button
                    className="outline"
                    onClick={() =>
                      go({ page: "characters", botId: selectedBot.id })
                    }
                  >
                    Personnaliser {selectedBot.name}
                    <ArrowRight size={16} />
                  </button>
                )}
                <a className="outline" href="/advanced">
                  Client de référence
                  <ArrowRight size={16} />
                </a>
                {port && <ToolConnections port={port} />}
                <p className="notice">
                  Les animations suivent le mouvement réduit du système. Aucun
                  secret n’est stocké dans le client.
                </p>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
  return <AgentOutboxProvider value={outbox}>{shell}</AgentOutboxProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
