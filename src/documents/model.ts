import {
  PLAN_STEPS,
  type AppView,
  type AttemptView,
  type TaskStep,
  type TaskView,
  type VersionView,
  type WorkView,
} from "../../server/src/protocol";

export const currentVersion = (work: WorkView): VersionView | undefined =>
  work.versions.at(-1);

export const DELETED_BOT_NAME = "Bot supprimé";
export type BotNamer = (id: string) => string;
export const botNamer =
  (view: AppView): BotNamer =>
  (id) =>
    view.bots.find((bot) => bot.id === id)?.name ?? DELETED_BOT_NAME;

export type PlannedStep = {
  step: TaskStep;
  botId: string;
  state: AttemptView["state"] | "planned";
};

export function stepChain(task: TaskView): PlannedStep[] {
  const steps: PlannedStep[] = task.calls.map((call) => ({
    step: call.step,
    botId: call.botId,
    state: call.state,
  }));
  if (task.status === "cancelled" || task.status === "validated") return steps;
  for (const step of PLAN_STEPS[task.plan])
    if (!steps.some((made) => made.step === step))
      steps.push({
        step,
        botId:
          step === "review" ? (task.reviewerBotId ?? "") : task.authorBotId,
        state: "planned",
      });
  return steps;
}

export const CALL_STATE_LABELS: Record<PlannedStep["state"], string> = {
  planned: "prévu",
  running: "en cours",
  succeeded: "fait",
  failed: "échec",
  cancelled: "annulé",
  interrupted: "interrompu",
};

export const count = (value: number) => value.toLocaleString("fr-CA");
export const plural = (n: number, one: string, many: string) =>
  `${count(n)} ${n > 1 ? many : one}`;
export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString("fr-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  });
export const fromVersion = (n: number | null) =>
  n === null ? "d’un document vide" : `de la version ${n}`;
export const versionSource = (version: VersionView, author: string) =>
  version.source === "result"
    ? `Réponse de ${author}`
    : version.source === "edit"
      ? "Modifiée par vous"
      : `Restaurée depuis la version ${version.restoredFromN ?? "?"}`;
