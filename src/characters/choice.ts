import {
  STANDARD_SPEED,
  type BotChoice,
  type CatalogModel,
} from "../../server/src/protocol";

/** The catalogue entry a choice runs on: the named model, or the default one when the choice names none. */
export function chosenModel(
  models: readonly CatalogModel[],
  id: BotChoice["model"],
): CatalogModel | null {
  return models.find((m) => (id === null ? m.isDefault : m.id === id)) ?? null;
}

/** Moves a choice to another model. A level or a speed that model does not announce goes back to its default. */
export function withModel(
  choice: BotChoice,
  id: BotChoice["model"],
  model: CatalogModel | null,
): BotChoice {
  return {
    model: id,
    effort:
      choice.effort !== null && model?.efforts.includes(choice.effort)
        ? choice.effort
        : null,
    speed: model?.speeds.some((s) => s.id === choice.speed)
      ? choice.speed
      : STANDARD_SPEED,
  };
}

export function matchesModel(model: CatalogModel, query: string): boolean {
  const wanted = query.trim().toLocaleLowerCase();
  return [model.id, model.displayName].some((text) =>
    text.toLocaleLowerCase().includes(wanted),
  );
}
