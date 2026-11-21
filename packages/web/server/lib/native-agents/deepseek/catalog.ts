export interface DeepseekCatalogGroup<Model extends { id: string } = { id: string }> {
  id: string;
  models: Model[];
}

export const preferOfficialDeepSeek = <
  Model extends { id: string },
  Group extends DeepseekCatalogGroup<Model>,
>(groups: Group[]): Group[] => {
  const official = groups.find((group) => group.id === 'deepseek-official' && group.models.length > 0);
  if (!official) return groups;
  return groups.flatMap((group) => {
    if (group.id === 'deepseek-official') return [group];
    const models = group.models.filter((model) => !model.id.startsWith('deepseek/'));
    return models.length > 0 ? [{ ...group, models }] : [];
  });
};
