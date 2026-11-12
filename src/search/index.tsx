import { useMemo, useState } from "react";
import { searchThread, type Hit } from "../../server/web/search";
import type { Port } from "../port";
import "./style.css";

export function SearchBox({ port }: { port: Port }) {
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState(0);
  const [open, setOpen] = useState(false);
  const hits = useMemo(
    () => searchThread(port.view, query, Number.MAX_SAFE_INTEGER),
    [port.view, query],
  );
  const index = hits.length ? Math.min(position, hits.length - 1) : 0;
  function go(hit: Hit) {
    if (hit.target.kind === "message")
      port.go({
        page: "chat",
        botId: hit.threadBotId,
        messageId: hit.target.messageId,
      });
    else
      port.go({
        page: "document",
        workId: hit.target.workId,
        versionId: hit.target.versionId,
      });
  }
  function move(delta: number) {
    if (!hits.length) return;
    const next = (index + delta + hits.length) % hits.length;
    setPosition(next);
    go(hits[next]);
  }
  return (
    <div className="ez-search">
      <label className="ez-search-field">
        <span aria-hidden="true">⌕</span>
        <input
          aria-label="Rechercher"
          placeholder="Rechercher partout…"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setPosition(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter" && hits.length) {
              e.preventDefault();
              if (e.shiftKey) move(-1);
              else if (open) {
                go(hits[index]);
                setOpen(false);
              } else move(1);
            }
          }}
        />
      </label>
      {query.trim() && (
        <div className="ez-search-navigation">
          <span role="status">
            {hits.length ? `${index + 1} / ${hits.length}` : "Aucun résultat"}
          </span>
          <button
            aria-label="Résultat précédent"
            disabled={!hits.length}
            onClick={() => move(-1)}
          >
            ↑
          </button>
          <button
            aria-label="Résultat suivant"
            disabled={!hits.length}
            onClick={() => move(1)}
          >
            ↓
          </button>
          <button
            aria-label="Effacer la recherche"
            onClick={() => {
              setQuery("");
              setOpen(false);
            }}
          >
            ×
          </button>
          <button
            aria-label="Afficher les résultats"
            onClick={() => setOpen(!open)}
          >
            …
          </button>
        </div>
      )}
      {open && query.trim() && (
        <div className="ez-search-results" aria-label="Résultats de recherche">
          <div className="ez-search-heading">
            Messages et versions courantes
            <button
              aria-label="Fermer les résultats"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>
          {hits.map((hit, i) => {
            const name =
              port.view.bots.find((b) => b.id === hit.threadBotId)?.name ??
              "Personnage supprimé";
            return (
              <button
                key={
                  hit.target.kind === "message"
                    ? hit.target.messageId
                    : hit.target.versionId
                }
                className={i === index ? "ez-search-current" : ""}
                onClick={() => {
                  setPosition(i);
                  go(hit);
                  setOpen(false);
                }}
              >
                <strong>
                  {name} ·{" "}
                  {hit.target.kind === "version"
                    ? `Document · v${hit.target.n}`
                    : hit.target.role === "user"
                      ? "Votre message"
                      : "Réponse"}
                </strong>
                <span>
                  {hit.snippet.before}
                  <mark>{hit.snippet.match}</mark>
                  {hit.snippet.after}
                </span>
              </button>
            );
          })}
          {!hits.length && (
            <p>Aucun passage ne correspond à cette recherche.</p>
          )}
        </div>
      )}
    </div>
  );
}
