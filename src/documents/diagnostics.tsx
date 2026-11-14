import type {
  AppView,
  ContextPlan,
  ContextSize,
  ReplyStyle,
  TaskView,
  TokenCounts,
  WorkView,
} from "../../server/src/protocol";
import { STEP_LABELS } from "../../server/web/tasks";
import { CALL_STATE_LABELS, count, plural, type BotNamer } from "./model";

const CONTEXT_SIZES: Record<ContextSize, string> = {
  short: "court",
  standard: "standard",
  long: "long",
};
const REPLY_STYLES: Record<ReplyStyle, string> = {
  concise: "concises",
  normal: "normales",
  detailed: "détaillées",
};

const RECALL_STATES: Record<
  NonNullable<ContextPlan["memory"]["recall"]>["state"],
  string
> = {
  used: "rappel utilisé",
  empty: "aucune source rappelée",
  unavailable: "indisponible",
  suspended: "suspendue",
};

const tokens = (counts: TokenCounts) =>
  `${count(counts.input)} en entrée dont ${count(counts.cachedInput)} lus en cache et ${count(counts.cacheWriteInput)} écrits en cache, ${count(counts.output)} en sortie dont ${count(counts.reasoningOutput)} de raisonnement, ${count(counts.total)} au total`;

type Fact = [term: string, value: string];

function planFacts(plan: ContextPlan): Fact[] {
  const document = plan.deliverable;
  return [
    [
      "Contexte envoyé",
      `Taille ${CONTEXT_SIZES[plan.contextSize]}, réponses ${REPLY_STYLES[plan.replyStyle]}, politique ${plan.policyVersion}`,
    ],
    [
      "Échanges",
      `${count(plan.exchanges.full)} complets, ${count(plan.exchanges.brief)} abrégés, ${count(plan.exchanges.omitted)} omis`,
    ],
    [
      "Document joint",
      document.kind === "none"
        ? "aucun"
        : document.kind === "complete"
          ? `complet, ${plural(document.chars, "caractère", "caractères")}`
          : `extrait de ${plural(document.chars, "caractère", "caractères")}, ${count(document.omittedChars)} omis`,
    ],
    [
      "Souvenirs",
      plan.memory.recall
        ? `Honcho : ${RECALL_STATES[plan.memory.recall.state]}, ${count(plan.memory.recall.items)} envoyés (${plural(plan.memory.recall.chars, "caractère", "caractères")}), ${count(plan.memory.recall.omitted)} non inclus`
        : `${count(plan.memory.count)}, ${plural(plan.memory.chars, "caractère", "caractères")}${plan.memory.overBudget ? ", budget dépassé" : ""}`,
    ],
    [
      "Pièces jointes",
      `${count(plan.attachments.count)}, ${plural(plan.attachments.chars, "caractère", "caractères")}`,
    ],
    [
      "Texte envoyé",
      `${plural(plan.baseChars + plan.inputChars, "caractère", "caractères")} (${count(plan.utf8Bytes)} octets), dont ${count(plan.instructionsChars)} de consignes. ${count(plan.clippedChars)} coupés`,
    ],
  ];
}

function attemptFacts(work: WorkView, name: BotNamer): Fact[] {
  const facts: Fact[] = [["Bot", name(work.botId)]];
  const attempt = work.attempt;
  if (!attempt) return [...facts, ["Appel", "aucun appel enregistré"]];
  const { requested, used, usage } = attempt;
  facts.push(
    [
      "Appel",
      `${attempt.n} sur ${work.attempts} · ${CALL_STATE_LABELS[attempt.state]}${attempt.step ? ` · ${STEP_LABELS[attempt.step].toLowerCase()}` : ""}`,
    ],
    [
      "Réglage demandé",
      `${requested.model ?? "modèle par défaut"} · ${requested.effort ?? "effort par défaut"} · ${requested.speed}`,
    ],
    [
      "Réglage utilisé",
      used
        ? `${used.model} · ${used.effort} · ${used.speed}`
        : "non confirmé par Codex",
    ],
  );
  if (attempt.plan) facts.push(...planFacts(attempt.plan));
  else facts.push(["Contexte envoyé", "non enregistré pour cet appel"]);
  if (usage)
    facts.push(
      ["Jetons de la dernière requête", tokens(usage.last)],
      ["Jetons cumulés du fil", tokens(usage.total)],
      [
        "Fenêtre de contexte du modèle",
        usage.modelContextWindow === null
          ? "non fournie par Codex"
          : `${count(usage.modelContextWindow)} jetons`,
      ],
    );
  else
    facts.push([
      "Consommation",
      attempt.state === "running"
        ? "pas encore reçue"
        : "non fournie par Codex",
    ]);
  if (attempt.error) facts.push(["Erreur", attempt.error]);
  return facts;
}

export function Diagnostics({
  view,
  work,
  task,
  name,
}: {
  view: AppView;
  work: WorkView;
  task: TaskView | null;
  name: BotNamer;
}) {
  const review = view.works.find((w) => w.id === task?.reviewWorkId);
  return (
    <details className="ez-doc-details">
      <summary>Diagnostic du dernier appel</summary>
      {[work, ...(review ? [review] : [])].map((each) => (
        <dl key={each.id} className="ez-doc-facts" data-work-id={each.id}>
          {attemptFacts(each, name).map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ))}
    </details>
  );
}
