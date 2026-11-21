import { NativeAgentError } from '../errors.js';

export type AgyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgyModelAlias {
  id: string;
  variant: AgyEffort;
}

export interface AgyCatalogModel {
  id: string;
  name: string;
  contextWindow: null;
  outputLimit: null;
  efforts: AgyEffort[];
  defaultEffort: null;
  fast: boolean;
  input: { image: boolean; pdf: boolean };
  aliases: AgyModelAlias[];
}

const EFFORTS: readonly AgyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const isEffort = (value: string | undefined): value is AgyEffort => EFFORTS.some((effort) => effort === value);

const invalidCatalog = () => new NativeAgentError('Invalid `agy models` output', {
  code: 'NATIVE_ANTIGRAVITY_CATALOG',
  status: 502,
});

export const parseAntigravityModels = (output: string): AgyCatalogModel[] => {
  const models = new Map<string, AgyCatalogModel>();
  const seen = new Set<string>();
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const [slug, label, ...extra] = line.split('\t');
    if (!slug || !label || extra.length > 0 || seen.has(slug)) throw invalidCatalog();
    seen.add(slug);

    const suffix = /^(.+)-(low|medium|high|xhigh|max)$/.exec(slug);
    const labelSuffix = / \((low|medium|high|xhigh|max)\)$/i.exec(label);
    const suffixBase = suffix?.[1];
    const suffixEffort = suffix?.[2];
    const effort: AgyEffort | null = suffixBase && isEffort(suffixEffort) && labelSuffix?.[1]?.toLowerCase() === suffixEffort
      ? suffixEffort
      : null;
    const id = effort && suffixBase ? suffixBase : slug;
    const name = effort && labelSuffix ? label.slice(0, -labelSuffix[0].length) : label;
    let model = models.get(id);
    if (!model) {
      model = {
        id,
        name,
        contextWindow: null,
        outputLimit: null,
        efforts: [],
        defaultEffort: null,
        fast: false,
        input: { image: false, pdf: false },
        aliases: [],
      };
      models.set(id, model);
    }
    if (model.name !== name) throw invalidCatalog();
    if (effort) {
      model.efforts.push(effort);
      model.aliases.push({ id: slug, variant: effort });
    }
  }
  for (const model of models.values()) {
    model.efforts = model.efforts.length > 1
      ? EFFORTS.filter((effort) => model.efforts.includes(effort))
      : [];
  }
  return [...models.values()];
};
