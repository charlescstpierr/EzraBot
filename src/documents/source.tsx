import type { VersionView, WorkView } from "../../server/src/protocol";
import type { SourceView } from "../../server/src/tools-protocol";
import type { SourceChoice } from "../chat";
import type { Port } from "../port";
import { botNamer } from "./model";

/** How a version stood in its document: `headN` is the newest version at the moment that `was` or `is` describes. */
export const sourceAge = (n: number, headN: number, tense: "is" | "was") =>
  n === headN
    ? tense === "is"
      ? "version actuelle"
      : "version actuelle au moment de la demande"
    : `ancienne version : la version actuelle ${tense === "is" ? "est" : "était"} la ${headN}`;

/** Why this bot cannot prepare a service action now, or null. Preparing gives no right: it only uses the ones the bot has. */
export function sourceBlocker(port: Port, botId: string): string | null {
  if (port.view.tools.status.state !== "ready")
    return "Aucun service n’est connecté sur cet ordinateur. Rien ne peut être préparé.";
  if (!port.view.tools.grants[botId]?.length)
    return `${botNamer(port.view)(botId)} n’a aucun service connecté. Donnez-lui un droit dans sa page de personnage. Rien ne peut être préparé.`;
  return null;
}

export function PrepareAction({
  port,
  work,
  version,
  unsaved,
}: {
  port: Port;
  work: WorkView;
  version: VersionView;
  unsaved: string | null;
}) {
  const bot = botNamer(port.view)(work.threadBotId);
  const reason = unsaved ?? sourceBlocker(port, work.threadBotId);
  const head = work.versions.at(-1)?.n ?? version.n;
  return (
    <section className="ez-doc-section" aria-label="Action sur un service">
      <h3>Action sur un service connecté</h3>
      <div className="ez-doc-actions">
        <button
          type="button"
          className="ez-doc-btn"
          disabled={reason !== null}
          aria-describedby="ez-doc-source-note"
          onClick={() =>
            port.go({
              page: "chat",
              botId: work.threadBotId,
              source: { workId: work.id, versionId: version.id },
            })
          }
        >
          Préparer une action avec la version {version.n}
        </button>
      </div>
      <p className="ez-doc-muted" id="ez-doc-source-note">
        {reason ??
          `Ouvre la conversation avec ${bot}. Vous y précisez la demande, puis vous relisez l’action exacte avant de l’approuver. La version ${version.n} enregistrée est transmise (${sourceAge(version.n, head, "is")}).`}
      </p>
    </section>
  );
}

/** What the composer shows and sends for a version picked in the reader. Undefined when this space no longer has that version. */
export function sourceChoice(
  port: Port,
  botId: string,
  ref: SourceChoice["ref"],
  clear: () => void,
): SourceChoice | undefined {
  const work = port.view.works.find((each) => each.id === ref.workId);
  const version = work?.versions.find((each) => each.id === ref.versionId);
  const head = work?.versions.at(-1);
  if (!work || !version || !head) return undefined;
  return {
    ref,
    label: `« ${version.title} », version ${version.n} · ${sourceAge(version.n, head.n, "is")}`,
    blocked: sourceBlocker(port, botId),
    clear,
  };
}

/** The frozen source of a request or of a proposed action, as the server recorded it. */
export function SourceLine({
  port,
  source,
}: {
  port: Port;
  source: SourceView;
}) {
  return (
    <>
      « {source.title} », version {source.versionN} ·{" "}
      {sourceAge(source.versionN, source.headN, "was")}
      {source.state === "changed" && " · le document a changé depuis"} ·{" "}
      <button
        type="button"
        className="ez-source-link"
        onClick={() =>
          port.go({
            page: "document",
            workId: source.workId,
            versionId: source.versionId,
          })
        }
      >
        Lire la version {source.versionN}
      </button>
    </>
  );
}
