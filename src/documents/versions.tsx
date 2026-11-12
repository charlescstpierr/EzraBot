import { useState } from "react";
import { htmlDocument } from "../../server/src/html-artifact";
import {
  CARNET_DESTINATION,
  PUBLISH_ACTION,
  type ProposalView,
  type VersionView,
  type WorkView,
} from "../../server/src/protocol";
import { Markdown } from "../Markdown";
import { uid } from "../api";
import type { Port } from "../port";
import { CommandButton, FailureNote, useSender } from "./command";
import { currentVersion, formatDate, versionSource } from "./model";

export function Reader({ version }: { version: VersionView }) {
  const html = htmlDocument(version.body) !== null;
  const [mode, setMode] = useState<"render" | "code">("render");
  return (
    <section className="ez-doc-reader" data-version-id={version.id}>
      <div
        className="ez-doc-tabs"
        role="group"
        aria-label="Affichage du document"
      >
        <button
          type="button"
          aria-pressed={mode === "render"}
          onClick={() => setMode("render")}
        >
          {html ? "Aperçu" : "Rendu"}
        </button>
        <button
          type="button"
          aria-pressed={mode === "code"}
          onClick={() => setMode("code")}
        >
          Code
        </button>
        <a
          className="ez-doc-btn"
          href={`/api/versions/${version.id}/download`}
          download
        >
          Télécharger{html ? " le HTML" : ""}
        </a>
      </div>
      {mode === "code" ? (
        <pre className="ez-doc-code">
          <code>{version.body}</code>
        </pre>
      ) : html ? (
        <>
          <iframe
            key={version.id}
            className="ez-doc-frame"
            title={`Aperçu de ${version.title}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            loading="lazy"
            src={`/api/versions/${version.id}/preview`}
          />
          <p className="ez-doc-muted">
            Aperçu local de la version enregistrée. Les connexions et les
            ressources externes sont désactivées.
          </p>
        </>
      ) : (
        <Markdown text={version.body} />
      )}
    </section>
  );
}

export function History({
  port,
  work,
  shown,
  author,
}: {
  port: Port;
  work: WorkView;
  shown: VersionView | undefined;
  author: string;
}) {
  const current = currentVersion(work);
  const published = new Set(
    port.view.carnet
      .filter((publication) => publication.workId === work.id)
      .map((publication) => publication.versionId),
  );
  return (
    <section className="ez-doc-section">
      <h3>Historique</h3>
      <p className="ez-doc-muted">
        Restaurer crée une nouvelle version. Les publications déjà faites
        restent dans le Carnet.
      </p>
      <ol className="ez-doc-versions" reversed>
        {[...work.versions].reverse().map((version) => (
          <li
            key={version.id}
            aria-current={version.id === shown?.id ? "true" : undefined}
          >
            <strong>
              Version {version.n}
              {version.id === current?.id && " · actuelle"}
              {published.has(version.id) && " · publiée"}
            </strong>
            <small>
              {versionSource(version, author)} · {formatDate(version.createdAt)}
            </small>
            <div className="ez-doc-actions">
              {version.id !== shown?.id && (
                <button
                  type="button"
                  className="ez-doc-btn"
                  onClick={() =>
                    port.go({
                      page: "document",
                      workId: work.id,
                      ...(version.id === current?.id
                        ? {}
                        : { versionId: version.id }),
                    })
                  }
                >
                  Lire la version {version.n}
                </button>
              )}
              {version.id !== current?.id && (
                <CommandButton
                  run={port.run}
                  make={() => ({
                    type: "version.restore",
                    requestId: uid(),
                    workId: work.id,
                    versionId: version.id,
                  })}
                  onAccepted={() =>
                    port.go({ page: "document", workId: work.id })
                  }
                >
                  Restaurer la version {version.n}
                </CommandButton>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

const DECISIONS: Record<Exclude<ProposalView["state"], "stale">, string> = {
  open: "En attente de votre décision",
  approved: "Publication approuvée",
  rejected: "Publication refusée. Rien n’a été publié",
};
const STALE: Record<NonNullable<ProposalView["staleReason"]>, string> = {
  edited: "Proposition annulée : le document a été modifié",
  restored: "Proposition annulée : une ancienne version a été restaurée",
  replaced: "Proposition remplacée par une plus récente",
};
const resolution = (proposal: ProposalView) =>
  proposal.state !== "stale"
    ? DECISIONS[proposal.state]
    : proposal.staleReason
      ? STALE[proposal.staleReason]
      : "Proposition périmée";

function Approval({
  port,
  proposal,
  blocked,
}: {
  port: Port;
  proposal: ProposalView;
  blocked: string | null;
}) {
  const sender = useSender(port.run);
  const locked = sender.sending || sender.pendingUnknownCommand !== null;
  return (
    <div className="ez-doc-approval" data-proposal-id={proposal.id}>
      <strong>Publier cette version dans le Carnet local ?</strong>
      <dl className="ez-doc-facts">
        <div>
          <dt>Action</dt>
          <dd>
            {proposal.action === PUBLISH_ACTION &&
              "Publier une copie figée de ce document · "}
            <code>{proposal.action}</code>
          </dd>
        </div>
        <div>
          <dt>Destination</dt>
          <dd>
            {proposal.destination === CARNET_DESTINATION &&
              "Carnet local, sur cet ordinateur. Rien n’est envoyé · "}
            <code>{proposal.destination}</code>
          </dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>
            Version {proposal.versionN} · <code>{proposal.versionId}</code>
          </dd>
        </div>
        <div>
          <dt>Empreinte du contenu</dt>
          <dd>
            <code>{proposal.payloadSha256}</code>
          </dd>
        </div>
      </dl>
      <small>Contenu intégral qui sera publié</small>
      <pre className="ez-doc-code">
        {proposal.title}
        {"\n\n"}
        {proposal.body}
      </pre>
      <small>
        Une modification ou une restauration annule cette proposition.
      </small>
      {blocked && <p className="ez-doc-muted">{blocked}</p>}
      <div className="ez-doc-actions">
        <button
          type="button"
          className="ez-doc-btn"
          disabled={locked}
          onClick={() =>
            sender.send({
              type: "publication.reject",
              requestId: uid(),
              proposalId: proposal.id,
            })
          }
        >
          Refuser la publication
        </button>
        <button
          type="button"
          className="ez-doc-btn ez-doc-btn-primary"
          disabled={locked || blocked !== null}
          onClick={() =>
            sender.send({
              type: "publication.approve",
              requestId: uid(),
              proposalId: proposal.id,
              action: proposal.action,
              destination: proposal.destination,
              versionId: proposal.versionId,
              payloadSha256: proposal.payloadSha256,
            })
          }
        >
          Approuver la publication
        </button>
      </div>
      <FailureNote sender={sender} />
    </div>
  );
}

export function Publication({
  port,
  work,
  blocked,
}: {
  port: Port;
  work: WorkView;
  blocked: string | null;
}) {
  const current = currentVersion(work);
  const open = work.proposals.find((proposal) => proposal.state === "open");
  const resolved = work.proposals.filter(
    (proposal) => proposal.state !== "open",
  );
  const published = port.view.carnet.filter(
    (publication) => publication.workId === work.id,
  );
  const proposable =
    current !== undefined &&
    !open &&
    (work.state === "review" || work.state === "done") &&
    !published.some((publication) => publication.versionId === current.id);
  if (!open && !proposable && !resolved.length && !published.length)
    return null;
  return (
    <section className="ez-doc-section">
      <h3>Publication dans le Carnet</h3>
      {open && <Approval port={port} proposal={open} blocked={blocked} />}
      {proposable && (
        <div className="ez-doc-actions">
          <CommandButton
            run={port.run}
            disabled={blocked !== null}
            title={blocked ?? undefined}
            make={() => ({
              type: "publication.propose",
              requestId: uid(),
              workId: work.id,
              versionId: current.id,
              destination: CARNET_DESTINATION,
            })}
          >
            Préparer la publication de la version {current.n}
          </CommandButton>
        </div>
      )}
      {(resolved.length > 0 || published.length > 0) && (
        <ul className="ez-doc-resolved">
          {resolved.map((proposal) => (
            <li key={proposal.id} data-state={proposal.state}>
              Version {proposal.versionN} · {resolution(proposal)} · proposée le{" "}
              {formatDate(proposal.createdAt)}
            </li>
          ))}
          {published.map((publication) => (
            <li key={publication.id} data-state="published">
              Publié dans le Carnet · version {publication.versionN} ·{" "}
              {formatDate(publication.createdAt)} ·{" "}
              <a href={`/api/publications/${publication.id}/download`} download>
                Télécharger la publication
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
