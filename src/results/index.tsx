import { useState } from "react";
import type { Port } from "../port";
import { CALL_STATE_LABELS } from "../documents/model";
import { activity, results } from "./model";
import "./style.css";

export function ResultsPage({
  port,
  unavailable,
}: {
  port: Port;
  unavailable: boolean;
}) {
  const [botId, setBotId] = useState("");
  const rows = results(port.view, port.agents).filter(
    (row) => !botId || row.botId === botId,
  );
  const works = port.view.works.filter(
    (work) => !botId || work.botId === botId,
  );
  return (
    <section className="results-page">
      <h1>Tous mes résultats</h1>
      <p>
        Retrouvez un document, une version publiée ou une mission à examiner.
      </p>
      {unavailable && (
        <p role="status">
          Connexion interrompue. Les résultats affichés peuvent ne plus être à
          jour.
        </p>
      )}
      {!port.agents && (
        <p role="status">
          Les résultats de missions ne sont pas encore disponibles.
        </p>
      )}
      <label className="results-filter">
        Personnage
        <select
          value={botId}
          onChange={(event) => setBotId(event.target.value)}
        >
          <option value="">Tous les personnages</option>
          {port.view.bots.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      </label>
      {!rows.length && (
        <p>
          {botId
            ? "Aucun résultat pour ce personnage."
            : "Aucun résultat enregistré pour le moment."}
        </p>
      )}
      <ul className="results-list" aria-label="Résultats enregistrés">
        {rows.map((row) => (
          <li key={row.id}>
            <button onClick={() => port.go(row.destination)}>
              <strong>{row.title}</strong>
              <span>{row.label}</span>
              <small>
                {row.author ??
                  port.view.bots.find((bot) => bot.id === row.botId)?.name ??
                  "Personnage supprimé"}{" "}
                ·{" "}
                <time dateTime={row.date}>
                  {new Date(row.date).toLocaleString("fr-CA")}
                </time>
              </small>
              <span className="results-open">
                Ouvrir{" "}
                {row.destination.page === "document"
                  ? "cette version"
                  : "la mission"}{" "}
                →
              </span>
            </button>
          </li>
        ))}
      </ul>
      {works.length > 0 && (
        <details className="results-activity">
          <summary>Activité des travaux</summary>
          <ul>
            {works.map((work) => (
              <li key={work.id}>
                <strong>{work.title}</strong> · {activity(work)}
                <details>
                  <summary>Détails de l’activité</summary>
                  <p>
                    {port.view.bots.find((bot) => bot.id === work.botId)
                      ?.name ?? "Personnage supprimé"}
                  </p>
                  {work.attempt ? (
                    <>
                      <p>
                        Tentative {work.attempt.n} ·{" "}
                        {work.attempt.state === "running"
                          ? activity(work)
                          : CALL_STATE_LABELS[work.attempt.state]}
                      </p>
                      {work.attempt.error && <p>{work.attempt.error}</p>}
                      <p>
                        {work.attempt.usage
                          ? `${work.attempt.usage.total.total.toLocaleString("fr-CA")} jetons signalés`
                          : "Consommation non disponible"}
                      </p>
                    </>
                  ) : (
                    <p>Aucune tentative enregistrée.</p>
                  )}
                  <button
                    onClick={() =>
                      port.go({
                        page: "chat",
                        botId: work.threadBotId,
                        messageId: work.requestMessageId,
                      })
                    }
                  >
                    Voir la demande
                  </button>
                </details>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
