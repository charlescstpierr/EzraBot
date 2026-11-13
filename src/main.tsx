import { attachmentStorage, hydrateAttachments } from "./chat/durable";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  Plus,
  MessageCircle,
  Folder,
  BookOpen,
  Smartphone,
  Settings,
  PanelLeft,
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
import type { BotSheetTarget, CommandRunner, Port, Route } from "./port";
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
import { MissionProposal, MissionList, MissionPanel } from "./missions";
import { ProjectsPage } from "./projects";
import {
  BotSheet,
  BotSwitcher,
  ModelPicker,
  CharacterGallery,
  CharacterPanel,
} from "./characters";
import { Sheet } from "./Sheet";
import { ToolCards, ToolConnections } from "./tools";
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
    [botSheet, setBotSheet] = useState<BotSheetTarget | null>(null),
    [greeted, setGreeted] = useState(0),
    [route, setRoute] = useState<Route>({ page: "chat", botId: "" });
  const [selectionPending, setSelectionPending] =
    useState<CommandOf<"bot.select"> | null>(null);
  const drafts = useMemo(
    () =>
      openDrafts({
        local: attachmentStorage,
        session: browserStorage("sessionStorage"),
      }),
    [],
  );
  const retiredSpaces = useRef(new Set<string>()),
    currentSpace = useRef<string | null>(null);
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
    setBotSheet(null);
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
    // Runs after the closed sheet has restored focus to its opener, so the new conversation keeps it.
    if (greeted)
      document
        .querySelector<HTMLTextAreaElement>(".ez-chat-composer textarea")
        ?.focus();
  }, [greeted]);
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
    setBotSheet(null);
    if (next.page === "chat" && next.botId && next.botId !== view?.activeBotId)
      void select({ type: "bot.select", requestId: uid(), botId: next.botId });
  }
  function openBot(target: BotSheetTarget) {
    setSidebar(false);
    setDialog(null);
    setBotSheet(target);
  }
  const port: Port | null =
    view && run ? { view, agents, run, go, openBot } : null;
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
    { id: "chat", label: "Conversations", Icon: MessageCircle },
    { id: "missions", label: "Missions", Icon: Sparkles },
    { id: "projects", label: "Projets", Icon: Folder },
    { id: "carnet", label: "Documents", Icon: BookOpen },
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
          ezrabot
        </a>
        <button
          className="mobile-close icon"
          aria-label="Fermer le menu"
          onClick={() => setSidebar(false)}
        >
          <X size={20} />
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
                else if (id === "projects") go({ page: "projects" });
                else if (id === "characters") go({ page: "characters" });
                else go({ page: "carnet" });
              }}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="section-label">
          Conversations
          <button
            className="icon"
            aria-label="Nouveau personnage"
            onClick={() => openBot({ mode: "create" })}
          >
            <Plus size={16} />
          </button>
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
                    ?.text ?? ""}
                </small>
              </span>
              {route.page === "chat" && route.botId === bot.id && (
                <span className="thread-dot" />
              )}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button
            className="nav-item"
            onClick={() => {
              setDialog("computer");
              setSidebar(false);
            }}
          >
            <Smartphone size={18} />
            Connexion téléphone
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
            {port && selectedBot && route.page === "chat" ? (
              <>
                <BotSwitcher port={port} bot={selectedBot} />
                <ModelPicker port={port} bot={selectedBot} />
              </>
            ) : (
              <strong>
                {route.page === "document"
                  ? "Document"
                  : nav.find((n) => n.id === route.page)?.label}
              </strong>
            )}
          </div>
          <div className="header-right">
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
            drafts={drafts}
            slots={{
              task: (message) => <TaskCard port={port} message={message} />,
              mission: (message) => (
                <MissionProposal port={port} message={message} />
              ),
              tools: (message) => <ToolCards port={port} message={message} />,
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
            ) : route.page === "projects" ? (
              <ProjectsPage port={port} />
            ) : route.page === "missions" ? (
              route.missionId ? (
                <MissionPanel port={port} missionId={route.missionId} />
              ) : (
                <MissionList port={port} />
              )
            ) : route.page === "characters" ? (
              route.botId ? (
                <CharacterPanel
                  key={route.botId}
                  port={port}
                  botId={route.botId}
                />
              ) : (
                <CharacterGallery port={port} />
              )
            ) : (
              <div className="content-page">
                <h1>Documents</h1>
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
                    <h3>Aucun document publié.</h3>
                    <p>
                      Demandez un document dans une conversation, puis
                      validez-le et publiez-le pour le retrouver ici.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
      {dialog && (
        <Sheet
          label="Préférences et connexion"
          className="modal"
          onClose={() => setDialog(null)}
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
              <Smartphone size={28} />
              <h2>Connexion téléphone</h2>
              <a className="black" href="/devices">
                Associer un téléphone
                <ArrowRight size={16} />
              </a>
              <small>
                Connexion privée HTTPS et Tailscale requise. L’association doit
                être approuvée sur le PC.
              </small>
            </>
          ) : (
            <>
              <Settings size={28} />
              <h2>Préférences</h2>
              <div className="info-row">
                <span>Service PC</span>
                <strong>{offline ? "Déconnecté" : "Connecté en local"}</strong>
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
                    openBot({ mode: "edit", botId: selectedBot.id })
                  }
                >
                  Modifier {selectedBot.name}
                  <ArrowRight size={16} />
                </button>
              )}
              <a className="outline" href="/advanced">
                Client de référence
                <ArrowRight size={16} />
              </a>
              {port && <ToolConnections port={port} />}
            </>
          )}
        </Sheet>
      )}
      {port && botSheet && (
        <BotSheet
          key={botSheet.mode === "edit" ? botSheet.botId : "new"}
          port={port}
          target={botSheet}
          onClose={() => setBotSheet(null)}
          onCreated={(botId) => {
            go({ page: "chat", botId });
            setGreeted((n) => n + 1);
          }}
        />
      )}
    </div>
  );
  return <AgentOutboxProvider value={outbox}>{shell}</AgentOutboxProvider>;
}
void hydrateAttachments().then(() =>
  createRoot(document.getElementById("root")!).render(<App />),
);
