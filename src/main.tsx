import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  ArrowRight,
  Plus,
  Search,
  MessageCircle,
  Folder,
  BookOpen,
  Monitor,
  Settings,
  PanelLeft,
  ChevronDown,
  X,
  Check,
  ArrowDown,
  Download,
  Square,
  MoreHorizontal,
  Sparkles,
  FileText,
} from "lucide-react";
import MarkdownIt from "markdown-it";
import type {
  AppView,
  BotView,
  Command,
  MessageView,
  WorkView,
} from "../server/src/protocol";
import type {
  AgentsView,
  MissionDetail,
  AgentCommand,
} from "../server/src/agent-protocol";
import { command, get, uid, statuses, CommandRefusal } from "./api";
import { Mascot } from "./Mascot";
import { storage, storageUnavailable } from "./storage";
import "./style.css";
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
function Markdown({ text }: { text: string }) {
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{ __html: md.render(text) }}
    />
  );
}
function mentions(text: string, bots: BotView[]) {
  return bots
    .flatMap((b) => {
      const result: { botId: string; start: number; end: number }[] = [];
      let at = 0;
      while ((at = text.indexOf("@" + b.name, at)) !== -1) {
        const end = at + b.name.length + 1;
        if (
          (at === 0 || /\s/.test(text[at - 1])) &&
          (end === text.length || /[\s.,!?]/.test(text[end]))
        )
          result.push({ botId: b.id, start: at, end });
        at = end;
      }
      return result;
    })
    .sort((a, b) => a.start - b.start);
}
function App() {
  const [view, setView] = useState<AppView | null>(null),
    [agents, setAgents] = useState<AgentsView | null>(null),
    [offline, setOffline] = useState(""),
    [error, setError] = useState(""),
    [botId, setBotId] = useState(""),
    [page, setPage] = useState("chat"),
    [sidebar, setSidebar] = useState(false),
    [search, setSearch] = useState(""),
    [dialog, setDialog] = useState<string | null>(null),
    [fan, setFan] = useState(false),
    [invite, setInvite] = useState(false),
    [sending, setSending] = useState(false),
    [draft, setDraft] = useState(""),
    [last, setLast] = useState(true),
    [mission, setMission] = useState<MissionDetail | null>(null),
    [workId, setWorkId] = useState("");
  const [form, setForm] = useState({
    name: "",
    path: "",
    goal: "",
    projectId: "",
    memory: "",
    leadBotId: "",
  });
  const [proposal, setProposal] = useState<MessageView | null>(null);
  const scroll = useRef<HTMLDivElement>(null),
    textarea = useRef<HTMLTextAreaElement>(null),
    follow = useRef(true),
    sendLock = useRef(false),
    press = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const [v, a] = await Promise.all([
          get<AppView>("/api/view", abort.signal),
          get<AgentsView>("/api/agents/view", abort.signal),
        ]);
        setView(v);
        setAgents(a);
        setOffline("");
      } catch (e) {
        if (!abort.signal.aborted) setOffline((e as Error).message);
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 1800);
    }
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const modal = document.querySelector<HTMLElement>(".modal");
    const focusables = () =>
      Array.from(
        modal?.querySelectorAll<HTMLElement>(
          "button:not([disabled]),a[href],input,textarea,select",
        ) ?? [],
      );
    focusables()[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDialog(null);
      if (e.key === "Tab") {
        const items = focusables();
        const first = items[0],
          end = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          end?.focus();
        } else if (!e.shiftKey && document.activeElement === end) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, [dialog]);
  const bot = view?.bots.find((b) => b.id === (botId || view.activeBotId));
  const key = view && bot ? `mimobot:${view.spaceId}:${bot.id}` : "";
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    setDraft(key ? (storage.getItem(key + ":draft") ?? "") : "");
  }, [key]);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height =
        Math.min(128, textarea.current.scrollHeight) + "px";
    }
  }, [draft]);
  function changeDraft(value: string) {
    setDraft(value);
    if (key) storage.setItem(key + ":draft", value);
  }
  const messages =
    view?.messages.filter((m) => m.threadBotId === bot?.id) ?? [];
  useEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [view?.rev, bot?.id, page]);
  useEffect(() => {
    if (!mission) return;
    const abort = new AbortController();
    const t = setInterval(() => {
      void get<{ mission: MissionDetail }>(
        `/api/agents/missions/${mission.id}`,
        abort.signal,
      )
        .then((r) => setMission(r.mission))
        .catch(() => {});
    }, 1700);
    return () => {
      clearInterval(t);
      abort.abort();
    };
  }, [mission?.id]);
  async function run(c: Command | AgentCommand, agent = false) {
    setError("");
    try {
      const v = await command(c, agent);
      agent ? setAgents(v as AgentsView) : setView(v as AppView);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  function select(b: BotView) {
    setBotId(b.id);
    setPage("chat");
    setFan(false);
    setSidebar(false);
    follow.current = true;
  }
  async function send() {
    if (!bot || !key || sendLock.current) return;
    let pending: Command | null = null;
    try {
      pending = JSON.parse(storage.getItem(key + ":pending") ?? "null");
    } catch {}
    if (!pending && !draft.trim()) return;
    const input = pending ?? {
      type: "message.say" as const,
      requestId: uid(),
      botId: bot.id,
      text: draft.trim(),
      attachments: [],
      mentions: mentions(draft.trim(), view?.bots ?? []),
    };
    const submitted = "text" in input ? input.text : "";
    sendLock.current = true;
    setSending(true);
    storage.setItem(key + ":pending", JSON.stringify(input));
    try {
      const v = await command(input);
      setView(v as AppView);
      storage.removeItem(key + ":pending");
      if (storage.getItem(key + ":draft") === submitted) {
        storage.removeItem(key + ":draft");
        if (currentKey.current === key) setDraft("");
      }
      setError("");
      follow.current = true;
    } catch (e) {
      if (e instanceof CommandRefusal) storage.removeItem(key + ":pending");
      setError(
        (e as Error).message +
          (e instanceof CommandRefusal
            ? ""
            : " Réessayez : le même envoi sera repris sans doublon."),
      );
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }
  async function openMission(id: string) {
    try {
      const r = await get<{ mission: MissionDetail }>(
        `/api/agents/missions/${id}`,
      );
      setMission(r.mission);
      setDialog("mission");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const active =
    view?.works.filter(
      (w) =>
        w.threadBotId === bot?.id && ["pending", "running"].includes(w.state),
    ) ?? [];
  const work = view?.works.find((w) => w.id === workId);
  const nav = [
    { id: "chat", label: "Conversation", Icon: MessageCircle },
    { id: "missions", label: "Missions", Icon: Sparkles },
    { id: "projects", label: "Projets", Icon: Folder },
    { id: "carnet", label: "Carnet", Icon: BookOpen },
  ];
  return (
    <div className="app">
      <aside className={sidebar ? "sidebar open" : "sidebar"}>
        <a href="/" className="brand">
          <span className="brand-icon">
            m<span>·</span>
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
        <button
          className="new-chat"
          onClick={() => {
            const mino = view?.bots.find((b) => b.id === "mino");
            if (mino) select(mino);
            setPage("chat");
            setSidebar(false);
            textarea.current?.focus();
          }}
        >
          <Plus size={18} /> Parler à Mino <ArrowRight size={16} />
        </button>
        <div className="search">
          <Search size={16} />
          <input
            aria-label="Rechercher"
            placeholder="Rechercher…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd>⌕</kbd>
        </div>
        <nav>
          {nav.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={page === id ? "nav-item selected" : "nav-item"}
              onClick={() => {
                setPage(id);
                setSidebar(false);
              }}
            >
              <Icon size={18} />
              {label}
              {id === "missions" && !!agents?.missions.length && (
                <span className="count">{agents.missions.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="section-label">
          CONVERSATIONS <span>{view?.bots.length ?? "—"}</span>
        </div>
        <div className="threads">
          {view?.bots
            .filter((b) =>
              `${b.name} ${view.messages.filter((m) => m.threadBotId === b.id).at(-1)?.text ?? ""}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((b) => (
              <button
                key={b.id}
                className={
                  b.id === bot?.id && page === "chat"
                    ? "thread current"
                    : "thread"
                }
                onClick={() => select(b)}
              >
                <Mascot shape={b.shape} color={b.color} size={34} />
                <span>
                  <strong>{b.name}</strong>
                  <small>
                    {view.messages.filter((m) => m.threadBotId === b.id).at(-1)
                      ?.text ??
                      (b.id === "mino"
                        ? "Votre compagnon au quotidien"
                        : "Une nouvelle conversation")}
                  </small>
                </span>
                {b.id === bot?.id && <span className="thread-dot" />}
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
            <Settings size={17} /> Préférences <span>↗</span>
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
            {page === "chat" && bot ? (
              <button
                className="bot-title"
                onClick={() => setDialog("profile")}
                onPointerDown={() => {
                  press.current = setTimeout(() => {
                    setInvite(false);
                    setFan(true);
                  }, 550);
                }}
                onPointerUp={() => {
                  if (press.current) clearTimeout(press.current);
                }}
                onPointerLeave={() => {
                  if (press.current) clearTimeout(press.current);
                }}
              >
                <Mascot shape={bot.shape} color={bot.color} size={30} />
                <strong>{bot.name}</strong>
                <ChevronDown size={13} />
              </button>
            ) : (
              <strong>{nav.find((n) => n.id === page)?.label}</strong>
            )}
          </div>
          <div className="header-right">
            <span className="private">
              <span className="lock-dot" /> Espace personnel
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
        {storageUnavailable && (
          <div className="error" role="status">
            Stockage du navigateur indisponible : les brouillons restent en
            mémoire jusqu’à la fermeture.
          </div>
        )}
        {(error || offline) && (
          <div className="error" role="alert">
            {error || offline}
            <button
              className="icon"
              aria-label="Fermer l’erreur"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {page === "chat" ? (
          <>
            <div
              className="chat-scroll"
              ref={scroll}
              onScroll={() => {
                const el = scroll.current!;
                follow.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                setLast(follow.current);
              }}
            >
              {!messages.length ? (
                <div className="welcome">
                  <div className="eyebrow">
                    <span className="tiny-spark">✳</span> VOS IDÉES ONT DE LA
                    COMPAGNIE
                  </div>
                  <button
                    className="hero-mascot"
                    aria-label="Personnaliser le personnage"
                    onClick={() => setDialog("profile")}
                  >
                    {bot && (
                      <Mascot
                        shape={bot.shape}
                        color={bot.color}
                        size={148}
                        animated
                      />
                    )}
                  </button>
                  <h1>
                    {bot
                      ? `Salut, moi c’est ${bot.name}.`
                      : "Bienvenue chez vous."}
                  </h1>
                  <p>
                    Une idée en tête ? Un projet à faire avancer ?<br />
                    On s’y met ensemble.
                  </p>
                  <div className="suggestions">
                    {[
                      {
                        icon: FileText,
                        title: "Mettre mes idées au clair",
                        text: "Peux-tu m’aider à structurer mes idées ?",
                      },
                      {
                        icon: Folder,
                        title: "Avancer sur un projet",
                        text: "J’aimerais avancer sur un projet. Aide-moi à préciser mon objectif.",
                      },
                      {
                        icon: Sparkles,
                        title: "Préparer quelque chose",
                        text: "J’aimerais préparer un document. Peux-tu m’aider à définir ce dont tu as besoin ?",
                      },
                    ].map((s) => (
                      <button
                        key={s.title}
                        onClick={() => {
                          changeDraft(s.text);
                          textarea.current?.focus();
                        }}
                      >
                        <s.icon size={19} />
                        <span>{s.title}</span>
                        <ArrowUp size={15} />
                      </button>
                    ))}
                  </div>
                  <div className="welcome-note">
                    <span /> Un petit compagnon. De grandes possibilités.
                  </div>
                </div>
              ) : (
                <div className="messages">
                  <div className="date-divider">
                    {new Date(messages[0].createdAt).toLocaleDateString(
                      "fr-CA",
                      { day: "numeric", month: "long" },
                    )}
                  </div>
                  {messages.map((m) => {
                    const author = view?.bots.find((b) => b.id === m.botId);
                    const linked = agents?.missions.find(
                      (x) => x.originMessageId === m.id,
                    );
                    return (
                      <article key={m.id} className={`message ${m.role}`}>
                        {m.role === "assistant" && (
                          <div className="author">
                            <Mascot
                              shape={author?.shape}
                              color={author?.color}
                              size={25}
                            />
                            <strong>
                              {author?.name ?? "Personnage supprimé"}
                            </strong>
                            <time>
                              {new Date(m.createdAt).toLocaleTimeString(
                                "fr-CA",
                                { hour: "2-digit", minute: "2-digit" },
                              )}
                            </time>
                          </div>
                        )}
                        <Markdown text={m.text} />
                        {m.handoff && (
                          <div className="mission-card">
                            <span className="card-label">
                              <Sparkles size={15} /> UNE MISSION POUR VOTRE PC
                            </span>
                            <h3>{m.handoff.goal}</h3>
                            <p>{m.handoff.why}</p>
                            <button
                              className="black"
                              onClick={() => {
                                if (linked) {
                                  void openMission(linked.id);
                                } else {
                                  setProposal(m);
                                  setForm((f) => ({
                                    ...f,
                                    goal: m.handoff!.goal,
                                    projectId: "",
                                  }));
                                  setDialog("prepare");
                                }
                              }}
                            >
                              {linked
                                ? "Suivre la mission"
                                : "Examiner la proposition"}
                              <ArrowRight size={16} />
                            </button>
                          </div>
                        )}
                        {view?.works
                          .filter(
                            (w) =>
                              w.requestMessageId === m.id && w.versions.length,
                          )
                          .map((w) => (
                            <button
                              className="document-row"
                              key={w.id}
                              onClick={() => {
                                setWorkId(w.id);
                                setDialog("work");
                              }}
                            >
                              <FileText size={22} />
                              <span>
                                <strong>{w.title}</strong>
                                <small>
                                  {statuses[w.state]} · {w.versions.length}{" "}
                                  version(s)
                                </small>
                              </span>
                              <ArrowRight size={17} />
                            </button>
                          ))}
                      </article>
                    );
                  })}
                  {active.map((w) => (
                    <div className="working" key={w.id}>
                      <span className="pulse" />
                      {w.attempt?.stage === "writing"
                        ? "Rédaction en cours…"
                        : "Travail en cours…"}
                      <button
                        onClick={() =>
                          void run({
                            type: "work.cancel",
                            requestId: uid(),
                            workId: w.id,
                          })
                        }
                      >
                        <Square size={12} /> Arrêter
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="composer-area">
              {!last && (
                <button
                  className="latest"
                  onClick={() => {
                    scroll.current?.scrollTo({
                      top: scroll.current.scrollHeight,
                      behavior: "smooth",
                    });
                    follow.current = true;
                  }}
                >
                  <ArrowDown size={16} /> Derniers messages
                </button>
              )}
              <form
                className={draft.trim() ? "composer filled" : "composer"}
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <button
                  type="button"
                  className="mention"
                  aria-label="Inviter un personnage"
                  onClick={() => {
                    setInvite(true);
                    setFan(!fan);
                  }}
                >
                  ＠
                </button>
                <textarea
                  maxLength={6000}
                  ref={textarea}
                  aria-label="Message"
                  placeholder={`Qu’est-ce qu’on fait aujourd’hui${bot ? " " + bot.name : ""} ?`}
                  value={draft}
                  disabled={!bot}
                  rows={1}
                  onChange={(e) => changeDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <button
                  className="send"
                  aria-label="Envoyer le message"
                  disabled={
                    sending ||
                    !bot ||
                    (!draft.trim() && !storage.getItem(key + ":pending"))
                  }
                >
                  <ArrowUp size={21} />
                </button>
              </form>
              <div className="composer-note">
                <span>
                  {view?.engine.state === "ready"
                    ? "Codex · session locale"
                    : view?.engine.state === "unavailable"
                      ? "Moteur indisponible · brouillon conservé"
                      : "Connexion au moteur…"}
                </span>
                <span>Vos échanges restent sur votre ordinateur.</span>
              </div>
              {fan && (
                <div className="bot-fan">
                  <div className="fan-heading">
                    {invite ? "Inviter dans ce fil" : "Changer de compagnon"}
                    <button
                      className="icon"
                      onClick={() => setFan(false)}
                      aria-label="Fermer"
                    >
                      <X size={16} />
                    </button>
                  </div>
                  {view?.bots.map((b) => (
                    <button
                      key={b.id}
                      onClick={() => {
                        if (invite) {
                          changeDraft(draft + ` @${b.name} `);
                          setFan(false);
                          textarea.current?.focus();
                        } else select(b);
                      }}
                    >
                      <Mascot shape={b.shape} color={b.color} size={48} />
                      {b.name}
                    </button>
                  ))}
                  <small>
                    {invite
                      ? "Un invité ne partage pas ses souvenirs privés."
                      : "Chaque compagnon garde sa propre conversation."}
                  </small>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="content-page">
            <div className="page-heading">
              <div>
                <div className="eyebrow">VOTRE ESPACE</div>
                <h1>
                  {page === "projects"
                    ? "Un endroit pour chaque idée."
                    : page === "missions"
                      ? "Les choses avancent."
                      : "Les idées à garder."}
                </h1>
                <p>
                  {page === "projects"
                    ? "Les dossiers que vous confiez à votre compagnon."
                    : page === "missions"
                      ? "Retrouvez le travail confié à votre ordinateur."
                      : "Les documents que vous avez publiés dans votre carnet local."}
                </p>
              </div>
              {page === "projects" && (
                <button className="black" onClick={() => setDialog("project")}>
                  <Plus size={17} /> Ajouter un dossier
                </button>
              )}
            </div>
            {page === "projects" && (
              <div className="project-grid">
                {agents?.projects
                  .filter(
                    (p) =>
                      !p.archived &&
                      p.name.toLowerCase().includes(search.toLowerCase()),
                  )
                  .map((p) => (
                    <div className="project-card" key={p.id}>
                      <Folder size={26} />
                      <h3>{p.name}</h3>
                      <code>{p.path}</code>
                      <small>
                        {
                          agents.missions.filter((m) => m.projectId === p.id)
                            .length
                        }{" "}
                        mission(s)
                      </small>
                      <button
                        onClick={() => {
                          setProposal(null);
                          setForm((f) => ({ ...f, goal: "", projectId: p.id }));
                          setDialog("prepare");
                        }}
                      >
                        Préparer une mission <ArrowRight size={15} />
                      </button>
                    </div>
                  ))}
              </div>
            )}
            {page === "missions" &&
              agents?.missions
                .filter(
                  (m) =>
                    !m.parentId &&
                    m.title.toLowerCase().includes(search.toLowerCase()),
                )
                .map((m) => (
                  <button
                    className="list-row"
                    key={m.id}
                    onClick={() => void openMission(m.id)}
                  >
                    <span className="row-symbol">
                      <Sparkles size={22} />
                    </span>
                    <span>
                      <strong>{m.title}</strong>
                      <small>
                        {
                          agents.projects.find((p) => p.id === m.projectId)
                            ?.name
                        }{" "}
                        · {new Date(m.createdAt).toLocaleDateString("fr-CA")}
                      </small>
                    </span>
                    <span className={`badge ${m.status}`}>
                      {statuses[m.status] ?? m.status}
                    </span>
                    <ArrowRight size={18} />
                  </button>
                ))}
            {page === "carnet" &&
              view?.carnet.map((p) => (
                <div className="publication" key={p.id}>
                  <span className="card-label">
                    DOCUMENT · VERSION {p.versionN}
                  </span>
                  <h2>{p.title}</h2>
                  <Markdown text={p.body} />
                  <a
                    className="outline"
                    href={`/api/publications/${p.id}/download`}
                  >
                    <Download size={16} /> Télécharger
                  </a>
                </div>
              ))}
            {((page === "projects" &&
              !agents?.projects.some((p) => !p.archived)) ||
              (page === "missions" && !agents?.missions.length) ||
              (page === "carnet" && !view?.carnet.length)) && (
              <div className="empty">
                <BookOpen size={38} strokeWidth={1} />
                <h3>
                  {page === "projects"
                    ? "Tout commence par un dossier."
                    : page === "missions"
                      ? "La place pour votre prochaine mission."
                      : "Votre carnet attend ses premières idées."}
                </h3>
                <p>
                  {page === "projects"
                    ? "Ajoutez un dossier depuis cet ordinateur pour y travailler ensemble."
                    : "Parlez à Mino pour préparer la suite."}
                </p>
                <button
                  className="outline"
                  onClick={() =>
                    page === "projects"
                      ? setDialog("project")
                      : (() => {
                          const mino = view?.bots.find((b) => b.id === "mino");
                          if (mino) select(mino);
                          setPage("chat");
                        })()
                  }
                >
                  {page === "projects"
                    ? "Ajouter un dossier"
                    : "Retrouver Mino"}
                  <ArrowRight size={16} />
                </button>
              </div>
            )}
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
            aria-label="Détails"
          >
            <button
              className="modal-close icon"
              onClick={() => setDialog(null)}
              aria-label="Fermer"
            >
              <X size={20} />
            </button>
            {dialog === "computer" && (
              <>
                <Monitor size={32} />
                <h2>Votre ordinateur, votre espace.</h2>
                <p>
                  Le service local conserve vos échanges et exécute les missions
                  acceptées. Il doit rester allumé pendant le travail.
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
                  Connecter mon téléphone <ArrowRight size={16} />
                </a>
                <small>
                  Connexion privée HTTPS et Tailscale requise. L’association
                  doit être approuvée sur le PC.
                </small>
              </>
            )}
            {dialog === "settings" && (
              <>
                <Settings size={28} />
                <h2>Votre espace personnel</h2>
                <p>
                  React et Three.js, avec le moteur et les données conservés sur
                  votre PC.
                </p>
                <a
                  className="outline"
                  href={`/api/export?threadBotId=${encodeURIComponent(bot?.id ?? "")}`}
                >
                  <Download size={16} /> Exporter cette conversation
                </a>
                <button
                  className="outline"
                  onClick={() => setDialog("profile")}
                >
                  Personnaliser {bot?.name}
                  <ArrowRight size={16} />
                </button>
                <a className="outline" href="/advanced">
                  Ouvrir les fonctions avancées
                  <ArrowRight size={16} />
                </a>
                <p className="notice">
                  Les animations suivent la préférence « mouvement réduit » de
                  votre système.
                </p>
              </>
            )}
            {dialog === "profile" && bot && <Profile bot={bot} run={run} />}
            {dialog === "project" && (
              <>
                <Folder size={30} />
                <h2>Un nouveau projet.</h2>
                <p>
                  Choisissez explicitement le dossier autorisé sur ce PC. Aucun
                  travail ne démarre à cette étape.
                </p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await run(
                        {
                          type: "project.add",
                          requestId: uid(),
                          name: form.name,
                          path: form.path,
                        },
                        true,
                      )
                    ) {
                      setDialog(null);
                      setPage("projects");
                    }
                  }}
                >
                  <label>
                    Nom du projet
                    <input
                      required
                      value={form.name}
                      onChange={(e) =>
                        setForm({ ...form, name: e.target.value })
                      }
                      placeholder="Mon prochain projet"
                    />
                  </label>
                  <label>
                    Chemin absolu du dossier
                    <input
                      required
                      value={form.path}
                      onChange={(e) =>
                        setForm({ ...form, path: e.target.value })
                      }
                      placeholder="/home/…/mon-projet"
                    />
                  </label>
                  <button className="black">
                    Ajouter ce dossier
                    <Plus size={16} />
                  </button>
                </form>
              </>
            )}
            {dialog === "prepare" && (
              <>
                <Sparkles size={30} />
                <h2>On prépare la mission.</h2>
                <p>
                  Vérifiez l’objectif et le dossier avant de confier le travail
                  à votre ordinateur.
                </p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await run(
                        {
                          type: "mission.create",
                          requestId: uid(),
                          projectId: form.projectId,
                          goal: form.goal,
                          model: null,
                          effort: null,
                          ...(proposal
                            ? {
                                origin: { messageId: proposal.id },
                                mode: proposal.handoff?.coordinated
                                  ? "coordinated"
                                  : "direct",
                                ...(proposal.handoff?.coordinated
                                  ? { leadBotId: form.leadBotId }
                                  : {}),
                              }
                            : {}),
                        },
                        true,
                      )
                    ) {
                      setDialog(null);
                      setPage("missions");
                    }
                  }}
                >
                  <label>
                    Objectif exact
                    <textarea
                      required
                      value={form.goal}
                      onChange={(e) =>
                        setForm({ ...form, goal: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Dossier autorisé
                    <select
                      required
                      value={form.projectId}
                      onChange={(e) =>
                        setForm({ ...form, projectId: e.target.value })
                      }
                    >
                      <option value="">Choisir un dossier…</option>
                      {agents?.projects
                        .filter((p) => !p.archived)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} — {p.path}
                          </option>
                        ))}
                    </select>
                  </label>
                  {proposal?.handoff?.coordinated && (
                    <label>
                      Responsable
                      <select
                        required
                        value={form.leadBotId}
                        onChange={(e) =>
                          setForm({ ...form, leadBotId: e.target.value })
                        }
                      >
                        <option value="">Choisir un responsable…</option>
                        {view?.bots
                          .filter((b) => b.id !== "mino")
                          .map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  <p className="notice">
                    Le travail peut modifier les fichiers du dossier. Le bac à
                    sable ne garantit pas un confinement de lecture à ce seul
                    dossier.
                  </p>
                  <button className="black">
                    Confirmer et démarrer
                    <ArrowRight size={16} />
                  </button>
                </form>
              </>
            )}
            {dialog === "mission" && mission && (
              <>
                <span className="badge">{statuses[mission.status]}</span>
                <h2>{mission.title}</h2>
                <p>{mission.goals.at(-1)?.text}</p>
                <div className="info-row">
                  <span>Dossier</span>
                  <code>
                    {
                      agents?.projects.find((p) => p.id === mission.projectId)
                        ?.path
                    }
                  </code>
                </div>
                <div className="info-row">
                  <span>Essais</span>
                  {mission.attemptsUsed} / {mission.maxAttempts}
                </div>
                {mission.live && (
                  <p className="notice">
                    {mission.live.activity ?? "Travail en cours"}
                    {mission.live.text}
                  </p>
                )}
                {mission.attempts.map((a) => (
                  <details key={a.id}>
                    <summary>
                      Essai {a.n} · {a.state}
                    </summary>
                    <h4>Rapport de l’exécutant</h4>
                    <Markdown
                      text={
                        a.finalText ?? a.errorMessage ?? "Aucun rapport reçu."
                      }
                    />
                    <h4>Fichiers constatés</h4>
                    <pre>
                      {a.observed
                        ? JSON.stringify(a.observed, null, 2)
                        : "Aucun constat reçu."}
                    </pre>
                    <h4>Résultat du contrôle</h4>
                    <pre>
                      {a.check
                        ? JSON.stringify(a.check, null, 2)
                        : "Aucun contrôle reçu."}
                    </pre>
                  </details>
                ))}
                <div className="actions">
                  {(["stop", "resume", "review", "budget"] as const)
                    .filter((a) => mission.can[a])
                    .map((a) => (
                      <button
                        className="outline"
                        key={a}
                        onClick={() =>
                          void run(
                            {
                              type: `mission.${a}`,
                              requestId: uid(),
                              missionId: mission.id,
                            } as AgentCommand,
                            true,
                          )
                        }
                      >
                        {
                          {
                            stop: "Demander l’arrêt",
                            resume: "Reprendre",
                            review: "Contrôler",
                            budget: "Ajouter des essais",
                          }[a]
                        }
                      </button>
                    ))}
                  {mission.can.accept && (
                    <button
                      className="black"
                      onClick={() =>
                        void run(
                          {
                            type: "mission.accept",
                            requestId: uid(),
                            missionId: mission.id,
                            attemptId: mission.can.accept!,
                          },
                          true,
                        )
                      }
                    >
                      Valider le résultat
                      <Check size={16} />
                    </button>
                  )}
                </div>
              </>
            )}
            {dialog === "work" && work && (
              <DocumentPanel work={work} run={run} />
            )}
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function Profile({
  bot,
  run,
}: {
  bot: BotView;
  run: (c: Command) => Promise<boolean>;
}) {
  const [name, setName] = useState(bot.name),
    [color, setColor] = useState(bot.color),
    [text, setText] = useState("");
  return (
    <>
      <Mascot shape={bot.shape} color={color} size={80} animated />
      <h2>Un compagnon à votre image.</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run({
            type: "bot.update",
            requestId: uid(),
            botId: bot.id,
            name,
            color,
          });
        }}
      >
        <label>
          Son petit nom
          <input
            maxLength={24}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Sa couleur
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
        <button className="black">
          Enregistrer
          <Check size={16} />
        </button>
      </form>
      <h3>Sa mémoire</h3>
      <p>Ces souvenirs appartiennent uniquement à {bot.name}.</p>
      {bot.memories.map((m) => (
        <div className="memory" key={m.id}>
          <span>{m.text}</span>
          <button
            className="icon"
            aria-label="Supprimer ce souvenir"
            onClick={() =>
              void run({
                type: "memory.delete",
                requestId: uid(),
                botId: bot.id,
                memoryId: m.id,
              })
            }
          >
            <X size={16} />
          </button>
        </div>
      ))}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await run({
              type: "memory.create",
              requestId: uid(),
              botId: bot.id,
              text,
            })
          )
            setText("");
        }}
      >
        <label>
          Un souvenir à garder
          <input
            required
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Quelque chose à retenir…"
          />
        </label>
        <button className="outline">
          Ajouter à sa mémoire
          <Plus size={16} />
        </button>
      </form>
    </>
  );
}
function DocumentPanel({
  work,
  run,
}: {
  work: WorkView;
  run: (c: Command) => Promise<boolean>;
}) {
  const latest = work.versions.at(-1);
  const [base, setBase] = useState(latest?.id),
    [title, setTitle] = useState(latest?.title ?? ""),
    [body, setBody] = useState(latest?.body ?? "");
  return (
    <>
      <span className="card-label">DOCUMENT · {statuses[work.state]}</span>
      <h2>{work.title}</h2>
      {latest && (
        <>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                base &&
                (await run({
                  type: "version.edit",
                  requestId: uid(),
                  workId: work.id,
                  baseVersionId: base,
                  title,
                  body,
                }))
              ) {
                const next = await get<AppView>("/api/view");
                const saved = next.works
                  .find((w) => w.id === work.id)
                  ?.versions.at(-1);
                if (saved?.title === title && saved.body === body)
                  setBase(saved.id);
              }
            }}
          >
            <label>
              Titre
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </label>
            <label>
              Contenu
              <textarea
                className="document-editor"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                required
              />
            </label>
            <button className="black">
              Enregistrer une version
              <Check size={16} />
            </button>
          </form>
          <div className="actions">
            <a className="outline" href={`/api/versions/${latest.id}/download`}>
              <Download size={16} /> Télécharger
            </a>
            <button
              className="outline"
              onClick={() =>
                void run({
                  type: "publication.propose",
                  requestId: uid(),
                  workId: work.id,
                  versionId: latest.id,
                  destination: "carnet",
                })
              }
            >
              Préparer la publication
            </button>
          </div>
          <h3>Historique</h3>
          {work.versions.map((v) => (
            <details key={v.id}>
              <summary>
                Version {v.n} · {v.source}
              </summary>
              <Markdown text={v.body} />
              <button
                className="outline"
                onClick={() =>
                  void run({
                    type: "version.restore",
                    requestId: uid(),
                    workId: work.id,
                    versionId: v.id,
                  })
                }
              >
                Restaurer dans une nouvelle version
              </button>
            </details>
          ))}
          {work.proposals
            .filter((p) => p.state === "open")
            .map((p) => (
              <div className="mission-card" key={p.id}>
                <h3>Publier dans le carnet local ?</h3>
                <strong>{p.title}</strong>
                <Markdown text={p.body} />
                <small>
                  Version {p.versionN} · Empreinte {p.payloadSha256}
                </small>
                <button
                  className="black"
                  onClick={() =>
                    void run({
                      type: "publication.approve",
                      requestId: uid(),
                      proposalId: p.id,
                      action: p.action,
                      destination: p.destination,
                      versionId: p.versionId,
                      payloadSha256: p.payloadSha256,
                    })
                  }
                >
                  Confirmer cette publication
                  <Check size={16} />
                </button>
              </div>
            ))}
        </>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
