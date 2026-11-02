/**
 * DSH can expose the same DeepSeek models through a gateway provider and its
 * official provider. When the official provider is routable, drop DeepSeek
 * models from every other group so the picker shows one DeepSeek entry.
 * @param {Array<{ id: string, models: Array<{ id: string }> }>} groups
 */
export const preferOfficialDeepSeek = (groups) => {
  const official = groups.find((group) => group.id === 'deepseek-official' && group.models.length > 0);
  if (!official) return groups;
  return groups.flatMap((group) => {
    if (group.id === 'deepseek-official') return [group];
    const models = group.models.filter((model) => !model.id.startsWith('deepseek/'));
    return models.length > 0 ? [{ ...group, models }] : [];
  });
};
