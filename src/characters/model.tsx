import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";
import type { BotView, CatalogModel } from "../../server/src/protocol";
import type { Port } from "../port";
import { uid } from "../api";
import { useAction } from "./action";

const effortNames: Record<string, string> = {
  minimal: "Minimale",
  low: "Légère",
  medium: "Moyenne",
  high: "Poussée",
  xhigh: "Très poussée",
};

export function modelLabel(port: Port, bot: BotView): string {
  const engine = port.view.engine;
  if (engine.state !== "ready") return bot.choice.model ?? "Modèle par défaut";
  const model = engine.models.find((m) =>
    bot.choice.model ? m.id === bot.choice.model : m.isDefault,
  );
  return model?.displayName ?? bot.choice.model ?? "Modèle par défaut";
}

/** The model a bot answers with, chosen where the bot is: saved at once through bot.configure. */
export function ModelPicker({ port, bot }: { port: Port; bot: BotView }) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const action = useAction(port);
  const engine = port.view.engine;
  const models = engine.state === "ready" ? engine.models : [];
  const current =
    models.find((m) =>
      bot.choice.model ? m.id === bot.choice.model : m.isDefault,
    ) ?? null;
  const shown = models.filter((m) =>
    m.displayName.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  function close(refocus: boolean) {
    setOpen(false);
    setQuery("");
    if (refocus) trigger.current?.focus();
  }
  useEffect(() => {
    if (open && engine.state !== "ready")
      void fetch("/api/catalog").catch(() => {});
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
  function configure(
    model: CatalogModel | null,
    effort: string | null,
    speed: string,
    done?: () => void,
  ) {
    void action.perform(
      {
        type: "bot.configure",
        requestId: uid(),
        botId: bot.id,
        model: model?.id ?? null,
        effort,
        speed,
      },
      done,
    );
  }
  function choose(model: CatalogModel) {
    if (model.id === current?.id && bot.choice.model !== null) close(true);
    else configure(model, null, "standard", () => close(true));
  }
  const label =
    engine.state === "starting"
      ? "Chargement des modèles…"
      : engine.state === "unavailable"
        ? "Modèles indisponibles"
        : (current?.displayName ?? bot.choice.model ?? "Modèle par défaut");
  return (
    <div className="model-picker">
      <button
        ref={trigger}
        type="button"
        className="model-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Modèle de ${bot.name} : ${label}`}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <Cpu size={14} aria-hidden="true" />
        <span>{action.busy ? "Enregistrement…" : label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label={`Modèle de ${bot.name}`}
          className="model-panel"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close(true);
            }
          }}
        >
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
                placeholder="Chercher un modèle…"
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
                    if (shown[active]) choose(shown[active]);
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
                    onClick={() => choose(m)}
                  >
                    <span>{m.displayName}</span>
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
              {current && (
                <div className="model-tuning">
                  <Choices
                    legend="Réflexion"
                    value={bot.choice.effort ?? ""}
                    options={[
                      [
                        "",
                        `Par défaut (${effortNames[current.defaultEffort] ?? current.defaultEffort})`,
                      ],
                      ...current.efforts.map(
                        (e) => [e, effortNames[e] ?? e] as const,
                      ),
                    ]}
                    onChange={(effort) =>
                      configure(current, effort || null, bot.choice.speed)
                    }
                  />
                  {current.speeds.some((s) => s.id !== "standard") && (
                    <Choices
                      legend="Vitesse"
                      value={bot.choice.speed}
                      options={[
                        ["standard", "Standard"],
                        ...current.speeds
                          .filter((s) => s.id !== "standard")
                          .map((s) => [s.id, s.name] as const),
                      ]}
                      onChange={(speed) =>
                        configure(current, bot.choice.effort, speed)
                      }
                    />
                  )}
                </div>
              )}
            </>
          )}
          {action.feedback}
        </div>
      )}
    </div>
  );
}

function Choices({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  const name = useId();
  return (
    <fieldset className="model-choices">
      <legend>{legend}</legend>
      <div>
        {options.map(([id, text]) => (
          <label key={id}>
            <input
              type="radio"
              name={name}
              value={id}
              checked={value === id}
              onChange={() => onChange(id)}
            />
            {text}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
