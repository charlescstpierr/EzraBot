import type { AgentCommand } from "../../server/src/agent-protocol";

type FieldOf<C> = C extends unknown ? keyof C : never;
type Field = Exclude<FieldOf<AgentCommand>, "type" | "requestId">;

const COMMANDS = {
  "project.add": "Ajouter un dossier",
  "project.update": "Modifier le contrôle d’un projet",
  "project.archive": "Archiver un projet",
  "mission.create": "Confier une mission",
  "mission.stop": "Arrêter une mission",
  "mission.resume": "Reprendre une mission",
  "mission.continue": "Préciser à Mino",
  "mission.revise": "Modifier l’objectif",
  "mission.review": "Demander une relecture",
  "mission.accept": "Valider un résultat",
  "mission.budget": "Accorder des essais",
} satisfies Record<AgentCommand["type"], string>;

const FIELDS = {
  path: "Chemin du dossier",
  name: "Nom affiché",
  checkCommand: "Commande de contrôle",
  projectId: "Projet",
  missionId: "Mission",
  goal: "Objectif",
  mode: "Organisation",
  leadBotId: "Responsable",
  origin: "Origine",
  note: "Précision",
  start: "Relance après enregistrement",
  attemptId: "Essai",
  model: "Modèle",
  effort: "Effort",
} satisfies Record<Field, string>;

export type CommandNames = {
  bots: readonly { id: string; name: string }[];
  projects: readonly { id: string; name: string }[];
  missions: readonly { id: string; title: string }[];
};

export function describeCommand(
  command: AgentCommand,
  names: CommandNames,
): { label: string; fields: [name: string, value: string][] } {
  const { type, requestId: _, ...values } = command;
  function read(field: Field, value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (field === "projectId")
      return names.projects.find((p) => p.id === value)?.name ?? String(value);
    if (field === "missionId")
      return names.missions.find((m) => m.id === value)?.title ?? String(value);
    if (field === "leadBotId")
      return names.bots.find((b) => b.id === value)?.name ?? String(value);
    if (field === "mode")
      return value === "coordinated" ? "Avec un responsable" : "Un exécutant";
    if (field === "origin") return "Proposition de Mino dans la conversation";
    if (typeof value === "boolean") return value ? "Oui" : "Non";
    return value === "" ? "Aucune valeur" : String(value);
  }
  return {
    label: COMMANDS[type],
    fields: (Object.entries(values) as [Field, unknown][]).flatMap(
      ([field, value]) => {
        const text = read(field, value);
        return text === null ? [] : [[FIELDS[field], text]];
      },
    ),
  };
}
