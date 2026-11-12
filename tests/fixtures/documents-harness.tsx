import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRunner, getAppView } from "../../src/api";
import type { PcView } from "../../server/src/tools-protocol";
import type { Port, Route } from "../../src/port";
import { openDrafts } from "../../server/web/drafts";
import { DocumentPanel, TaskCard } from "../../src/documents";

const routeOf = (): Route => {
  const query = new URLSearchParams(location.search);
  const workId = query.get("workId");
  const versionId = query.get("versionId");
  return workId
    ? { page: "document", workId, ...(versionId ? { versionId } : {}) }
    : { page: "chat", botId: "mino" };
};
function Harness() {
  const [view, setView] = useState<PcView | null>(null);
  const [route, setRoute] = useState<Route>(routeOf);
  const drafts = useMemo(
    () => openDrafts({ local: localStorage, session: sessionStorage }),
    [],
  );
  const newer = (next: PcView) =>
    setView((seen) => (!seen || next.rev >= seen.rev ? next : seen));
  const run = useMemo(() => createRunner({ app: newer, agents() {} }), []);
  useEffect(() => {
    let live = true;
    (async () => {
      let rev: number | null = null;
      while (live) {
        try {
          const next = await getAppView(undefined, rev ?? undefined);
          rev = next.rev;
          if (live) newer(next);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  if (!view) return null;
  drafts.useSpace(view.spaceId);
  const port: Port = {
    view,
    agents: null,
    run,
    go(next) {
      setRoute(next);
      history.replaceState(
        null,
        "",
        next.page === "document"
          ? "?workId=" +
              next.workId +
              (next.versionId ? "&versionId=" + next.versionId : "")
          : location.pathname,
      );
    },
  };
  if (route.page === "document")
    return (
      <main>
        <button onClick={() => port.go({ page: "chat", botId: "mino" })}>
          Retour au fil
        </button>
        <DocumentPanel
          port={port}
          workId={route.workId}
          drafts={drafts}
          versionId={route.versionId}
        />
      </main>
    );
  return (
    <main>
      {view.messages.map((message) => (
        <article key={message.id}>
          <p>{message.text}</p>
          <TaskCard port={port} message={message} />
        </article>
      ))}
    </main>
  );
}
const rootElement = document.getElementById("root");
if (!rootElement) throw Error("Point d’entrée de recette manquant");
createRoot(rootElement).render(<Harness />);
