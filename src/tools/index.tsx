import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { BotView, MessageView } from "../../server/src/protocol";
import type {
  AvailableTool,
  ServiceOption,
  StaleReason,
  ToolCommand,
  ToolProposalView,
} from "../../server/src/tools-protocol";
import { toolsRequest, uid } from "../api";
import { SourceLine } from "../documents/source";
import { ConnectionCard } from "./connection";
import { failureText, freeAlias, useLinkFlow } from "./link-flow";
import type { Port, ToolsOutcome } from "../port";
import "./style.css";

const MISSING_KEY =
  "Aucune clé Composio n’est configurée sur ce serveur. Les services connectés sont désactivés : rien ne peut être relié ni exécuté.";

type Accepted = Extract<ToolsOutcome, { kind: "accepted" }>;

function useToolCommand(port: Port) {
  const lock = useRef(false),
    held = useRef<{
      command: ToolCommand;
      done?: (result: Accepted) => void;
    } | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [uncertain, setUncertain] = useState(false);
  async function execute(action: NonNullable<typeof held.current>) {
    if (lock.current) return;
    held.current = action;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      const outcome = await port.run.tools(action.command);
      if (outcome.kind === "unknown") {
        setMessage(outcome.message);
        setUncertain(true);
        return;
      }
      held.current = null;
      setUncertain(false);
      if (outcome.kind === "accepted") action.done?.(outcome);
      else setMessage(outcome.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return {
    send(command: ToolCommand, done?: (result: Accepted) => void) {
      if (held.current) return;
      return execute({ command, done });
    },
    locked: busy || uncertain,
    feedback: (
      <>
        {message && (
          <p className="notice" role="alert">
            {message}
          </p>
        )}
        {uncertain && (
          <button
            type="button"
            className="outline"
            disabled={busy}
            onClick={() => {
              if (held.current) void execute(held.current);
            }}
          >
            Réessayer la même action
            <RefreshCw size={15} />
          </button>
        )}
      </>
    ),
  };
}

type CatalogState =
  | { kind: "loading" }
  | { kind: "ready"; services: ServiceOption[] }
  | { kind: "error"; message: string };

export function ToolConnections({ port }: { port: Port }) {
  const tools = port.view.tools;
  const [catalog, setCatalog] = useState<CatalogState>({ kind: "loading" });
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [serviceId, setServiceId] = useState("");
  const [alias, setAlias] = useState("");
  const configured = tools.status.state !== "missing_key";
  const flow = useLinkFlow(configured);
  const state = flow.state;

  useEffect(() => {
    if (!configured) return;
    const controller = new AbortController();
    setCatalog({ kind: "loading" });
    void toolsRequest("catalog", "catalog", undefined, controller.signal)
      .then((reply) => {
        if (controller.signal.aborted) return;
        setCatalog({ kind: "ready", services: reply.services });
        setServiceId(
          reply.services.find((service) => service.connectable)?.id ?? "",
        );
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setCatalog({ kind: "error", message: failureText(reason) });
      });
    return () => controller.abort();
  }, [configured, catalogAttempt]);

  if (!configured)
    return (
      <section className="ez-tools" aria-label="Services connectés">
        <h3>Services connectés</h3>
        <p className="notice" role="status">
          {MISSING_KEY}
        </p>
      </section>
    );
  const services = catalog.kind === "ready" ? catalog.services : [];
  const chosen = services.find((service) => service.id === serviceId);
  const busy = flow.busy;
  const defaultAlias = (service: ServiceOption) =>
    freeAlias(service.name, tools.accounts);
  async function connect() {
    if (!chosen?.connectable) return;
    const started = await flow.open((signal) =>
      toolsRequest(
        "link",
        "link",
        {
          serviceId: chosen.id,
          alias: alias.trim() || defaultAlias(chosen),
        },
        signal,
      ),
    );
    if (started) setAlias("");
  }
  return (
    <section className="ez-tools" aria-label="Services connectés">
      <h3>Services connectés</h3>
      <p>
        Connectez un compte, puis choisissez ses droits dans la page du
        personnage. Chaque action demandera votre confirmation.
      </p>
      {!tools.accounts.length && !tools.links.length && (
        <p>Aucun compte relié pour le moment.</p>
      )}
      <ul className="ez-tools-list">
        {tools.accounts
          .filter(
            (account) =>
              !tools.links.some((link) => link.accountId === account.id),
          )
          .map((account) => (
            <li key={account.id}>
              <strong>{account.alias}</strong>
              <span>
                {account.status === "ACTIVE" ? "Connecté" : "Compte inactif"}
              </span>
            </li>
          ))}
        {tools.links.map((link) => (
          <li key={link.id}>
            <strong>
              {tools.accounts.find((account) => account.id === link.accountId)
                ?.alias ??
                services.find((service) => service.toolkit === link.toolkit)
                  ?.name ??
                "Compte à connecter"}
            </strong>
            <span>
              {link.state === "failed"
                ? "Connexion non aboutie"
                : "Connexion en attente"}
            </span>
            <button
              type="button"
              className="outline"
              disabled={busy}
              onClick={() => flow.check(link.id)}
            >
              Vérifier la connexion
            </button>
          </li>
        ))}
      </ul>
      {catalog.kind === "loading" && (
        <p role="status">Chargement des services…</p>
      )}
      {catalog.kind === "error" && (
        <div role="alert">
          <p>{catalog.message}</p>
          <button
            className="outline"
            onClick={() => setCatalogAttempt((attempt) => attempt + 1)}
          >
            Recharger les services
          </button>
        </div>
      )}
      {catalog.kind === "ready" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void connect();
          }}
        >
          <label>
            Service à relier
            <select
              disabled={busy}
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
            >
              {services.map((service) => (
                <option
                  key={service.id}
                  value={service.id}
                  disabled={!service.connectable}
                >
                  {service.name}
                  {service.connectable ? "" : " (indisponible)"}
                </option>
              ))}
            </select>
          </label>
          <button className="black" disabled={busy || !chosen?.connectable}>
            {state.kind === "opening" ? "Ouverture…" : "Connecter"}
          </button>
          {services.some((service) => !service.connectable) && (
            <details>
              <summary>Services indisponibles</summary>
              {services
                .filter((service) => !service.connectable)
                .map((service) => (
                  <small key={service.id}>
                    {service.name} · {service.reason}
                  </small>
                ))}
            </details>
          )}
          {!services.length && (
            <p>Ce serveur ne propose aucun service à connecter.</p>
          )}
          <details className="ez-connection-details">
            <summary>Nom du compte (facultatif)</summary>
            <label>
              Nom de ce compte
              <input
                disabled={busy}
                maxLength={40}
                value={alias}
                onChange={(event) => setAlias(event.target.value)}
                placeholder={chosen ? defaultAlias(chosen) : "Nom du compte"}
              />
            </label>
            <small>
              Utilisez un nom distinct pour reconnaître le compte sur les
              demandes de confirmation.
            </small>
          </details>
        </form>
      )}
      {state.kind === "waiting" && (
        <div className="notice" role="status">
          <p>
            Terminez la connexion chez le fournisseur. La vérification se fait
            automatiquement à votre retour.
          </p>
          <button
            type="button"
            className="outline"
            onClick={() => flow.checkNow()}
          >
            Vérifier maintenant
          </button>
          <button type="button" className="outline" onClick={() => flow.stop()}>
            Arrêter la vérification
          </button>
        </div>
      )}
      {(state.kind === "waiting" || state.kind === "error") &&
        state.fallback && (
          <a
            className="black ez-connection-fallback"
            href={state.fallback}
            target="_blank"
            rel="noopener noreferrer"
          >
            Ouvrir la page de connexion
          </a>
        )}
      {state.kind === "success" && (
        <p role="status">
          Compte connecté. Vous pouvez maintenant choisir ses droits dans la
          page du personnage.
        </p>
      )}
      {state.kind === "error" && (
        <div className="notice" role="alert">
          <p>{state.message}</p>
          {state.linkId && (
            <button
              className="outline"
              onClick={() => {
                if (state.linkId) flow.check(state.linkId, state.fallback);
              }}
            >
              Réessayer la vérification
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function ToolGrants({ port, bot }: { port: Port; bot: BotView }) {
  const tools = port.view.tools;
  const grants = tools.grants[bot.id] ?? [];
  const accounts = tools.accounts.filter(
    (account) => account.status === "ACTIVE",
  );
  const [accountId, setAccountId] = useState(""),
    [available, setAvailable] = useState<{
      accountId: string;
      tools: AvailableTool[];
    } | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const action = useToolCommand(port);
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (tools.status.state === "missing_key")
    return (
      <section className="ez-tools" aria-label="Services connectés">
        <h3>Services connectés</h3>
        <p className="notice" role="status">
          {MISSING_KEY}
        </p>
      </section>
    );
  return (
    <section className="ez-tools" aria-label="Services connectés">
      <h3>Services connectés</h3>
      <p>
        {bot.name} peut seulement proposer les actions listées ici. Chaque
        action attend votre confirmation sur ce PC, lecture comprise.
      </p>
      {!grants.length && <p>{bot.name} n’a aucun droit pour le moment.</p>}
      <ul className="ez-tools-list">
        {grants.map((grant) => (
          <li key={grant.id}>
            <strong>{grant.toolSlug}</strong>
            <span>
              {grant.toolkit} · {grant.accountAlias}
            </span>
            <span>version {grant.version}</span>
            <button
              type="button"
              className="outline"
              disabled={action.locked}
              aria-label={`Retirer ${grant.toolSlug}`}
              onClick={() =>
                void action.send({
                  type: "tools.revoke",
                  requestId: uid(),
                  botId: bot.id,
                  grantId: grant.id,
                })
              }
            >
              Retirer
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
      {!accounts.length ? (
        <p className="notice">Reliez d’abord un compte dans les préférences.</p>
      ) : (
        <>
          <label>
            Compte à utiliser
            <select
              value={accountId}
              onChange={(event) => {
                setAccountId(event.target.value);
                setAvailable(null);
              }}
            >
              <option value="">Choisir un compte</option>
              {accounts.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.alias} · {candidate.toolkit}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="outline"
            disabled={!account || loading}
            onClick={async () => {
              if (!account) return;
              setLoading(true);
              setError("");
              try {
                const reply = await toolsRequest(
                  "available",
                  `available?accountId=${encodeURIComponent(account.id)}`,
                );
                setAvailable({ accountId: account.id, tools: reply.tools });
                setSelected(
                  grants
                    .filter((grant) => grant.accountId === account.id)
                    .map((grant) => grant.toolSlug),
                );
              } catch (reason) {
                setError(failureText(reason));
              } finally {
                setLoading(false);
              }
            }}
          >
            Voir les outils de ce compte
          </button>
        </>
      )}
      {account && available?.accountId === account.id && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!selected.length) return;
            void action.send(
              {
                type: "tools.grant",
                requestId: uid(),
                botId: bot.id,
                accountId: account.id,
                toolSlugs: selected,
              },
              () => setAvailable(null),
            );
          }}
        >
          <fieldset disabled={action.locked}>
            <legend>
              Outils de {account.alias} ({account.toolkit})
            </legend>
            {available.tools.map((tool) => (
              <label key={tool.slug} className="ez-tools-choice">
                <input
                  type="checkbox"
                  disabled={!tool.grantable}
                  checked={selected.includes(tool.slug)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, tool.slug]
                        : current.filter((slug) => slug !== tool.slug),
                    )
                  }
                />
                <span>
                  <strong>{tool.slug}</strong> · {tool.name}
                  <small>
                    {tool.grantable ? tool.description : tool.reason}
                  </small>
                </span>
              </label>
            ))}
            {!available.tools.length && (
              <p>Ce compte ne propose aucun outil.</p>
            )}
            <p>
              Les droits de {bot.name} sur {account.toolkit} deviennent
              exactement cette sélection, avec ce compte seulement.
            </p>
            <button className="black" disabled={!selected.length}>
              Enregistrer les droits de {bot.name}
              <Check size={16} />
            </button>
          </fieldset>
        </form>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {action.feedback}
    </section>
  );
}

const STALE_LABELS: Record<StaleReason, string> = {
  turn_failed: "le tour du personnage n’a pas abouti",
  grant_changed: "le droit a été retiré ou remplacé",
  account_inactive: "le compte n’est plus actif",
  schema_changed: "le service a changé cet outil depuis la proposition",
  source_changed: "le document source a changé depuis votre demande",
};

const MEMORY_CHANGED =
  "une source de la mémoire de cette conversation a été corrigée, exclue ou oubliée depuis votre demande";

function staleLabel(proposal: ToolProposalView): string {
  if (!proposal.staleReason) return "elle n’est plus valable";
  return proposal.staleReason === "source_changed" &&
    proposal.source?.state !== "changed"
    ? MEMORY_CHANGED
    : STALE_LABELS[proposal.staleReason];
}

const VOID_LABELS: Record<string, string> = {
  grant_changed: "le droit a été retiré ou remplacé",
  account_inactive: "le compte n’est plus actif",
  provider_unavailable: "le fournisseur ne répondait pas",
  bot_deleted: "le personnage a été supprimé",
  work_changed: "le travail a changé",
  source_changed: "le document source a changé depuis votre demande",
  memory_changed: MEMORY_CHANGED,
  session: "la session du fournisseur n’a pas pu s’ouvrir",
  tool_absent: "le service ne propose plus cet outil",
  version_missing: "le service n’annonce plus de version",
  schema_changed: "le service a changé cet outil depuis l’approbation",
};

function outcomeText(proposal: ToolProposalView): string {
  if (proposal.state === "open")
    return "En attente de votre décision. Rien n’est envoyé sans elle.";
  if (proposal.state === "refused") return "Refusée. Rien n’a été envoyé.";
  if (proposal.state === "stale")
    return `Périmée : ${staleLabel(proposal)}. Rien n’a été envoyé.`;
  const execution = proposal.execution;
  switch (execution?.state) {
    case "approved":
      return "Approuvée. Envoi en préparation…";
    case "dispatching":
      return "Approuvée. Envoi en cours…";
    case "completed":
      return "Le service confirme l’exécution.";
    case "failed":
      return "Le service signale un échec.";
    case "blocked":
      return execution.category === "input_required"
        ? "Bloquée : le service demande une saisie supplémentaire. Rien n’a été renvoyé."
        : "Bloquée par le service.";
    case "unknown":
      return "Résultat inconnu : le service n’a pas confirmé. L’action a peut-être eu lieu. EzraBot ne la renvoie pas.";
    case "voided":
      return `Annulée avant l’envoi : ${VOID_LABELS[execution.category ?? ""] ?? "une vérification a échoué"}. Rien n’a été envoyé.`;
    default:
      return "Approuvée.";
  }
}

function ToolCard({
  port,
  proposal,
}: {
  port: Port;
  proposal: ToolProposalView;
}) {
  const action = useToolCommand(port);
  const execution = proposal.execution;
  return (
    <section
      className="ez-tools-card"
      aria-label={`Action proposée ${proposal.toolSlug}`}
      data-state={execution?.state ?? proposal.state}
    >
      <span className="card-label">
        <ShieldCheck size={14} /> ACTION PROPOSÉE · VOTRE CONFIRMATION EST
        REQUISE
      </span>
      <dl>
        <div>
          <dt>Service</dt>
          <dd>{proposal.toolkit}</dd>
        </div>
        <div>
          <dt>Compte</dt>
          <dd>{proposal.accountAlias}</dd>
        </div>
        <div>
          <dt>Action</dt>
          <dd>
            {proposal.toolSlug} · version {proposal.version}
          </dd>
        </div>
        {proposal.source && (
          <div>
            <dt>Source</dt>
            <dd>
              <SourceLine port={port} source={proposal.source} />
            </dd>
          </div>
        )}
      </dl>
      <p className="ez-tools-arguments-title">Contenu exact</p>
      <pre className="ez-tools-arguments">
        {JSON.stringify(proposal.arguments, null, 2)}
      </pre>
      <p role="status" className="ez-tools-outcome">
        {outcomeText(proposal)}
      </p>
      {proposal.state === "open" && (
        <div className="actions">
          <button
            type="button"
            className="black"
            disabled={action.locked}
            onClick={() =>
              void action.send({
                type: "tools.approve",
                requestId: uid(),
                proposalId: proposal.id,
                fingerprint: proposal.fingerprint,
              })
            }
          >
            Approuver cette action exacte
            <Check size={16} />
          </button>
          <button
            type="button"
            className="outline"
            disabled={action.locked}
            onClick={() =>
              void action.send({
                type: "tools.refuse",
                requestId: uid(),
                proposalId: proposal.id,
              })
            }
          >
            Refuser
            <X size={15} />
          </button>
        </div>
      )}
      {execution?.logId && (
        <small>Journal du service : {execution.logId}</small>
      )}
      {execution?.summary && (
        <details>
          <summary>Résultat reçu du service (donnée externe)</summary>
          <pre className="ez-tools-arguments">{execution.summary}</pre>
        </details>
      )}
      {(execution?.report === "queued" || execution?.report === "running") && (
        <small>Le personnage prépare son compte rendu…</small>
      )}
      {execution?.report === "failed" && (
        <div className="notice">
          <p>
            Le compte rendu du personnage a échoué. Le relancer ne renvoie pas
            l’action.
          </p>
          <button
            type="button"
            className="outline"
            disabled={action.locked}
            onClick={() =>
              void action.send({
                type: "tools.report.retry",
                requestId: uid(),
                executionId: execution.id,
              })
            }
          >
            Relancer le compte rendu
            <RefreshCw size={15} />
          </button>
        </div>
      )}
      {action.feedback}
    </section>
  );
}

export function ToolCards({
  port,
  message,
}: {
  port: Port;
  message: MessageView;
}) {
  if (message.role !== "assistant") {
    const source = port.view.tools.sources.find(
      (candidate) => candidate.messageId === message.id,
    );
    return source ? (
      <p className="ez-source-note">
        Version source : <SourceLine port={port} source={source} />
      </p>
    ) : null;
  }
  const proposals = port.view.tools.proposals.filter(
    (proposal) => proposal.messageId === message.id,
  );
  return (
    <>
      {proposals.map((proposal) => (
        <ToolCard key={proposal.id} port={port} proposal={proposal} />
      ))}
      {port.view.tools.connections
        .filter((connection) => connection.messageId === message.id)
        .map((connection) => (
          <ConnectionCard
            key={connection.id}
            port={port}
            connection={connection}
          />
        ))}
    </>
  );
}
