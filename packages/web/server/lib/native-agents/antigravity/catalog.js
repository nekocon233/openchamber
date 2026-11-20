import { NativeAgentError } from '../errors.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const invalidCatalog = () => new NativeAgentError('Invalid `agy models` output', {
  code: 'NATIVE_ANTIGRAVITY_CATALOG', status: 502,
});

/** The CLI lists concrete effort slugs; the picker lists their model families. */
export const parseAntigravityModels = (output) => {
  const models = new Map();
  const seen = new Set();
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const [slug, label, ...extra] = line.split('\t');
    if (!slug || !label || extra.length > 0 || seen.has(slug)) throw invalidCatalog();
    seen.add(slug);

    const suffix = /^(.+)-(low|medium|high|xhigh|max)$/.exec(slug);
    const labelSuffix = / \((low|medium|high|xhigh|max)\)$/i.exec(label);
    const effort = suffix && labelSuffix?.[1].toLowerCase() === suffix[2] ? suffix[2] : null;
    const id = effort ? suffix[1] : slug;
    const name = effort ? label.slice(0, -labelSuffix[0].length) : label;
    let model = models.get(id);
    if (!model) {
      model = {
        id, name, contextWindow: null, outputLimit: null,
        efforts: [], defaultEffort: null, fast: false,
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
