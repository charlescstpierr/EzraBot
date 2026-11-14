import { useState } from "react";
import {
  AGENT_LIMITS,
  type MissionMode,
} from "../../server/src/agent-protocol";
import type { MessageView } from "../../server/src/protocol";
import { statuses, uid } from "../api";
import type { AgentsOutcome, Port } from "../port";
import { Mascot } from "../Mascot";
import { CommandFeedback, useMissionCommand } from "./command";
import "./missions.css";
export { MissionPanel } from "./panel";

function MissionForm({
  port,
  message,
  done,
  cancel,
}: {
  port: Port;
  message?: MessageView;
  done?: () => void;
  cancel?: () => void;
}) {
  const [goal, setGoal] = useState(message?.handoff?.goal ?? "");
  const [projectId, setProject] = useState("");
  const [mode, setMode] = useState<MissionMode>(
    message?.handoff?.coordinated ? "coordinated" : "direct",
  );
  const [leadBotId, setLead] = useState("");
  const command = useMissionCommand(port);
  const projects =
    port.agents?.projects.filter((project) => !project.archived) ?? [];
  const candidates = port.view.bots.filter((bot) => bot.id !== "mino");
  function completed(outcome: AgentsOutcome) {
    if (outcome.kind === "accepted") {
      done?.();
      port.go({ page: "missions", missionId: outcome.result.id });
    }
  }
  return (
    <form
      className="missions-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          command.locked ||
          !goal.trim() ||
          !projects.some((project) => project.id === projectId) ||
          (mode === "coordinated" &&
            !candidates.some((bot) => bot.id === leadBotId))
        )
          return;
        void command
          .send({
            type: "mission.create",
            requestId: uid(),
            projectId,
            goal: goal.trim(),
            mode,
            model: null,
            effort: null,
            ...(mode === "coordinated" ? { leadBotId } : {}),
            ...(message ? { origin: { messageId: message.id } } : {}),
          })
          .then((outcome) => {
            if (outcome) completed(outcome);
          });
      }}
    >
      <p>
        Préparez l’objectif et choisissez un dossier. Le travail commencera
        après « Confier la mission ».
      </p>
      {!projects.length && (
        <p>
          Ajoutez d’abord un dossier dans{" "}
          <button type="button" onClick={() => port.go({ page: "projects" })}>
            Projets
          </button>
          .
        </p>
      )}
      <fieldset disabled={command.locked}>
        <label>
          Dossier de la mission
          <select
            required
            value={projectId}
            onChange={(event) => {
              setProject(event.target.value);
              setLead(
                projects.find((project) => project.id === event.target.value)
                  ?.leadBotId ?? "",
              );
            }}
          >
            <option value="">Choisir un dossier</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Objectif à confier
          <textarea
            required
            maxLength={AGENT_LIMITS.goalChars}
            rows={4}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        <label>
          Organisation de la mission
          <select
            value={mode}
            onChange={(event) =>
              setMode(
                event.target.value === "coordinated" ? "coordinated" : "direct",
              )
            }
          >
            <option value="direct">Un exécutant</option>
            <option value="coordinated">Avec un responsable</option>
          </select>
        </label>
        {mode === "coordinated" && (
          <label>
            Responsable de la mission
            <select
              required
              value={leadBotId}
              onChange={(event) => setLead(event.target.value)}
            >
              <option value="">Choisir un personnage</option>
              {candidates.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {mode === "coordinated" && !candidates.length && (
          <p>Créez un personnage autre que Mino pour coordonner la mission.</p>
        )}
        <button type="submit" disabled={!projects.length}>
          Confier la mission
        </button>
      </fieldset>
      <CommandFeedback command={command} afterRetry={completed} />
      {cancel && (
        <button type="button" disabled={command.sending} onClick={cancel}>
          Fermer la préparation
        </button>
      )}
    </form>
  );
}

export function MissionProposal({
  port,
  message,
}: {
  port: Port;
  message: MessageView;
}) {
  if (!message.handoff) return null;
  const existing = port.agents?.missions.find(
    (mission) => mission.originMessageId === message.id && !mission.parentId,
  );
  return (
    <section
      className="missions-proposal"
      aria-label="Mission avec Mino"
      data-origin-message-id={message.id}
    >
      <h3>
        <Mascot size={28} /> Je peux confier ça
      </h3>
      <p>{message.handoff.why}</p>
      {existing ? (
        <button
          onClick={() => port.go({ page: "missions", missionId: existing.id })}
        >
          Consulter la mission · {statuses[existing.status] ?? existing.status}
        </button>
      ) : !port.agents ? (
        <p>Chargement des dossiers…</p>
      ) : (
        <MissionForm key={message.id} port={port} message={message} />
      )}
    </section>
  );
}

export function MissionList({ port }: { port: Port }) {
  const [creating, setCreating] = useState(false);
  return (
    <section className="missions-page">
      <header>
        <div>
          <h1>Missions</h1>
          <p>
            Les travaux confiés à vos personnages dans un dossier de projet.
          </p>
        </div>
        <button onClick={() => setCreating(true)}>Nouvelle mission</button>
      </header>
      {creating && (
        <section className="missions-card">
          <h2>Préparer une mission</h2>
          <MissionForm
            port={port}
            done={() => setCreating(false)}
            cancel={() => setCreating(false)}
          />
        </section>
      )}
      {!port.agents ? (
        <p>Chargement des missions…</p>
      ) : (
        <>
          {port.agents.engine.state === "unavailable" && (
            <p role="status">
              {port.agents.engine.message ?? "Exécutant indisponible."}
            </p>
          )}
          {!port.agents.missions.length && (
            <p>
              Aucune mission. Ajoutez un dossier dans Projets, puis confiez un
              objectif à un personnage.
            </p>
          )}
          <div className="missions-list">
            {port.agents.missions
              .filter((mission) => !mission.parentId)
              .map((mission) => (
                <button
                  className="missions-card"
                  key={mission.id}
                  onClick={() =>
                    port.go({ page: "missions", missionId: mission.id })
                  }
                >
                  <strong>{mission.title}</strong>
                  <span>{statuses[mission.status] ?? mission.status}</span>
                  <small>
                    {port.agents?.projects.find(
                      (project) => project.id === mission.projectId,
                    )?.name ?? "Projet indisponible"}{" "}
                    ·{" "}
                    {mission.mode === "coordinated"
                      ? "Avec un responsable"
                      : "Un exécutant"}
                  </small>
                  {mission.waiting && <span>{mission.waiting}</span>}
                </button>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
