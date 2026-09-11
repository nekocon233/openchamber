import { wrapModels } from './hooks.js';
import { z } from 'zod';

const optionsSchema = z.object({
  providerID: z.string().min(1).max(256).regex(/^[a-z0-9][a-z0-9._-]*$/i),
});

export const LoggedInProviderExecution = async (_input, options) => {
  const { providerID } = optionsSchema.parse(options);
  return {
    provider: {
      id: providerID,
      models: async (provider) => wrapModels(provider),
    },
  };
};
