import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Ban,
  Pause,
  Pencil,
  Play,
  Plus,
  Webhook,
} from "lucide-react";
import {
  EVENT_LIMITS,
  type CommandOf,
  type EventReceiptView,
  type EventRefusal,
  type SubscriptionState,
  type SubscriptionView,
} from "../../server/src/protocol";
import type { Port } from "../port";
import { uid } from "../api";
import { Mascot } from "../Mascot";
import { useAction } from "../characters";
import "./style.css";

const STATES: Record<SubscriptionState, string> = {
  inactive: "Inactif",
  active: "Actif",
  paused: "En pause",
  revoked: "Révoqué",
};
const REFUSALS: Record<EventRefusal, string> = {
  inactive: "l’abonnement n’était pas encore activé",
  paused: "l’abonnement était en pause",
  revoked: "l’abonnement était révoqué",
  bot_deleted: "le personnage avait été supprimé",
  trigger_mismatch: "le type d’événement ne correspond pas à l’abonnement",
  account_mismatch: "l’événement vient d’un autre compte",
  account_inactive: "le dernier état connu du compte n’était pas actif",
  per_day: "la limite du jour était atteinte",
  backlog: `${EVENT_LIMITS.openWorks} demandes de cet abonnement n’étaient pas terminées`,
  admission_refused: "l’admission commune a refusé la demande",
};
export const RULES = [
  "Rien n’est reçu avant « Activer ». L’activation exige la réception configurée sur ce serveur et un compte dont le dernier état connu est actif.",
  "Chaque événement porte un identifiant. Le même identifiant ne crée jamais un deuxième travail, même après une pause, une révocation ou un redémarrage.",
  `Au plus ${EVENT_LIMITS.perDay.max} demandes par jour (réglable), et au plus ${EVENT_LIMITS.openWorks} demandes ouvertes par abonnement. Au-delà, l’événement est refusé et le refus reste visible.`,
  "Une demande d’événement n’accorde aucun droit et n’approuve rien. Elle reçoit une réponse ou un livrable proposé, sans outil de service, sans offre de connexion et sans mission.",
  "Le contenu reçu est une donnée non fiable. Seuls les champs de premier niveau nommés ici sont copiés, coupés à 500 caractères chacun et 4000 au total, avec une marque visible. Les valeurs composées ne sont pas importées.",
  "Pas de recherche ni d’export Honcho pour cette demande.",
  "La pause et la révocation arrêtent aussi les demandes déjà reçues qui ne sont pas parties. Un appel déjà parti garde son usage ; rien n’est relancé.",
  "Chaque demande compte dans le budget Codex commun du jour. Codex n’annonce aucun prix : le coût est indisponible, jamais compté comme zéro.",
  "Le compte affiché est le dernier état observé par ce serveur, pas une lecture en direct du fournisseur. Ce serveur ne crée rien chez le fournisseur.",
  "Le téléphone peut voir les abonnements et les mettre en pause. Le reste se fait ici.",
];

const at = (iso: string) =>
  new Date(iso).toLocaleString("fr-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  });

function receiptLabel(receipt: EventReceiptView): string {
  const when = `${at(receipt.receivedAt)} (révision ${receipt.revision})`;
  const conflicts = receipt.conflicts
    ? ` · ${receipt.conflicts} copie${receipt.conflicts > 1 ? "s" : ""} au contenu différent, ignorée${receipt.conflicts > 1 ? "s" : ""}`
    : "";
  if (receipt.outcome === "refused")
    return `${when} : refusé, ${receipt.reason ? REFUSALS[receipt.reason] : "raison inconnue"}${conflicts}`;
  return `${when} : demande créée${receipt.workId ? "" : ", effacée depuis avec son personnage"}${conflicts}`;
}

type Draft = Omit<CommandOf<"subscription.create">, "type" | "requestId">;

function SubscriptionForm({
  port,
  subscription,
  onDone,
}: {
  port: Port;
  subscription?: SubscriptionView;
  onDone: (subscriptionId: string) => void;
}) {
  const [baseRevision] = useState(subscription?.revision ?? 0);
  const accounts = port.view.tools.accounts;
  const [draft, setDraft] = useState<Draft>(() =>
    subscription
      ? {
          botId: subscription.botId,
          accountId: subscription.accountId,
          triggerId: subscription.triggerId,
          triggerSlug: subscription.triggerSlug,
          text: subscription.text,
          fields: subscription.fields,
          perDay: subscription.perDay,
        }
      : {
          botId: port.view.activeBotId || port.view.bots[0]?.id || "",
          accountId: accounts[0]?.id ?? "",
          triggerId: "",
          triggerSlug: "",
          text: "",
          fields: [],
          perDay: EVENT_LIMITS.perDay.initial,
        },
  );
  const [fieldText, setFieldText] = useState(draft.fields.join(", "));
  const action = useAction(port);
  const set = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const frozen = Boolean(subscription);
  return (
    <form
      className="ez-event-form"
      aria-label={subscription ? "Modifier l’abonnement" : "Nouvel abonnement"}
      onSubmit={(e) => {
        e.preventDefault();
        const fields = fieldText
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
        const { botId, accountId, triggerId, triggerSlug, text, perDay } =
          draft;
        void action.perform(
          subscription
            ? {
                type: "subscription.update",
                requestId: uid(),
                subscriptionId: subscription.id,
                expectedRevision: baseRevision,
                text,
                fields,
                perDay,
              }
            : {
                type: "subscription.create",
                requestId: uid(),
                botId,
                accountId,
                triggerId,
                triggerSlug,
                text,
                fields,
                perDay,
              },
          (r) => {
            if (r.result.kind === "subscription")
              onDone(r.result.subscriptionId);
          },
        );
      }}
    >
      {subscription && (
        <p>
          Cette modification porte sur la révision {baseRevision}. Le
          personnage, le compte et le déclencheur ne changent pas : pour un
          autre usage, configurez un nouveau déclencheur chez le fournisseur.
        </p>
      )}
      <fieldset disabled={action.disabled}>
        <div className="ez-event-row">
          <label>
            Personnage
            <select
              value={draft.botId}
              disabled={frozen}
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
            Compte connu de ce serveur
            <select
              value={draft.accountId}
              disabled={frozen}
              required
              onChange={(e) => set({ accountId: e.target.value })}
            >
              {!accounts.length && <option value="">Aucun compte</option>}
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.alias} · {account.toolkit} · {account.status}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="ez-event-row">
          <label>
            Identifiant du déclencheur
            <input
              required
              disabled={frozen}
              placeholder="ti_…"
              value={draft.triggerId}
              onChange={(e) => set({ triggerId: e.target.value.trim() })}
            />
          </label>
          <label>
            Type d’événement
            <input
              required
              disabled={frozen}
              placeholder="GITHUB_ISSUE_ADDED_EVENT"
              value={draft.triggerSlug}
              onChange={(e) =>
                set({ triggerSlug: e.target.value.trim().toUpperCase() })
              }
            />
          </label>
        </div>
        <label>
          Consigne envoyée dans le fil
          <textarea
            required
            maxLength={EVENT_LIMITS.instructionChars}
            value={draft.text}
            onChange={(e) => set({ text: e.target.value })}
          />
        </label>
        <div className="ez-event-row">
          <label>
            Champs copiés, séparés par des virgules (vide : aucun)
            <input
              placeholder="title, url"
              value={fieldText}
              onChange={(e) => setFieldText(e.target.value)}
            />
          </label>
          <label>
            Demandes au plus par jour
            <input
              type="number"
              required
              min={EVENT_LIMITS.perDay.min}
              max={EVENT_LIMITS.perDay.max}
              value={draft.perDay}
              onChange={(e) => set({ perDay: Number(e.target.value) })}
            />
          </label>
        </div>
        <button className="black">
          {subscription
            ? "Enregistrer la modification"
            : "Enregistrer sans activer"}
          <ArrowRight size={16} />
        </button>
      </fieldset>
      {action.feedback}
    </form>
  );
}

function SubscriptionCard({
  port,
  subscription,
  focused,
}: {
  port: Port;
  subscription: SubscriptionView;
  focused: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [revoking, setRevoking] = useState(false);
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) card.current?.scrollIntoView({ block: "start" });
  }, [focused]);
  const action = useAction(port);
  const bot = port.view.bots.find((b) => b.id === subscription.botId);
  const run = (
    command: CommandOf<
      | "subscription.activate"
      | "subscription.pause"
      | "subscription.resume"
      | "subscription.revoke"
    >,
  ) => void action.perform(command);
  const openWork = (workId: string) => {
    const work = port.view.works.find((w) => w.id === workId);
    if (work)
      port.go({
        page: "chat",
        botId: work.threadBotId,
        messageId: work.requestMessageId,
      });
  };
  const account = subscription.account;
  return (
    <article
      ref={card}
      className={focused ? "ez-event focused" : "ez-event"}
      aria-label={`Abonnement ${subscription.triggerSlug} de ${bot?.name ?? "personnage supprimé"}`}
    >
      <header>
        {bot && <Mascot shape={bot.shape} color={bot.color} size={28} />}
        <strong>{bot?.name ?? "Personnage supprimé"}</strong>
        <span className={`ez-event-state ${subscription.state}`}>
          {STATES[subscription.state]}
        </span>
        <small>révision {subscription.revision}</small>
      </header>
      <p className="ez-event-source">
        Source : <code>{subscription.triggerSlug}</code> · déclencheur{" "}
        <code>{subscription.triggerId}</code> · transport{" "}
        <code>{subscription.transport}</code>
      </p>
      <p className="ez-event-source">
        Compte :{" "}
        {account
          ? `${account.alias} (${account.toolkit}) · dernier état connu ${account.status}, vu le ${at(account.checkedAt)}`
          : "inconnu de ce serveur"}
      </p>
      {subscription.text ? (
        <p className="ez-event-text">{subscription.text}</p>
      ) : (
        <p className="ez-event-note">Consigne effacée avec son personnage.</p>
      )}
      <p className="ez-event-source">
        {subscription.fields.length
          ? `Champs copiés : ${subscription.fields.join(", ")}`
          : "Aucun champ de l’événement n’est copié."}{" "}
        · {subscription.today.admitted} sur {subscription.perDay} demandes
        aujourd’hui (UTC) · {subscription.today.refused} refus aujourd’hui ·{" "}
        {subscription.open} sur {EVENT_LIMITS.openWorks} demandes ouvertes
      </p>
      {subscription.recent.length > 0 && (
        <section>
          <h3>Derniers événements reçus</h3>
          <ol>
            {subscription.recent.map((receipt) => (
              <li key={receipt.webhookId} className={receipt.outcome}>
                {receiptLabel(receipt)}{" "}
                {receipt.workId && (
                  <button
                    className="outline"
                    onClick={() => receipt.workId && openWork(receipt.workId)}
                  >
                    Voir la demande et son résultat
                    <ArrowRight size={15} />
                  </button>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className="actions">
        {subscription.state === "inactive" && (
          <button
            className="black"
            disabled={action.disabled}
            onClick={() =>
              run({
                type: "subscription.activate",
                requestId: uid(),
                subscriptionId: subscription.id,
                expectedRevision: subscription.revision,
              })
            }
          >
            <Webhook size={16} />
            Activer : accepter ces demandes automatiques
          </button>
        )}
        {subscription.state === "active" && (
          <button
            className="outline"
            disabled={action.disabled}
            onClick={() =>
              run({
                type: "subscription.pause",
                requestId: uid(),
                subscriptionId: subscription.id,
              })
            }
          >
            <Pause size={16} />
            Mettre en pause
          </button>
        )}
        {subscription.state === "paused" && (
          <button
            className="outline"
            disabled={action.disabled}
            onClick={() =>
              run({
                type: "subscription.resume",
                requestId: uid(),
                subscriptionId: subscription.id,
                expectedRevision: subscription.revision,
              })
            }
          >
            <Play size={16} />
            Reprendre
          </button>
        )}
        {subscription.state !== "revoked" && (
          <button className="outline" onClick={() => setEditing(!editing)}>
            <Pencil size={16} />
            Modifier
          </button>
        )}
        {subscription.state !== "revoked" &&
          (revoking ? (
            <>
              <button
                className="outline"
                disabled={action.disabled}
                onClick={() =>
                  run({
                    type: "subscription.revoke",
                    requestId: uid(),
                    subscriptionId: subscription.id,
                  })
                }
              >
                <Ban size={16} />
                Confirmer la révocation
              </button>
              <button className="outline" onClick={() => setRevoking(false)}>
                Garder l’abonnement
              </button>
            </>
          ) : (
            <button className="outline" onClick={() => setRevoking(true)}>
              <Ban size={16} />
              Révoquer
            </button>
          ))}
      </div>
      {revoking && subscription.state !== "revoked" && (
        <p className="ez-event-note">
          La révocation est définitive. Ce déclencheur reste lié à cet
          abonnement : il ne pourra servir à aucun autre personnage. Les
          demandes déjà reçues et pas encore parties sont annulées.
        </p>
      )}
      {action.feedback}
      {editing && subscription.state !== "revoked" && (
        <SubscriptionForm
          port={port}
          subscription={subscription}
          onDone={() => setEditing(false)}
        />
      )}
    </article>
  );
}

export function EventsPage({
  port,
  subscriptionId,
}: {
  port: Port;
  subscriptionId?: string;
}) {
  const [creating, setCreating] = useState(false);
  const events = port.view.events;
  const ordered = [...events.subscriptions].sort(
    (a, b) =>
      Number(a.state === "revoked") - Number(b.state === "revoked") ||
      a.createdAt.localeCompare(b.createdAt),
  );
  return (
    <div className="content-page ez-events">
      <button className="outline" onClick={() => port.go({ page: "routines" })}>
        Routines : une demande à heure fixe
      </button>
      <div className="eyebrow">ÉVÉNEMENTS DE SERVICE SUR CET ORDINATEUR</div>
      <h1>Une demande, quand un service l’annonce.</h1>
      <div className="notice" role="status">
        {events.reception.state === "off" ? (
          <p>
            Réception non configurée : ce serveur n’écoute aucun événement et
            aucun abonnement ne peut être activé. Il faut un secret de
            signature, un nom de transport et un port, fournis par la personne
            qui administre ce PC. Une adresse joignable par le fournisseur reste
            à prévoir séparément.
          </p>
        ) : (
          <p>
            Réception configurée localement pour le transport{" "}
            <code>{events.reception.transport}</code>. Ce n’est pas la preuve
            que le fournisseur joint ce PC : seule une demande reçue le montre.{" "}
            {events.receipts} identifiant{events.receipts > 1 ? "s" : ""} gardé
            {events.receipts > 1 ? "s" : ""} sur {EVENT_LIMITS.receipts}.
            {events.ignored.n > 0 &&
              ` ${events.ignored.n} événement${events.ignored.n > 1 ? "s" : ""} authentifié${events.ignored.n > 1 ? "s" : ""} sans abonnement, ignoré${events.ignored.n > 1 ? "s" : ""}.`}
            {events.unavailable.n > 0 &&
              ` ${events.unavailable.n} refusé${events.unavailable.n > 1 ? "s" : ""} parce que le registre est plein ; le fournisseur les renverra.`}
          </p>
        )}
      </div>
      <ul className="ez-event-rules">
        {RULES.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
      {creating ? (
        <SubscriptionForm
          port={port}
          onDone={(id) => {
            setCreating(false);
            port.go({ page: "events", subscriptionId: id });
          }}
        />
      ) : (
        <button className="black" onClick={() => setCreating(true)}>
          <Plus size={16} />
          Nouvel abonnement
        </button>
      )}
      {ordered.length === 0 && !creating && (
        <p className="ez-event-note">
          Aucun abonnement. Un nouvel abonnement reste inactif tant que vous ne
          l’activez pas. Au plus {EVENT_LIMITS.subscriptions} par transport,
          révoqués compris.
        </p>
      )}
      {ordered.map((subscription) => (
        <SubscriptionCard
          key={subscription.id}
          port={port}
          subscription={subscription}
          focused={subscription.id === subscriptionId}
        />
      ))}
    </div>
  );
}
