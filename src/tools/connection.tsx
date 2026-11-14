import { Link2, RefreshCw, Settings2 } from "lucide-react";
import type { ConnectionView } from "../../server/src/tools-protocol";
import { toolsRequest } from "../api";
import type { Port } from "../port";
import { freeAlias, useLinkFlow } from "./link-flow";

const checkedAt = (iso: string) =>
  new Date(iso).toLocaleString("fr-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  });

/**
 * A bot's proposal to connect a service. The card starts the same connection as the preferences.
 * Its state is the state of its link, which only a provider reading changes. It never gives a right.
 */
export function ConnectionCard({
  port,
  connection,
}: {
  port: Port;
  connection: ConnectionView;
}) {
  const tools = port.view.tools;
  const flow = useLinkFlow(true);
  const { link, toolkit } = connection;
  const bot =
    port.view.bots.find((candidate) => candidate.id === connection.botId)
      ?.name ?? "Ce personnage";
  const account = tools.accounts.find(
    (candidate) => candidate.id === link?.accountId,
  );
  const rights = (tools.grants[connection.botId] ?? []).filter(
    (grant) => grant.toolkit === toolkit,
  );
  const other = tools.accounts.find(
    (candidate) =>
      candidate.toolkit === toolkit &&
      candidate.status === "ACTIVE" &&
      candidate.id !== link?.accountId,
  );
  const durable = link?.state ?? "proposed";
  const opening = flow.state.kind === "opening";
  const stage = flow.state.kind === "waiting" ? "waiting" : durable;
  const start = () =>
    void flow.open((signal) =>
      toolsRequest(
        "link",
        `connections/${encodeURIComponent(connection.id)}/link`,
        { alias: freeAlias(toolkit, tools.accounts), after: link?.id ?? null },
        signal,
      ),
    );
  const status = {
    proposed: "Aucune connexion n’a encore été lancée depuis cette carte.",
    opening: "Ouverture de la connexion…",
    waiting:
      "Terminez la connexion chez le fournisseur. La vérification se fait automatiquement à votre retour.",
    pending: "Connexion en attente de votre autorisation chez le fournisseur.",
    failed: "La connexion n’a pas abouti. Aucun compte n’a été relié.",
    active: `Compte « ${account?.alias ?? toolkit} » connecté. Dernier contrôle chez le fournisseur : ${account ? checkedAt(account.checkedAt) : "inconnu"}.`,
  }[opening ? "opening" : stage];
  return (
    <section
      className="ez-tools-card"
      aria-label={`Connexion proposée ${toolkit}`}
      data-state={opening ? "opening" : stage}
    >
      <span className="card-label">
        <Link2 size={14} /> CONNEXION PROPOSÉE · AUCUN DROIT DONNÉ
      </span>
      <dl>
        <div>
          <dt>Service</dt>
          <dd>{toolkit}</dd>
        </div>
      </dl>
      <p role="status" className="ez-tools-outcome">
        {status}
      </p>
      {stage !== "active" && other && (
        <p className="ez-tools-outcome">
          Un compte {toolkit} est déjà connecté sur ce PC (« {other.alias} »).
          Vous pouvez choisir les droits de {bot} sans relier un autre compte.
        </p>
      )}
      <p className="ez-tools-outcome">
        {rights.length
          ? `${bot} a déjà des droits sur ${toolkit} : ${rights.map((grant) => grant.toolSlug).join(", ")}. Chaque action attend votre confirmation.`
          : `Relier un compte ne donne aucun droit à ${bot}. Vous choisissez ses droits dans sa page, puis chaque action attend votre confirmation.`}
      </p>
      <div className="actions">
        {stage === "proposed" && (
          <button
            type="button"
            className="black"
            disabled={opening}
            onClick={start}
          >
            {opening ? "Ouverture…" : `Connecter ${toolkit}`}
            <Link2 size={16} />
          </button>
        )}
        {stage === "waiting" && (
          <>
            <button
              type="button"
              className="outline"
              onClick={() => flow.checkNow()}
            >
              Vérifier maintenant
            </button>
            <button
              type="button"
              className="outline"
              onClick={() => flow.stop()}
            >
              Arrêter la vérification
            </button>
          </>
        )}
        {link && stage === "pending" && (
          <button
            type="button"
            className="outline"
            disabled={opening}
            onClick={() => flow.check(link.id)}
          >
            Vérifier la connexion
          </button>
        )}
        {(stage === "pending" || stage === "failed") && (
          <button
            type="button"
            className="outline"
            disabled={opening}
            onClick={start}
          >
            Relancer la connexion
            <RefreshCw size={15} />
          </button>
        )}
        <button
          type="button"
          className="outline"
          onClick={() =>
            port.go({ page: "characters", botId: connection.botId })
          }
        >
          Voir les droits de {bot}
          <Settings2 size={15} />
        </button>
      </div>
      {(flow.state.kind === "waiting" ||
        (flow.state.kind === "error" && stage === "pending")) &&
        flow.state.fallback && (
          <a
            className="black ez-connection-fallback"
            href={flow.state.fallback}
            target="_blank"
            rel="noopener noreferrer"
          >
            Ouvrir la page de connexion
          </a>
        )}
      {flow.state.kind === "error" && stage !== "failed" && (
        <p className="notice" role="alert">
          {flow.state.message}
        </p>
      )}
    </section>
  );
}
