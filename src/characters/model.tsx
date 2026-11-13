import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";
import { PROVIDER_PATHS } from "./provider-paths";
import {
  STANDARD_SPEED,
  type BotChoice,
  type BotView,
  type CatalogModel,
} from "../../server/src/protocol";
import type { Port } from "../port";
import { uid } from "../api";
import { useAction } from "./action";
import { chosenModel, matchesModel, withModel } from "./choice";

const EFFORT_GLOSS: Record<string, string> = {
  minimal: "Minimale",
  low: "Légère",
  medium: "Moyenne",
  high: "Poussée",
  xhigh: "Très poussée",
  max: "Maximale",
  ultra: "Extrême",
};

type Provider = keyof typeof PROVIDER_PATHS;
const PROVIDERS: [RegExp, Provider][] = [
  [/^(gpt|chatgpt|codex|o\d)([-.\s]|$)|openai/i, "openai"],
  [/claude|anthropic/i, "anthropic"],
  [/gemini|gemma/i, "google"],
  [/llama|meta-/i, "meta"],
  [/mistral|mixtral|codestral|magistral/i, "mistral"],
];

export function ProviderLogo({ model }: { model: string | null }) {
  const provider = model
    ? PROVIDERS.find(([pattern]) => pattern.test(model))?.[1]
    : undefined;
  if (!provider)
    return (
      <span className="provider-logo" data-provider="unknown">
        <Cpu size={14} aria-hidden="true" />
      </span>
    );
  const { name, d } = PROVIDER_PATHS[provider];
  return (
    <span className="provider-logo" data-provider={provider} title={name}>
      <svg viewBox="0 0 24 24" role="img" aria-label={name}>
        <path d={d} fill="currentColor" />
      </svg>
    </span>
  );
}

export function modelLabel(port: Port, bot: BotView): string {
  const engine = port.view.engine;
  const model =
    engine.state === "ready"
      ? chosenModel(engine.models, bot.choice.model)
      : null;
  return model?.displayName ?? bot.choice.model ?? "Modèle par défaut";
}

export function ModelPicker({ port, bot }: { port: Port; bot: BotView }) {
  const action = useAction(port);
  return (
    <ChoiceSettings
      port={port}
      name={bot.name}
      choice={bot.choice}
      locked={action.disabled}
      feedback={action.feedback}
      onChange={(choice) =>
        void action.perform({
          type: "bot.configure",
          requestId: uid(),
          botId: bot.id,
          ...choice,
        })
      }
    />
  );
}

export function DraftModelPicker({
  port,
  choice,
  onChange,
}: {
  port: Port;
  choice: BotChoice;
  onChange: (choice: BotChoice) => void;
}) {
  return (
    <ChoiceSettings
      port={port}
      name="ce personnage"
      choice={choice}
      onChange={onChange}
    />
  );
}

type Level = { value: string; token: string; gloss?: string; hint?: string };

const notOffered = (token: string): Level => ({
  value: token,
  token,
  gloss: "Non proposé",
});

function ChoiceSettings({
  port,
  name,
  choice,
  onChange,
  locked = false,
  feedback,
}: {
  port: Port;
  name: string;
  choice: BotChoice;
  onChange: (choice: BotChoice) => void;
  locked?: boolean;
  feedback?: React.ReactNode;
}) {
  const engine = port.view.engine;
  const models = engine.state === "ready" ? engine.models : [];
  const current = chosenModel(models, choice.model);
  return (
    <div className="model-settings">
      <ModelMenu
        disabled={locked}
        name={name}
        engine={engine}
        choice={choice}
        current={current}
        onPick={(id) => {
          if (locked) return;
          const next = withModel(choice, id, chosenModel(models, id));
          if (
            next.model !== choice.model ||
            next.effort !== choice.effort ||
            next.speed !== choice.speed
          )
            onChange(next);
        }}
      />
      {current ? (
        <fieldset className="model-levels" disabled={locked}>
          <Levels
            legend="Réflexion"
            value={choice.effort ?? ""}
            fallback={current.defaultEffort}
            options={[
              ...current.efforts.map((token) => ({
                value: token,
                token,
                gloss: EFFORT_GLOSS[token],
              })),
              ...(choice.effort !== null &&
              !current.efforts.includes(choice.effort)
                ? [notOffered(choice.effort)]
                : []),
            ]}
            onChange={(effort) =>
              onChange({ ...choice, effort: effort || null })
            }
          />
          <Levels
            legend="Vitesse"
            value={choice.speed}
            options={[
              {
                value: STANDARD_SPEED,
                token: STANDARD_SPEED,
                gloss: "Normale",
              },
              ...current.speeds.map((s) => ({
                value: s.id,
                token: s.id,
                gloss: s.name,
                hint: s.description,
              })),
              ...(choice.speed !== STANDARD_SPEED &&
              !current.speeds.some((s) => s.id === choice.speed)
                ? [notOffered(choice.speed)]
                : []),
            ]}
            onChange={(speed) => onChange({ ...choice, speed })}
          />
        </fieldset>
      ) : (
        <p className="model-note" role="status">
          {engine.state === "starting"
            ? "Les niveaux s’affichent dès que le catalogue de Codex répond."
            : engine.state === "unavailable"
              ? "Le catalogue de Codex ne répond pas : ses niveaux ne peuvent pas être listés."
              : "Ce modèle n’est plus au catalogue. Choisissez un modèle pour voir ses niveaux."}{" "}
          Réglage actuel : réflexion{" "}
          {choice.effort ? (
            <code>{choice.effort}</code>
          ) : (
            "par défaut du modèle"
          )}
          , vitesse <code>{choice.speed}</code>.
        </p>
      )}
      {feedback}
    </div>
  );
}

function ModelMenu({
  disabled,
  name,
  engine,
  choice,
  current,
  onPick,
}: {
  disabled: boolean;
  name: string;
  engine: Port["view"]["engine"];
  choice: BotChoice;
  current: CatalogModel | null;
  onPick: (id: BotChoice["model"]) => void;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const models = engine.state === "ready" ? engine.models : [];
  const shown = models.filter((m) => matchesModel(m, query));
  function close(refocus: boolean) {
    setOpen(false);
    setQuery("");
    if (refocus) trigger.current?.focus();
  }
  function pick(model: BotChoice["model"]) {
    if (disabled) return;
    close(true);
    onPick(model);
  }
  useEffect(() => {
    if (engine.state !== "ready") void fetch("/api/catalog").catch(() => {});
  }, [open, engine.state]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        !panel.current?.contains(target) &&
        !trigger.current?.contains(target)
      )
        close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const modelId = current?.id ?? choice.model;
  const label =
    engine.state === "starting"
      ? "Chargement des modèles…"
      : engine.state === "unavailable"
        ? "Modèles indisponibles"
        : (current?.displayName ?? choice.model ?? "Modèle par défaut");
  const identified = engine.state === "ready" && current !== null;
  return (
    <div className="model-picker">
      <button
        ref={trigger}
        type="button"
        className="model-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Modèle de ${name} : ${label}${identified ? ` (${current.id})` : ""}`}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <ProviderLogo model={modelId} />
        <span className="model-name">{label}</span>
        {identified && <code className="model-id">{current.id}</code>}
        {identified && choice.model === null && (
          <small className="model-default">par défaut</small>
        )}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label={`Modèle de ${name}`}
          className="model-panel"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close(true);
            }
          }}
        >
          <button type="button" className="link" onClick={() => pick(null)}>
            Modèle par défaut
          </button>
          {engine.state !== "ready" ? (
            <p className="model-note" role="status">
              {engine.state === "starting"
                ? "Les modèles se chargent. Réessayez dans un instant."
                : engine.message}
            </p>
          ) : (
            <>
              <input
                autoFocus
                className="model-search"
                role="combobox"
                aria-expanded="true"
                aria-controls={`${id}-list`}
                aria-activedescendant={
                  shown[active] ? `${id}-${shown[active].id}` : undefined
                }
                aria-label="Chercher un modèle"
                placeholder="Chercher par nom ou identifiant…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const step = e.key === "ArrowDown" ? 1 : -1;
                    setActive((a) => (a + step + shown.length) % shown.length);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (shown[active]) pick(shown[active].id);
                  }
                }}
              />
              <ul id={`${id}-list`} role="listbox" aria-label="Modèles">
                {shown.map((m, i) => (
                  <li
                    key={m.id}
                    id={`${id}-${m.id}`}
                    role="option"
                    aria-selected={m.id === current?.id}
                    data-active={i === active || undefined}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => pick(m.id)}
                  >
                    <ProviderLogo model={m.id} />
                    <span className="model-name">{m.displayName}</span>
                    <code className="model-id">{m.id}</code>
                    {m.isDefault && <small>par défaut</small>}
                    {m.id === current?.id && (
                      <Check size={14} aria-hidden="true" />
                    )}
                  </li>
                ))}
                {!shown.length && (
                  <li className="model-note">Aucun modèle trouvé.</li>
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Levels({
  legend,
  value,
  options,
  fallback,
  onChange,
}: {
  legend: string;
  value: string;
  options: readonly Level[];

  fallback?: string;
  onChange: (value: string) => void;
}) {
  const name = useId();
  return (
    <fieldset className="model-choices">
      <legend>{legend}</legend>
      <div>
        {fallback !== undefined && (
          <label title="Suit le niveau par défaut du modèle">
            <input
              type="radio"
              name={name}
              value=""
              aria-label={`Par défaut (${fallback})`}
              checked={value === ""}
              onChange={() => onChange("")}
            />
            <span>Par défaut</span>
            <small>
              <code>{fallback}</code>
            </small>
          </label>
        )}
        {options.map(({ value: id, token, gloss, hint }) => (
          <label key={id} title={hint}>
            <input
              type="radio"
              name={name}
              value={id}
              aria-label={gloss ? `${token} (${gloss})` : token}
              checked={value === id}
              onChange={() => onChange(id)}
            />
            <code>{token}</code>
            {gloss && <small>{gloss}</small>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
