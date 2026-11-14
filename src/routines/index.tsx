import { useState } from "react";
import {
  CalendarClock,
  Pause,
  Play,
  Pencil,
  Trash2,
  Plus,
  ArrowRight,
} from "lucide-react";
import {
  LIMITS,
  ROUTINE_LIMITS,
  type CommandOf,
  type RoutineDecisionView,
  type RoutineSkipReason,
  type RoutineSlotView,
  type RoutineState,
  type RoutineView,
} from "../../server/src/protocol";
import type { Port } from "../port";
import { uid } from "../api";
import { Mascot } from "../Mascot";
import { useAction } from "../characters";
import "./style.css";

const WEEKDAYS = [
  "lun.",
  "mar.",
  "mer.",
  "jeu.",
  "ven.",
  "sam.",
  "dim.",
] as const;
const STATES: Record<RoutineState, string> = {
  inactive: "Inactive",
  active: "Active",
  paused: "En pause",
  held: "Attend votre vérification",
  ended: "Terminée",
};
const SKIPS: Record<RoutineSkipReason, string> = {
  offline: "sautée : Mino était arrêté à l’heure prévue",
  late: `sautée : plus de ${ROUTINE_LIMITS.lateMinutes} minutes de retard`,
  cooldown: `sautée : moins de ${ROUTINE_LIMITS.cooldownMinutes} minutes après la demande précédente`,
  previous_open: "sautée : la demande précédente n’était pas terminée",
  uncertain: "sautée : un effet précédent est incertain",
};
export const RULES = [
  "Rien ne part avant « Activer ». Une routine activée, reprise ou modifiée ne regarde que les créneaux futurs.",
  `Le PC doit être allumé et Mino ouvert. Mino vérifie toutes les ${ROUTINE_LIMITS.tickSeconds} secondes. Un créneau en retard de plus de ${ROUTINE_LIMITS.lateMinutes} minutes, ou manqué pendant que Mino était arrêté, est sauté sans rattrapage.`,
  `Au plus une demande par date, et au moins ${ROUTINE_LIMITS.cooldownMinutes} minutes réelles entre deux demandes d’une même routine, même après une modification ou un changement de fuseau.`,
  "Une heure qui n’existe pas ce jour-là (passage à l’heure d’été) saute la date. Une heure qui se répète (retour à l’heure normale) ne donne qu’une demande, au premier passage.",
  "Si la demande précédente n’est pas terminée, attend une validation ou une décision, la date est sautée. Si un effet reste incertain, la routine attend votre vérification.",
  "Chaque demande compte dans le budget Codex commun du jour. Codex n’annonce aucun prix : le coût est indisponible, jamais compté comme zéro.",
  "Une routine n’accorde aucun droit et n’approuve rien. Une action proposée attend votre approbation exacte.",
  "Pas de recherche ni d’export Honcho pour cette demande. Le fil peut encore fournir les échanges précédents que vous avez autorisés.",
  "La pause arrête les prochaines demandes. Elle n’arrête pas un appel déjà parti : les commandes du travail restent les seules à le faire.",
  "Texte seul : ni pièce jointe, ni invitation @, ni mode document, ni source choisie.",
];

const offset = (minutes: number) =>
  `UTC${minutes < 0 ? "−" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
const civilDate = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("fr-CA", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

function slotLabel(slot: RoutineSlotView, routine: RoutineView): string {
  if (slot.kind === "missing")
    return `${civilDate(slot.date)} : ${routine.time} n’existe pas ce jour-là, la date est sautée`;
  return `${civilDate(slot.date)}, ${routine.time} (${offset(slot.offsetMinutes)})${slot.repeated ? " · heure répétée : une seule demande, au premier passage" : ""}`;
}

function decisionLabel(decision: RoutineDecisionView): string {
  const when = `${civilDate(decision.date)} (révision ${decision.revision})`;
  if (decision.outcome === "admitted")
    return `${when} : demande envoyée dans le fil`;
  if (decision.outcome === "refused")
    return `${when} : refusée. ${decision.message}`;
  return `${when} : ${SKIPS[decision.reason]}`;
}

type Draft = Omit<CommandOf<"routine.create">, "type" | "requestId">;
const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function RoutineForm({
  port,
  routine,
  onDone,
}: {
  port: Port;
  routine?: RoutineView;
  onDone: (routineId: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    routine
      ? {
          botId: routine.botId,
          text: routine.text,
          time: routine.time,
          weekdays: routine.weekdays,
          zone: routine.zone,
          endsOn: routine.endsOn,
          cap: routine.cap,
        }
      : {
          botId: port.view.activeBotId || port.view.bots[0]?.id || "",
          text: "",
          time: "08:30",
          weekdays: [1, 2, 3, 4, 5],
          zone: browserZone(),
          endsOn: inDays(30),
          cap: 20,
        },
  );
  const action = useAction(port);
  const set = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  return (
    <form
      className="ez-routine-form"
      aria-label={routine ? "Modifier la routine" : "Nouvelle routine"}
      onSubmit={(e) => {
        e.preventDefault();
        const { botId, ...fields } = draft;
        void action.perform(
          routine
            ? {
                type: "routine.update",
                requestId: uid(),
                routineId: routine.id,
                expectedRevision: routine.revision,
                ...fields,
              }
            : { type: "routine.create", requestId: uid(), botId, ...fields },
          (r) => {
            if (r.result.kind === "routine") onDone(r.result.routineId);
          },
        );
      }}
    >
      <fieldset disabled={action.disabled}>
        <label>
          Personnage
          <select
            value={draft.botId}
            disabled={Boolean(routine)}
            onChange={(e) => set({ botId: e.target.value })}
          >
            {port.view.bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Texte envoyé dans le fil
          <textarea
            required
            maxLength={LIMITS.messageChars}
            value={draft.text}
            onChange={(e) => set({ text: e.target.value })}
          />
        </label>
        <div className="ez-routine-row">
          <label>
            Heure locale
            <input
              type="time"
              required
              value={draft.time}
              onChange={(e) => set({ time: e.target.value })}
            />
          </label>
          <label>
            Fuseau horaire
            <input
              required
              value={draft.zone}
              onChange={(e) => set({ zone: e.target.value })}
            />
          </label>
        </div>
        <fieldset className="ez-routine-days">
          <legend>Jours</legend>
          {WEEKDAYS.map((label, index) => {
            const day = index + 1;
            return (
              <label key={day}>
                <input
                  type="checkbox"
                  checked={draft.weekdays.includes(day)}
                  onChange={(e) =>
                    set({
                      weekdays: e.target.checked
                        ? [...draft.weekdays, day].sort((a, b) => a - b)
                        : draft.weekdays.filter((d) => d !== day),
                    })
                  }
                />
                {label}
              </label>
            );
          })}
        </fieldset>
        <div className="ez-routine-row">
          <label>
            Dernier jour
            <input
              type="date"
              required
              value={draft.endsOn}
              onChange={(e) => set({ endsOn: e.target.value })}
            />
          </label>
          <label>
            Demandes au plus, sur toute sa vie
            <input
              type="number"
              required
              min={1}
              max={ROUTINE_LIMITS.cap}
              value={draft.cap}
              onChange={(e) => set({ cap: Number(e.target.value) })}
            />
          </label>
        </div>
        <button className="black">
          {routine ? "Enregistrer la modification" : "Enregistrer sans activer"}
          <ArrowRight size={16} />
        </button>
      </fieldset>
      {action.feedback}
    </form>
  );
}

function RoutineCard({
  port,
  routine,
  focused,
}: {
  port: Port;
  routine: RoutineView;
  focused: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [deleting, setDeleting] = useState(false);
  const action = useAction(port);
  const bot = port.view.bots.find((b) => b.id === routine.botId);
  const run = (
    command: CommandOf<
      "routine.activate" | "routine.pause" | "routine.resume" | "routine.delete"
    >,
  ) => void action.perform(command);
  const last = routine.last;
  return (
    <article
      className={focused ? "ez-routine focused" : "ez-routine"}
      aria-label={`Routine de ${bot?.name ?? "personnage"}`}
    >
      <header>
        {bot && <Mascot shape={bot.shape} color={bot.color} size={28} />}
        <strong>{bot?.name}</strong>
        <span className={`ez-routine-state ${routine.state}`}>
          {STATES[routine.state]}
        </span>
        <small>révision {routine.revision}</small>
      </header>
      <p className="ez-routine-text">{routine.text}</p>
      <p className="ez-routine-schedule">
        {routine.time} ·{" "}
        {routine.weekdays.map((d) => WEEKDAYS[d - 1]).join(" ")} ·{" "}
        {routine.zone} · jusqu’au {civilDate(routine.endsOn)} ·{" "}
        {routine.admitted} sur {routine.cap} demandes
        {routine.endedBecause === "cap" && " · plafond atteint"}
        {routine.endedBecause === "end_date" && " · date de fin passée"}
      </p>
      {routine.upcoming.length > 0 && (
        <section>
          <h3>
            {routine.state === "active"
              ? "Prochains créneaux"
              : "Créneaux si elle est active"}
          </h3>
          <ol>
            {routine.upcoming.map((slot) => (
              <li key={slot.date} className={slot.kind}>
                {slotLabel(slot, routine)}
              </li>
            ))}
          </ol>
        </section>
      )}
      {last && (
        <p className="ez-routine-last">
          Dernière décision : {decisionLabel(last)}
          {last.outcome === "admitted" && (
            <button
              className="outline"
              onClick={() =>
                port.go({
                  page: "chat",
                  botId: routine.botId,
                  messageId: last.messageId,
                })
              }
            >
              Voir la demande et son résultat
              <ArrowRight size={15} />
            </button>
          )}
        </p>
      )}
      {routine.heldOn && (
        <div className="notice" role="status">
          <p>
            {routine.heldOn.label} Vérifiez ce qui s’est passé avant de
            reprendre. Reprendre ne relance rien et ne change pas cet effet :
            seules les dates futures seront demandées.
          </p>
          <p>
            <code>{routine.heldOn.key}</code>
          </p>
          {routine.heldOn.workId && (
            <button
              className="outline"
              onClick={() => port.go({ page: "chat", botId: routine.botId })}
            >
              Voir le fil
            </button>
          )}
          <button
            className="black"
            disabled={action.disabled}
            onClick={() =>
              run({
                type: "routine.resume",
                requestId: uid(),
                routineId: routine.id,
                confirmBlocker: routine.heldOn?.key ?? "",
              })
            }
          >
            J’ai vérifié, reprendre pour les dates futures
          </button>
        </div>
      )}
      <div className="actions">
        {routine.state === "inactive" && (
          <button
            className="black"
            disabled={action.disabled}
            onClick={() =>
              run({
                type: "routine.activate",
                requestId: uid(),
                routineId: routine.id,
                expectedRevision: routine.revision,
              })
            }
          >
            <CalendarClock size={16} />
            Activer : autoriser ces demandes automatiques
          </button>
        )}
        {(routine.state === "active" || routine.state === "held") && (
          <button
            className="outline"
            disabled={action.disabled}
            onClick={() =>
              run({
                type: "routine.pause",
                requestId: uid(),
                routineId: routine.id,
              })
            }
          >
            <Pause size={16} />
            Mettre en pause
          </button>
        )}
        {routine.state === "paused" && (
          <button
            className="outline"
            disabled={action.disabled}
            onClick={() =>
              run({
                type: "routine.resume",
                requestId: uid(),
                routineId: routine.id,
              })
            }
          >
            <Play size={16} />
            Reprendre
          </button>
        )}
        {routine.state !== "ended" && (
          <button className="outline" onClick={() => setEditing(!editing)}>
            <Pencil size={16} />
            Modifier
          </button>
        )}
        {deleting ? (
          <>
            <button
              className="outline"
              disabled={action.disabled}
              onClick={() =>
                run({
                  type: "routine.delete",
                  requestId: uid(),
                  routineId: routine.id,
                })
              }
            >
              <Trash2 size={16} />
              Confirmer la suppression
            </button>
            <button className="outline" onClick={() => setDeleting(false)}>
              Garder la routine
            </button>
          </>
        ) : (
          <button className="outline" onClick={() => setDeleting(true)}>
            <Trash2 size={16} />
            Supprimer
          </button>
        )}
      </div>
      {deleting && (
        <p className="ez-routine-note">
          Les demandes déjà envoyées restent dans le fil. La routine, ses textes
          et ses décisions sont effacés.
        </p>
      )}
      {action.feedback}
      {editing && (
        <RoutineForm
          port={port}
          routine={routine}
          onDone={() => setEditing(false)}
        />
      )}
    </article>
  );
}

export function RoutinesPage({
  port,
  routineId,
}: {
  port: Port;
  routineId?: string;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="content-page ez-routines">
      <div className="eyebrow">ROUTINES SUR CET ORDINATEUR</div>
      <h1>Une demande, à heure fixe.</h1>
      <ul className="ez-routine-rules">
        {RULES.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
      {creating ? (
        <RoutineForm
          port={port}
          onDone={(id) => {
            setCreating(false);
            port.go({ page: "routines", routineId: id });
          }}
        />
      ) : (
        <button className="black" onClick={() => setCreating(true)}>
          <Plus size={16} />
          Nouvelle routine
        </button>
      )}
      {port.view.routines.length === 0 && !creating && (
        <p className="ez-routine-note">
          Aucune routine. Une nouvelle routine reste inactive tant que vous ne
          l’activez pas.
        </p>
      )}
      {port.view.routines.map((routine) => (
        <RoutineCard
          key={routine.id}
          port={port}
          routine={routine}
          focused={routine.id === routineId}
        />
      ))}
    </div>
  );
}
