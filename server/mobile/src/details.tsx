const labels: Record<string,string> = {pending:'En attente',queued:'En attente',running:'En cours',writing:'Rédaction',thinking:'Réflexion',starting:'Démarrage',review:'À valider',done:'Terminé',failed:'Échoué',cancelled:'Annulé',draft:'Rédaction',synthesis:'Synthèse',revise:'Nouvelle passe',finished:'Prêt à valider',validated:'Validé',stopped:'Interrompu',goal_changed:'Objectif modifié',needs_decision:'À arbitrer',info_waiting:'Précision en attente',reviewer_unavailable:'Relecture impossible',succeeded:'Terminé'};
const label = (value:string) => labels[value] ?? value;
const HONCHO_STATES: Record<string, string> = {
  preparing: "Préparation de l’espace Honcho en cours.",
  active: "Mémoire active.",
  withdrawal_pending: "Oubli en cours. La mémoire est fermée.",
  withdrawal_unverified: "Mémoire fermée après un oubli. L’effacement chez Honcho n’est pas prouvé.",
  reset_pending: "Préparation d’un nouvel espace vide en cours.",
};
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type {
  Command,
  MobileBot,
  MobileSnapshot,
  MobileTask,
  MobileWork,
} from "./generated/mobile-protocol";
import { Button, Code, Field, Mascot, catalog, s } from "./ui";
type CommandInput = Command extends infer C
  ? C extends Command
    ? Omit<C, "requestId">
    : never
  : never;
export type Dispatch = (input: CommandInput) => Promise<void>;
export function Profile({
  bot,
  snapshot,
  send,
}: {
  bot: MobileBot;
  snapshot: MobileSnapshot;
  send: Dispatch;
}) {
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [confirm, setConfirm] = useState("");
  const [memory, setMemory] = useState("");
  return (
    <View>
      <Mascot shape={bot.shape} color={bot.color} size={90} />
      <Field label="Nom" value={name} onChange={setName} />
      <Field label="Rôle" value={title} onChange={setTitle} />
      <Field
        label="Instructions"
        value={instructions}
        onChange={setInstructions}
        multiline
      />
      <Button
        title="Enregistrer le profil"
        onPress={() =>
          void send({
            type: "bot.update",
            botId: bot.id,
            name,
            title,
            instructions,
          })
        }
      />
      <Text style={s.title}>Réponses</Text>
      <View style={s.row}>
        {(["concise", "normal", "detailed"] as const).map((replyStyle) => (
          <Button
            key={replyStyle}
            title={replyStyle}
            solid={replyStyle === bot.replyStyle}
            onPress={() =>
              void send({ type: "bot.update", botId: bot.id, replyStyle })
            }
          />
        ))}
      </View>
      <Text style={s.title}>Contexte</Text>
      <View style={s.row}>
        {(["short", "standard", "long"] as const).map((contextSize) => (
          <Button
            key={contextSize}
            title={contextSize}
            solid={contextSize === bot.contextSize}
            onPress={() =>
              void send({ type: "bot.update", botId: bot.id, contextSize })
            }
          />
        ))}
      </View>
      <Text style={s.title}>Forme et couleur</Text>
      <View style={s.row}>
        {catalog.shapes.map((shape) => (
          <Button
            key={shape.id}
            title={shape.label}
            solid={shape.id === bot.shape}
            onPress={() =>
              void send({
                type: "bot.update",
                botId: bot.id,
                shape: shape.id,
                color: shape.defaultColor,
              })
            }
          />
        ))}
      </View>
      <View style={s.row}>
        {catalog.colors.map((color) => (
          <Button
            key={color}
            title={color}
            solid={color === bot.color}
            onPress={() =>
              void send({ type: "bot.update", botId: bot.id, color })
            }
          />
        ))}
      </View>
      <Text style={s.title}>Modèle sur le PC</Text>
      <Text style={s.muted}>
        Choix actuel · {bot.choice.model ?? "Par défaut"} ·{" "}
        {bot.choice.effort ?? "défaut"} · {bot.choice.speed}
      </Text>
      {snapshot.engine.state === "ready" ? (
        snapshot.engine.models.map((model) => (
          <View key={model.id} style={s.card}>
            <Text style={s.text}>{model.displayName}</Text>
            <Button
              title="Choisir ce modèle"
              onPress={() =>
                void send({
                  type: "bot.configure",
                  botId: bot.id,
                  model: model.id,
                  effort: model.defaultEffort,
                  speed: model.speeds[0]?.id ?? "standard",
                })
              }
            />
            <View style={s.row}>
              {model.efforts.map((effort) => (
                <Button
                  key={effort}
                  title={effort}
                  onPress={() =>
                    void send({
                      type: "bot.configure",
                      botId: bot.id,
                      model: model.id,
                      effort,
                      speed: model.speeds[0]?.id ?? "standard",
                    })
                  }
                />
              ))}
              {model.speeds.map((speed) => (
                <Button
                  key={speed.id}
                  title={speed.name}
                  onPress={() =>
                    void send({
                      type: "bot.configure",
                      botId: bot.id,
                      model: model.id,
                      effort: model.defaultEffort,
                      speed: speed.id,
                    })
                  }
                />
              ))}
            </View>
          </View>
        ))
      ) : (
        <Text style={s.text}>
          {snapshot.engine.state === "unavailable"
            ? snapshot.engine.message
            : "Catalogue en cours de démarrage."}
        </Text>
      )}
      {bot.memoryScope ? (
        <View style={s.card}>
          <Text style={s.title}>
            Mémoire Honcho · {bot.memoryScope.label}
          </Text>
          <Text style={s.text}>
            {HONCHO_STATES[bot.memoryScope.state] ?? bot.memoryScope.state}
          </Text>
          <Text style={s.text}>
            Les déclarations, leur correction, l’exclusion et l’oubli se gèrent
            sur l’ordinateur. Les souvenirs locaux de {bot.name} ne sont plus
            envoyés.
          </Text>
        </View>
      ) : (
        <>
          <Text style={s.title}>
            Souvenirs · {bot.memoryChars} caractères
          </Text>
          {bot.memories.map((item) => (
            <Memory key={item.id} botId={bot.id} item={item} send={send} />
          ))}
          <Field
            label="Nouveau souvenir"
            value={memory}
            onChange={setMemory}
            multiline
          />
          <Button
            title="Ajouter le souvenir"
            disabled={!memory.trim()}
            onPress={() =>
              void send({
                type: "memory.create",
                botId: bot.id,
                text: memory,
              }).then(() => setMemory(""))
            }
          />
        </>
      )}
      <View style={s.card}>
        <Text style={s.title}>Supprimer {bot.name}</Text>
        <Text style={s.text}>
          Les éléments conservés ailleurs restent signés « Bot supprimé ». Le PC
          revérifie ces nombres.
        </Text>
        <Code text={JSON.stringify(bot.deletion, null, 2)} />
        <Field
          label={`Écrivez exactement ${bot.name}`}
          value={confirm}
          onChange={setConfirm}
        />
        <Button
          title="Confirmer la suppression"
          disabled={confirm !== bot.name}
          onPress={() =>
            void send({
              type: "bot.delete",
              botId: bot.id,
              confirmName: confirm,
              expected: bot.deletion,
            })
          }
        />
      </View>
    </View>
  );
}
function Memory({
  botId,
  item,
  send,
}: {
  botId: string;
  item: MobileBot["memories"][number];
  send: Dispatch;
}) {
  const [text, setText] = useState(item.text);
  const [deleting, setDeleting] = useState(false);
  return (
    <View style={s.card}>
      <Field label="Souvenir" value={text} onChange={setText} multiline />
      <View style={s.row}>
        <Button
          title="Modifier"
          onPress={() =>
            void send({ type: "memory.update", botId, memoryId: item.id, text })
          }
        />
        <Button
          title={deleting ? "Confirmer la suppression" : "Supprimer"}
          onPress={() =>
            deleting
              ? void send({ type: "memory.delete", botId, memoryId: item.id })
              : setDeleting(true)
          }
        />
      </View>
    </View>
  );
}
export function CreateBot({ send }: { send: Dispatch }) {
  const [name, setName] = useState("");
  const [shape, setShape] = useState(catalog.shapes[0]);
  return (
    <View>
      <Field label="Nom du bot" value={name} onChange={setName} />
      <View style={s.row}>
        {catalog.shapes.map((item) => (
          <Button
            key={item.id}
            title={item.label}
            solid={shape.id === item.id}
            onPress={() => setShape(item)}
          />
        ))}
      </View>
      <Mascot shape={shape.id} color={shape.defaultColor} size={100} />
      <Button
        title="Créer le bot"
        disabled={!name.trim()}
        onPress={() =>
          void send({
            type: "bot.create",
            name,
            title: "",
            shape: shape.id,
            color: shape.defaultColor,
          })
        }
      />
    </View>
  );
}
export function Work({
  work,
  snapshot,
  send,
  canApprove,
}: {
  work: MobileWork;
  snapshot: MobileSnapshot;
  send: Dispatch;
  canApprove: boolean;
}) {
  const latest = work.versions.at(-1);
  const [title, setTitle] = useState(latest?.title ?? work.title);
  const [body, setBody] = useState(latest?.body ?? "");
  const [base, setBase] = useState(latest?.id ?? null);
  const task = snapshot.tasks.find((t) => t.id === work.taskId);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (latest && latest.id !== base && (!dirty || (body.trim() === latest.body && title.trim() === latest.title))) { if (!dirty) { setTitle(latest.title); setBody(latest.body); } setBase(latest.id); setDirty(false); } }, [latest, dirty, base, body, title]);
  return (
    <View>
      <Text style={s.title}>{work.title}</Text>
      <Text style={s.muted}>
        {label(work.state)}{work.attempt?.stage ? ` · ${label(work.attempt.stage)}` : ""}{work.attempt?.error ? ` · ${work.attempt.error}` : ""}
      </Text>
      <Text style={s.muted}>Dernière tentative {work.attempt?.n ?? 0}. Même travail dans ce fil.</Text>
      <Text style={s.text}>{work.lastFact.kind === 'none' ? 'Aucun résultat confirmé.' : work.lastFact.kind === 'execution' ? `Action enregistrée · ${work.lastFact.state}. ${work.lastFact.state === 'unknown' ? 'Résultat inconnu. Action non renvoyée.' : ''} Gérer le reçu et son compte rendu sur le PC.` : work.lastFact.kind === 'version' ? `Version ${work.lastFact.n} enregistrée ci-dessous.` : 'Réponse enregistrée dans le fil.'}</Text>
      {(work.next.kind === 'new_request' || (work.next.kind === 'none' && work.state !== 'review' && work.state !== 'done')) && <Text style={s.muted}>{work.next.reason}</Text>}
      {work.next.kind === 'document' && <Text style={s.muted}>Les commandes de ce travail documentaire figurent ci-dessous. Le bouton « Continuer » permet une reprise quand il est disponible.</Text>}
      {dirty && (latest?.id ?? null) !== base && (
        <Text style={s.text}>
          Une nouvelle version existe sur le PC. Votre brouillon conserve sa
          base. Le PC peut refuser une sauvegarde en conflit.
        </Text>
      )}
      {task?.progress && task.status === 'running' && <View style={s.card}><Text style={s.title}>{label(task.progress.step)}</Text><Text style={s.muted}>Texte reçu, en cours de rédaction</Text><Code text={task.progress.body ?? task.progress.reply}/></View>}
      <Field label="Titre du résultat" value={title} onChange={value => {setDirty(true);setTitle(value);}} />
      <Field
        label="Résultat modifiable"
        value={body}
        onChange={value=>{setDirty(true);setBody(value);}}
        multiline
      />
      {/<(?:!doctype|html|script)\b/i.test(body) && <Text style={s.muted}>
        Aperçu HTML désactivé. Le code source est affiché sans exécution, réseau
        ou accès aux fichiers.
      </Text>}
      <Button
        title="Enregistrer une version"
        disabled={!body.trim() || (!task && !base)}
        onPress={() =>
          void send(
            task
              ? {
                  type: "task.edit",
                  taskId: task.id,
                  baseVersionId: base,
                  title,
                  body,
                }
              : base
                ? {
                    type: "version.edit",
                    workId: work.id,
                    baseVersionId: base,
                    title,
                    body,
                  }
                : {
                    type: "task.edit",
                    taskId: "",
                    baseVersionId: null,
                    title,
                    body,
                  },
          )
        }
      />
      {latest && (
        <Button
          title="Charger la dernière version PC"
          onPress={() => {
            setTitle(latest.title);
            setBody(latest.body);
            setBase(latest.id);setDirty(false);
          }}
        />
      )}
      <View style={s.row}>
        {(["work.cancel", "work.retry", "work.accept"] as const).map((type) => (
          <Button
            key={type}
            disabled={
              type === "work.accept"
                ? work.state !== "review" ||
                  task?.status === "running" ||
                  task?.status === "queued"
                : type === "work.retry"
                  ? work.next.kind !== "retry"
                  : work.state === "cancelled" || work.state === "done"
            }
            title={
              type === "work.cancel"
                ? "Annuler"
                : type === "work.retry"
                  ? "Reprendre ce travail"
                  : "Valider le résultat"
            }
            onPress={() => void send({ type, workId: work.id })}
          />
        ))}
      </View>
      <Text style={s.title}>Versions</Text>
      {work.versions.map((version) => (
        <View key={version.id} style={s.card}>
          <Text style={s.text}>
            v{version.n} · {version.title}
          </Text>
          <Code text={version.body} />
          <Button
            title={`Restaurer v${version.n}`}
            onPress={() =>
              void send({
                type: "version.restore",
                workId: work.id,
                versionId: version.id,
              })
            }
          />
          <Button
            title="Proposer au Carnet local"
            onPress={() =>
              void send({
                type: "publication.propose",
                workId: work.id,
                versionId: version.id,
                destination: "carnet",
              })
            }
          />
        </View>
      ))}
      {work.proposals.map((proposal) => (
        <View key={proposal.id} style={s.card}>
          <Text style={s.title}>Confirmation Carnet · {proposal.state}</Text>
          <Code
            text={JSON.stringify(
              {
                action: proposal.action,
                destination: proposal.destination,
                versionId: proposal.versionId,
                versionN: proposal.versionN,
                payloadSha256: proposal.payloadSha256,
                title: proposal.title,
              },
              null,
              2,
            )}
          />
          <Code text={proposal.body} />
          <Text style={s.muted}>
            Cette confirmation porte exactement sur l’action et le texte
            ci-dessus.
          </Text>
          <Button
            title="Approuver exactement cette publication"
            disabled={
              !canApprove ||
              proposal.state !== "open" ||
              body.trim() !== latest?.body ||
              title.trim() !== latest?.title
            }
            onPress={() =>
              void send({
                type: "publication.approve",
                proposalId: proposal.id,
                action: proposal.action,
                destination: proposal.destination,
                versionId: proposal.versionId,
                payloadSha256: proposal.payloadSha256,
              })
            }
          />
          <Button
            title="Refuser"
            disabled={proposal.state !== "open"}
            onPress={() =>
              void send({ type: "publication.reject", proposalId: proposal.id })
            }
          />
        </View>
      ))}
      {task && <Task task={task} work={work} send={send} />}
    </View>
  );
}
function Task({
  task,
  work,
  send,
}: {
  task: MobileTask;
  work: MobileWork;
  send: Dispatch;
}) {
  const [text, setText] = useState("");
  return (
    <View style={s.card}>
      <Text style={s.title}>Objectif · {label(task.status)}</Text>
      <Text style={s.text}>{task.goal}</Text>
      <Field
        label="Précision ou nouvel objectif"
        value={text}
        onChange={setText}
        multiline
      />
      <Button
        title="Ajouter une précision"
        disabled={!text.trim()}
        onPress={() =>
          void send({
            type: "task.intent",
            taskId: task.id,
            intent: { kind: "add_info", text },
          })
        }
      />
      <Button
        title="Changer l’objectif"
        disabled={!text.trim()}
        onPress={() =>
          void send({
            type: "task.intent",
            taskId: task.id,
            intent: { kind: "change_goal", text },
          })
        }
      />
      <Button
        title="Annuler la tâche"
        onPress={() =>
          void send({
            type: "task.intent",
            taskId: task.id,
            intent: { kind: "cancel" },
          })
        }
      />
      <Button
        title="Continuer"
        disabled={!task.canContinue}
        onPress={() => void send({ type: "task.continue", taskId: task.id })}
      />
      {task.progress && (
        <View style={s.card}>
          <Text style={s.title}>Texte partiel reçu · {label(task.progress.step)}</Text>
          <Text style={s.muted}>
            Ce texte n’est pas encore une version enregistrée.
          </Text>
          <Code text={task.progress.body ?? task.progress.reply} />
        </View>
      )}
      {task.events.map((event) => (
        <View key={event.id} style={s.card}>
          <Text style={s.text}>
            {event.kind} · {event.text}
          </Text>
          <Code text={JSON.stringify(event.delivery, null, 2)} />
        </View>
      ))}
      <Text style={s.title}>Appels et relais</Text>
      {task.calls.map((call, i) => (
        <Text key={`${call.botId}-${call.n}-${i}`} style={s.muted}>
          {call.botId} · {label(call.step)} · {label(call.state)} ·{" "}
          {call.turnAccepted ? "tour accepté" : "tour non accepté"}
        </Text>
      ))}
      {task.handoffs.map((h) => (
        <Text key={h.id} style={s.text}>
          {h.fromBotId} · {h.fromStep} → {h.toStep} · transmis à{" "}
          {h.readBy.map((r) => r.botId).join(", ") || "personne pour le moment"}
        </Text>
      ))}
      {task.proposals.map((p) => (
        <View key={p.id} style={s.card}>
          <Text style={s.title}>
            Proposition · {p.reason} · {p.state}
          </Text>
          <Text style={s.text}>{p.title}</Text>
          <Code text={p.body} />
          <Button
            title="Adopter cette proposition"
            disabled={p.state !== "open"}
            onPress={() =>
              void send({
                type: "doc.adopt",
                proposalId: p.id,
                seenVersionId: work.versions.at(-1)?.id ?? null,
                seenRevision: task.revision,
              })
            }
          />
          <Button
            title="Écarter"
            disabled={p.state !== "open"}
            onPress={() => void send({ type: "doc.dismiss", proposalId: p.id })}
          />
        </View>
      ))}
    </View>
  );
}
