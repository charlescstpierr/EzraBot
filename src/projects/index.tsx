import { useEffect, useRef, useState } from "react";
import {
  AGENT_LIMITS,
  type AgentCommand,
  type ProjectView,
} from "../../server/src/agent-protocol";
import type { AgentsOutcome, Port } from "../port";
import { statuses, uid } from "../api";
import { AgentCommandFeedback, useAgentCommand } from "../agent-outbox";
import { Mascot } from "../Mascot";
import "./projects.css";

function commandText(command: ProjectView["checkCommand"]) {
  return command?.join(" ") ?? "";
}

export function ProjectsPage({ port }: { port: Port }) {
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [check, setCheck] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editCheck, setEditCheck] = useState("");
  const [archiving, setArchiving] = useState<string | null>(null);
  const command = useAgentCommand(port);
  const { sending, locked } = command;
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (adding) dialog.current?.showModal();
  }, [adding]);
  function settle(result: AgentsOutcome | null) {
    if (result?.kind !== "accepted") return;
    setAdding(false);
    setPath("");
    setName("");
    setCheck("");
    setEditing(null);
    setArchiving(null);
  }
  function send(input: AgentCommand) {
    void command.send(input).then(settle);
  }
  const active =
    port.agents?.projects.filter((project) => !project.archived) ?? [];
  const archived =
    port.agents?.projects.filter((project) => project.archived) ?? [];
  return (
    <section className="projects-page">
      <header>
        <div>
          <h1>Projets</h1>
          <p>
            Choisissez les dossiers dans lesquels vos personnages peuvent
            travailler.
          </p>
        </div>
        <button disabled={locked} onClick={() => setAdding(true)}>
          Ajouter un dossier
        </button>
      </header>
      {!adding && (
        <AgentCommandFeedback
          command={command}
          afterRetry={settle}
          className="projects-error"
        />
      )}
      {!port.agents ? (
        <p>Chargement des projets…</p>
      ) : (
        <>
          {port.agents.engine.state === "unavailable" && (
            <p>{port.agents.engine.message ?? "Exécutant indisponible."}</p>
          )}
          {!active.length && (
            <div className="projects-empty">
              <Mascot size={90} />
              <h2>Tout commence par un dossier.</h2>
              <p>Ajoutez un projet existant, puis préparez une mission.</p>
            </div>
          )}
          <div className="projects-list">
            {active.map((project) => (
              <article className="projects-card" key={project.id}>
                <h2>{project.name}</h2>
                <p className="projects-path">{project.path}</p>
                <p>
                  {project.git
                    ? "Dépôt Git détecté"
                    : "Pas un dépôt Git. La liste des fichiers changés ne sera pas disponible."}
                </p>
                <p>
                  {project.checkCommand
                    ? "Contrôle après chaque essai"
                    : "Sans commande de contrôle"}
                </p>
                {project.checkCommand && (
                  <pre>{JSON.stringify(project.checkCommand)}</pre>
                )}
                <div className="projects-actions">
                  <button
                    disabled={locked}
                    onClick={() => {
                      setEditing(project.id);
                      setEditCheck(commandText(project.checkCommand));
                    }}
                  >
                    Modifier le contrôle
                  </button>
                  <button onClick={() => port.go({ page: "missions" })}>
                    Préparer une mission
                  </button>
                  <button
                    disabled={locked}
                    onClick={() => setArchiving(project.id)}
                  >
                    Archiver
                  </button>
                </div>
                {editing === project.id && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      send({
                        type: "project.update",
                        requestId: uid(),
                        projectId: project.id,
                        checkCommand: editCheck.trim(),
                      });
                    }}
                  >
                    <fieldset disabled={locked}>
                      <label>
                        Commande de contrôle
                        <input
                          maxLength={AGENT_LIMITS.checkCommandChars}
                          value={editCheck}
                          onChange={(event) => setEditCheck(event.target.value)}
                        />
                      </label>
                      <p>
                        Commande lancée sans shell. Pas de pipes ni de
                        redirections. Laissez vide pour ne pas effectuer de
                        contrôle.
                      </p>
                      <button type="submit">Enregistrer le contrôle</button>
                      <button type="button" onClick={() => setEditing(null)}>
                        Annuler
                      </button>
                    </fieldset>
                  </form>
                )}
                {archiving === project.id && (
                  <section
                    className="projects-confirm"
                    role="group"
                    aria-label="Confirmer l’archivage"
                  >
                    <p>
                      Archiver « {project.name} » ? Le dossier et ses fichiers
                      restent sur le PC.
                    </p>
                    <button
                      disabled={locked}
                      onClick={() =>
                        send({
                          type: "project.archive",
                          requestId: uid(),
                          projectId: project.id,
                        })
                      }
                    >
                      Confirmer l’archivage
                    </button>
                    <button
                      disabled={locked}
                      onClick={() => setArchiving(null)}
                    >
                      Garder le projet
                    </button>
                  </section>
                )}
                <ul>
                  {port.agents?.missions
                    .filter(
                      (mission) =>
                        mission.projectId === project.id && !mission.parentId,
                    )
                    .map((mission) => (
                      <li key={mission.id}>
                        <button
                          onClick={() =>
                            port.go({ page: "missions", missionId: mission.id })
                          }
                        >
                          {mission.title} ·{" "}
                          {statuses[mission.status] ?? mission.status}
                        </button>
                      </li>
                    ))}
                </ul>
              </article>
            ))}
          </div>
          {archived.length > 0 && (
            <details>
              <summary>Projets archivés · {archived.length}</summary>
              {archived.map((project) => (
                <p key={project.id}>
                  {project.name} · {project.path}
                </p>
              ))}
            </details>
          )}
        </>
      )}
      {adding && (
        <dialog
          ref={dialog}
          onCancel={(event) => {
            event.preventDefault();
            if (!sending) setAdding(false);
          }}
          aria-labelledby="projects-add-title"
          className="projects-dialog"
        >
          <h2 id="projects-add-title">Ajouter un dossier</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (path.trim())
                send({
                  type: "project.add",
                  requestId: uid(),
                  path: path.trim(),
                  name: name.trim(),
                  checkCommand: check.trim(),
                });
            }}
          >
            <fieldset disabled={locked}>
              <label>
                Chemin complet du dossier
                <input
                  autoFocus
                  required
                  maxLength={AGENT_LIMITS.pathChars}
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                />
              </label>
              <label>
                Nom affiché
                <input
                  maxLength={AGENT_LIMITS.projectNameChars}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Commande de contrôle
                <input
                  maxLength={AGENT_LIMITS.checkCommandChars}
                  placeholder="npm test"
                  value={check}
                  onChange={(event) => setCheck(event.target.value)}
                />
              </label>
              <p>
                Commande lancée sans shell. Pas de pipes ni de redirections. Un
                champ vide signifie aucun contrôle.
              </p>
              <p>
                L’exécutant pourra modifier ce dossier dans les permissions
                actuelles du moteur PC.
              </p>
              <button type="submit">Confier ce dossier</button>
            </fieldset>
          </form>
          <button disabled={sending} onClick={() => setAdding(false)}>
            Fermer
          </button>
          <AgentCommandFeedback command={command} afterRetry={settle} />
        </dialog>
      )}
    </section>
  );
}
