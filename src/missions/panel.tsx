import { useEffect, useState } from "react";
import {
  AGENT_LIMITS,
  type AgentCommand,
  type AttemptView,
  type EvidenceView,
} from "../../server/src/agent-protocol";
import { getMission, statuses, uid } from "../api";
import { Markdown } from "../Markdown";
import { Mascot } from "../Mascot";
import type { MissionResponse, Port } from "../port";
import { CommandFeedback, useMissionCommand } from "./command";

function Evidence({
  evidence,
}: {
  evidence: Pick<EvidenceView, "check" | "checkCommand" | "observed">;
}) {
  return (
    <div className="missions-evidence">
      {evidence.check ? (
        <>
          <p>
            Contrôle · code de sortie {evidence.check.exitCode ?? "inconnu"}
          </p>
          <pre>{JSON.stringify(evidence.check.command)}</pre>
          <pre>{evidence.check.output}</pre>
          {evidence.check.error && <p>{evidence.check.error}</p>}
        </>
      ) : (
        <p>
          {evidence.checkCommand
            ? "Contrôle non confirmé."
            : "Aucune commande de contrôle pour cet essai."}
        </p>
      )}
      {evidence.observed ? (
        <>
          <p>
            {evidence.observed.git ? "Dépôt Git observé" : "Dossier sans Git"} ·{" "}
            {evidence.observed.at}
          </p>
          <pre>
            {evidence.observed.head ?? "HEAD non fourni"}
            {"\n"}
            {evidence.observed.status.join("\n")}
            {"\n"}
            {evidence.observed.diffStat}
          </pre>
          <p>Fichiers modifiés pendant l’essai</p>
          <pre>
            {evidence.observed.changedDuringAttempt.join("\n") ||
              "Aucun fichier signalé."}
          </pre>
          {evidence.observed.error && <p>{evidence.observed.error}</p>}
        </>
      ) : (
        <p>Observation du dossier non fournie.</p>
      )}
    </div>
  );
}

function Attempt({ attempt }: { attempt: AttemptView }) {
  return (
    <details className="missions-attempt">
      <summary>
        Essai {attempt.n} · {attempt.kind} ·{" "}
        {statuses[attempt.state] ?? attempt.state}
      </summary>
      <p>
        Objectif révision {attempt.goalRev} · {attempt.sandbox} ·{" "}
        {attempt.model ?? "Modèle non fourni"} ·{" "}
        {attempt.effort ?? "Effort non fourni"}
      </p>
      {attempt.note && <p>{attempt.note}</p>}
      {attempt.trigger && <p>{attempt.trigger}</p>}
      {attempt.errorMessage && (
        <p role="alert">
          {attempt.errorCode} · {attempt.errorMessage}
        </p>
      )}
      {attempt.finalText && <Markdown text={attempt.finalText} />}
      <p>
        {attempt.usage
          ? `${attempt.usage.total} tokens rapportés, dont ${attempt.usage.input} en entrée et ${attempt.usage.output} en sortie.`
          : "Consommation de tokens inconnue."}
      </p>
      <Evidence evidence={attempt} />
      {attempt.input && (
        <details>
          <summary>Consigne transmise</summary>
          <pre>{attempt.input}</pre>
        </details>
      )}
      {attempt.threadId && <p>Fil de l’exécutant · {attempt.threadId}</p>}
    </details>
  );
}

export function MissionPanel({
  port,
  missionId,
}: {
  port: Port;
  missionId: string;
}) {
  return <MissionContent key={missionId} port={port} missionId={missionId} />;
}

function MissionContent({
  port,
  missionId,
}: {
  port: Port;
  missionId: string;
}) {
  const [response, setResponse] = useState<MissionResponse | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<"continue" | "revise" | null>(null);
  const [note, setNote] = useState("");
  const [goal, setGoal] = useState("");
  const [start, setStart] = useState(false);
  const command = useMissionCommand(port);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const result = await getMission(missionId, controller.signal);
        if (!controller.signal.aborted) {
          setResponse(result);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Impossible de charger la mission.",
          );
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void load();
          }, 2500);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [missionId, port.agents?.rev, refresh]);
  async function send(input: AgentCommand) {
    if (command.locked || error) return;
    const result = await command.send(input);
    if (result?.kind === "accepted") {
      setEditing(null);
      setNote("");
    }
    if (result) setRefresh((value) => value + 1);
  }
  const mission = response?.mission;
  const locked = command.locked || Boolean(error);
  return (
    <section className="missions-page">
      <button onClick={() => port.go({ page: "missions" })}>
        Toutes les missions
      </button>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button onClick={() => setRefresh((value) => value + 1)}>
            Actualiser la mission
          </button>
        </div>
      )}
      {!mission ? (
        <p>Chargement de la mission…</p>
      ) : (
        <>
          <header>
            <div>
              <p className="missions-eyebrow">
                {response.project?.name ?? "Projet indisponible"} ·{" "}
                {statuses[mission.status] ?? mission.status}
              </p>
              <h1>{mission.title}</h1>
            </div>
            {mission.lead && (
              <div className="missions-lead">
                <Mascot shape={mission.lead.shape} color={mission.lead.color} />
                <span>Responsable · {mission.lead.name}</span>
              </div>
            )}
          </header>
          <p>
            {mission.mode === "coordinated"
              ? "Mission coordonnée"
              : "Mission directe"}{" "}
            · Objectif révision {mission.goalRev}
          </p>
          <Markdown text={mission.goals.at(-1)?.text ?? mission.title} />
          <div className="missions-budget">
            <p>
              Essais locaux · {mission.attemptsUsed}/{mission.maxAttempts}
            </p>
            {mission.tree && (
              <p>
                Budget partagé de l’arbre · {mission.tree.used}/
                {mission.tree.max}
              </p>
            )}
            <p>
              Tokens rapportés · {mission.tokens.total}
              {mission.tokens.unknownAttempts > 0 &&
                ` · consommation inconnue pour ${mission.tokens.unknownAttempts} essai(s)`}
            </p>
          </div>
          {mission.waiting && (
            <section className="missions-card">
              <h2>Décision attendue</h2>
              <p>{mission.waiting}</p>
            </section>
          )}
          {mission.acceptBlocked && (
            <p role="status">Validation bloquée · {mission.acceptBlocked}</p>
          )}
          <div className="missions-actions">
            {mission.can.stop && (
              <button
                disabled={locked}
                onClick={() =>
                  void send({
                    type: "mission.stop",
                    requestId: uid(),
                    missionId,
                  })
                }
              >
                Arrêter
              </button>
            )}
            {mission.can.resume && (
              <button
                disabled={locked}
                onClick={() =>
                  void send({
                    type: "mission.resume",
                    requestId: uid(),
                    missionId,
                  })
                }
              >
                Reprendre après vérification du dossier
              </button>
            )}
            {mission.can.continue && (
              <button disabled={locked} onClick={() => setEditing("continue")}>
                Préciser à Mino
              </button>
            )}
            {mission.can.revise && (
              <button
                disabled={locked}
                onClick={() => {
                  setGoal(mission.goals.at(-1)?.text ?? "");
                  setStart(false);
                  setEditing("revise");
                }}
              >
                Modifier l’objectif
              </button>
            )}
            {mission.can.review && (
              <button
                disabled={locked}
                onClick={() =>
                  void send({
                    type: "mission.review",
                    requestId: uid(),
                    missionId,
                  })
                }
              >
                Demander une relecture
              </button>
            )}
            {mission.can.budget && (
              <button
                disabled={locked}
                onClick={() =>
                  void send({
                    type: "mission.budget",
                    requestId: uid(),
                    missionId,
                  })
                }
              >
                Accorder{" "}
                {mission.mode === "coordinated"
                  ? AGENT_LIMITS.coordinatedStep
                  : AGENT_LIMITS.budgetStep}{" "}
                essais
              </button>
            )}
            {mission.can.accept && (
              <button
                disabled={locked}
                onClick={() => {
                  if (mission.can.accept)
                    void send({
                      type: "mission.accept",
                      requestId: uid(),
                      missionId,
                      attemptId: mission.can.accept,
                    });
                }}
              >
                {mission.mode === "coordinated"
                  ? "Valider la synthèse"
                  : "Valider ce résultat"}
              </button>
            )}
          </div>
          <CommandFeedback
            command={command}
            afterRetry={(result) => {
              if (result.kind === "accepted") {
                setEditing(null);
                setNote("");
              }
              setRefresh((value) => value + 1);
            }}
          />
          {editing && (
            <form
              className="missions-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (editing === "continue" && mission.can.continue)
                  void send({
                    type: "mission.continue",
                    requestId: uid(),
                    missionId,
                    note: note.trim(),
                  });
                if (editing === "revise" && mission.can.revise && goal.trim())
                  void send({
                    type: "mission.revise",
                    requestId: uid(),
                    missionId,
                    goal: goal.trim(),
                    start,
                  });
              }}
            >
              <fieldset
                disabled={
                  locked ||
                  (editing === "continue"
                    ? !mission.can.continue
                    : !mission.can.revise)
                }
              >
                {editing === "continue" ? (
                  <label>
                    Précision pour Mino
                    <textarea
                      maxLength={AGENT_LIMITS.noteChars}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </label>
                ) : (
                  <>
                    <label>
                      Nouvel objectif
                      <textarea
                        required
                        maxLength={AGENT_LIMITS.goalChars}
                        value={goal}
                        onChange={(event) => setGoal(event.target.value)}
                      />
                    </label>
                    <label className="missions-check">
                      <input
                        type="checkbox"
                        checked={start}
                        onChange={(event) => setStart(event.target.checked)}
                      />
                      Relancer après enregistrement
                    </label>
                  </>
                )}
                <button type="submit">
                  {editing === "continue"
                    ? "Envoyer la précision"
                    : "Enregistrer l’objectif"}
                </button>
              </fieldset>
              <button
                type="button"
                disabled={command.sending}
                onClick={() => setEditing(null)}
              >
                Annuler la modification
              </button>
            </form>
          )}
          {mission.parent && (
            <section className="missions-card">
              <h2>Mission parente</h2>
              <button
                onClick={() =>
                  port.go({ page: "missions", missionId: mission.parent?.id })
                }
              >
                {mission.parent.title}
              </button>
              <p>
                Décision {mission.parent.decisionN ?? "non fournie"} ·{" "}
                {mission.parent.current
                  ? "Objectif courant"
                  : "Objectif précédent"}
              </p>
            </section>
          )}
          {mission.origin && (
            <details>
              <summary>Demande d’origine</summary>
              <Markdown text={mission.origin.text} />
              <p>Message · {mission.origin.messageId}</p>
              {port.view.messages.find(
                (message) => message.id === mission.origin?.messageId,
              ) && (
                <button
                  onClick={() => {
                    const message = port.view.messages.find(
                      (item) => item.id === mission.origin?.messageId,
                    );
                    if (message)
                      port.go({
                        page: "chat",
                        botId: message.threadBotId,
                        messageId: message.id,
                      });
                  }}
                >
                  Ouvrir le message
                </button>
              )}
            </details>
          )}
          {mission.children.length > 0 && (
            <section>
              <h2>Étapes</h2>
              <div className="missions-list">
                {mission.children.map((child) => (
                  <button
                    className="missions-card"
                    key={child.id}
                    onClick={() =>
                      port.go({ page: "missions", missionId: child.id })
                    }
                  >
                    {child.title}
                    <span>{statuses[child.status] ?? child.status}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {mission.synthesis && (
            <section className="missions-card">
              <h2>Synthèse</h2>
              <Markdown text={mission.synthesis.summary} />
              <h3>Limites signalées</h3>
              <Markdown
                text={mission.synthesis.limits || "Aucune limite fournie."}
              />
              <h3>Preuves vérifiées par le PC</h3>
              {mission.synthesis.evidence.map((evidence, index) => (
                <details
                  key={`${evidence.childId}-${evidence.attemptId}-${index}`}
                >
                  <summary>
                    {evidence.childTitle} · essai{" "}
                    {evidence.attemptN ?? "inconnu"}
                  </summary>
                  <button
                    onClick={() =>
                      port.go({ page: "missions", missionId: evidence.childId })
                    }
                  >
                    Consulter cette étape
                  </button>
                  <Evidence evidence={evidence} />
                </details>
              ))}
              {mission.synthesis.final && (
                <Attempt attempt={mission.synthesis.final} />
              )}
            </section>
          )}
          {mission.decisions.length > 0 && (
            <section>
              <h2>Décisions du responsable</h2>
              {mission.decisions.map((decision) => (
                <details className="missions-card" key={decision.id}>
                  <summary>
                    Décision {decision.n} · {decision.kind ?? "illisible"} ·{" "}
                    {decision.outcome === "applied" ? "appliquée" : "refusée"}
                  </summary>
                  <p>
                    Essai {decision.attemptN} · objectif {decision.goalRev}
                  </p>
                  {decision.refusal && <p>{decision.refusal}</p>}
                  <pre>{decision.raw}</pre>
                  {decision.childId && (
                    <button
                      onClick={() =>
                        port.go({
                          page: "missions",
                          missionId: decision.childId ?? undefined,
                        })
                      }
                    >
                      Consulter l’étape
                    </button>
                  )}
                </details>
              ))}
            </section>
          )}
          <section>
            <h2>Essais</h2>
            {mission.attempts.map((attempt) => (
              <Attempt key={attempt.id} attempt={attempt} />
            ))}
          </section>
          {mission.live && (
            <section>
              <h2>Texte en cours</h2>
              {mission.live.activity && <p>{mission.live.activity}</p>}
              <Markdown text={mission.live.text} />
            </section>
          )}
          <details className="missions-card">
            <summary>
              Activité des outils · {mission.events.length} événements
            </summary>
            {mission.eventsOmitted > 0 && (
              <p>
                {mission.eventsOmitted} événements anciens omis par le serveur.
              </p>
            )}
            {!mission.events.length && <p>Aucun événement rapporté.</p>}
            {mission.events.map((event) => (
              <details key={event.id}>
                <summary>
                  {event.kind} · {event.at} · #{event.seq}
                </summary>
                <p>Essai · {event.attemptId}</p>
                <pre>{JSON.stringify(event.data, null, 2)}</pre>
              </details>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
