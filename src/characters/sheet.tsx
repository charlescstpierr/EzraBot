import { useState } from "react";
import { X } from "lucide-react";
import catalogue from "../../server/assets/mascots.json";
import {
  LIMITS,
  STANDARD_SPEED,
  type BotChoice,
  type BotView,
} from "../../server/src/protocol";
import type { BotSheetTarget, Port } from "../port";
import { uid } from "../api";
import { Mascot } from "../Mascot";
import { Sheet } from "../Sheet";
import { useAction } from "./action";
import { DraftModelPicker, ModelPicker } from "./model";

const colorNames: Record<string, string> = {
  "#f3ecd7": "Crème",
  "#895931": "Châtaigne",
  "#ff2236": "Rouge",
  "#ff5c03": "Orange vif",
  "#fe8c03": "Orange",
  "#02c369": "Vert",
  "#06b49e": "Turquoise",
  "#1179fe": "Bleu",
  "#8850ff": "Violet",
  "#ff2a92": "Rose",
  "#808080": "Gris",
};
const defaultColor = (shape: string) =>
  catalogue.shapes.find((s) => s.id === shape)?.defaultColor ?? "#8de343";

type Draft = Pick<
  BotView,
  "name" | "title" | "shape" | "color" | "instructions"
>;

function freshDraft(bots: BotView[]): Draft {
  const used = new Set(bots.map((b) => b.shape));
  const vivid = catalogue.shapes.filter((s) => s.defaultColor !== "#f3ecd7");
  const shape = (vivid.find((s) => !used.has(s.id)) ?? vivid[0]).id;
  return {
    name: "",
    title: "",
    shape,
    color: defaultColor(shape),
    instructions: "",
  };
}

export function BotSheet({
  port,
  target,
  open = true,
  onClose,
  onCreated,
}: {
  port: Port;
  target: BotSheetTarget;
  open?: boolean;
  onClose: () => void;
  onCreated: (botId: string) => void;
}) {
  const bot =
    target.mode === "edit"
      ? port.view.bots.find((b) => b.id === target.botId)
      : undefined;
  const [draft, setDraft] = useState<Draft>(() =>
    bot
      ? {
          name: bot.name,
          title: bot.title,
          shape: bot.shape,
          color: bot.color,
          instructions: bot.instructions,
        }
      : freshDraft(port.view.bots),
  );
  const [choice, setChoice] = useState<BotChoice>({
    model: null,
    effort: null,
    speed: STANDARD_SPEED,
  });
  const [look, setLook] = useState(false);
  const action = useAction(port);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const heading = bot ? `Modifier ${bot.name}` : "Nouveau personnage";
  const left = LIMITS.botInstructionsChars - draft.instructions.length;
  const colors = [
    ...new Set([defaultColor(draft.shape), ...catalogue.colors, draft.color]),
  ];
  if (!open) return null;
  if (target.mode === "edit" && !bot)
    return (
      <Sheet
        label="Personnage indisponible"
        className="bot-sheet"
        onClose={onClose}
      >
        <p>Ce personnage n’est plus disponible.</p>
        <button className="outline" onClick={onClose}>
          Fermer
        </button>
      </Sheet>
    );
  return (
    <Sheet label={heading} className="bot-sheet" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!bot)
            void action.perform(
              { type: "bot.create", requestId: uid(), ...draft, ...choice },
              (r) => {
                if (r.result.kind === "bot") onCreated(r.result.botId);
              },
            );
          else
            void action.perform(
              { type: "bot.update", requestId: uid(), botId: bot.id, ...draft },
              onClose,
            );
        }}
      >
        <header className="bot-sheet-head">
          <h2>{heading}</h2>
          <button
            type="button"
            className="icon"
            aria-label="Fermer"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <fieldset disabled={action.disabled}>
          <div className="bot-sheet-identity">
            <Mascot shape={draft.shape} color={draft.color} size={52} />
            <div>
              <input
                className="bot-sheet-name"
                aria-label="Nom"
                placeholder="Nom du personnage"
                required
                data-autofocus={bot ? undefined : true}
                maxLength={24}
                autoComplete="off"
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
              />
              <input
                className="bot-sheet-title"
                aria-label="Description courte"
                placeholder="Description courte (facultative)"
                maxLength={60}
                autoComplete="off"
                value={draft.title}
                onChange={(e) => set({ title: e.target.value })}
              />
            </div>
          </div>
          <div className="bot-sheet-model">
            <span aria-hidden="true">Modèle</span>
            {bot ? (
              <ModelPicker port={port} bot={bot} />
            ) : (
              <DraftModelPicker
                port={port}
                choice={choice}
                onChange={setChoice}
              />
            )}
          </div>
          <textarea
            className="bot-sheet-text"
            aria-label="Personnalité et instructions"
            rows={5}
            maxLength={LIMITS.botInstructionsChars}
            placeholder="Décris sa personnalité et sa façon de répondre. Ex. Tu es patient et curieux. Tu me tutoies et tu poses une question à la fois."
            value={draft.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
          />
          {left < 150 && (
            <small className="bot-sheet-count" aria-live="polite">
              {left} caractères restants
            </small>
          )}
          <div className="bot-sheet-chips">
            <button
              type="button"
              className="chip"
              aria-expanded={look}
              onClick={() => setLook(!look)}
            >
              <span
                className="chip-dot"
                style={{ background: draft.color }}
                aria-hidden="true"
              />
              Apparence
            </button>
          </div>
          {look && (
            <div className="bot-look">
              <fieldset>
                <legend>Forme</legend>
                <div className="bot-look-shapes">
                  {catalogue.shapes.map((s) => (
                    <label key={s.id} title={s.label}>
                      <input
                        type="radio"
                        name="bot-shape"
                        value={s.id}
                        checked={draft.shape === s.id}
                        onChange={() =>
                          set({
                            shape: s.id,
                            color:
                              draft.color === defaultColor(draft.shape)
                                ? s.defaultColor
                                : draft.color,
                          })
                        }
                      />
                      <Mascot
                        shape={s.id}
                        color={
                          draft.color === defaultColor(draft.shape)
                            ? s.defaultColor
                            : draft.color
                        }
                        size={36}
                      />
                      <span className="sr-only">{s.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>Couleur</legend>
                <div className="bot-look-colors">
                  {colors.map((c) => (
                    <label
                      key={c}
                      style={{ "--swatch": c } as React.CSSProperties}
                    >
                      <input
                        type="radio"
                        name="bot-color"
                        value={c}
                        checked={draft.color === c}
                        onChange={() => set({ color: c })}
                      />
                      <span className="sr-only">
                        {c === defaultColor(draft.shape)
                          ? "Couleur d’origine"
                          : (colorNames[c] ?? c)}
                      </span>
                    </label>
                  ))}
                  <label className="bot-look-custom">
                    <span className="sr-only">Autre couleur</span>
                    <input
                      type="color"
                      value={draft.color}
                      onChange={(e) => set({ color: e.target.value })}
                    />
                  </label>
                </div>
              </fieldset>
            </div>
          )}
        </fieldset>
        {action.feedback}
        <footer className="bot-sheet-foot">
          {bot ? (
            <button
              type="button"
              className="link"
              onClick={() => port.go({ page: "characters", botId: bot.id })}
            >
              Mémoire et réglages
            </button>
          ) : (
            <button type="button" className="link" onClick={onClose}>
              Annuler
            </button>
          )}
          <button className="black" type="submit" disabled={action.disabled}>
            {action.busy
              ? bot
                ? "Enregistrement…"
                : "Création…"
              : bot
                ? "Enregistrer"
                : "Créer et discuter"}
          </button>
        </footer>
      </form>
    </Sheet>
  );
}
