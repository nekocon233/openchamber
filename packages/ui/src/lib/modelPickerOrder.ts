export const modelPickerModelKey = (model: { providerID: string; modelID: string }): string => `model:${JSON.stringify([model.providerID, model.modelID])}`;
export const modelPickerActionKey = (id: string): string => `action:${id}`;

/** Retain the existing order for items that have no saved position yet. */
export const orderPickerItems = <T,>(items: readonly T[], order: readonly string[], keyOf: (item: T) => string): T[] => {
  const positions = new Map(order.map((key, index) => [key, index]));
  return [...items].sort((left, right) => (positions.get(keyOf(left)) ?? order.length) - (positions.get(keyOf(right)) ?? order.length));
};
