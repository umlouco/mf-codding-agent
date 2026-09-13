import type { ModelList } from './models';

// Official release, 2026-09-10: https://deepseek.com/en/news/deepseek-v4-1-flash/
const flash = { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', vision: true, embedding: false };

/** Supplement hosted discovery without changing cached API data or saved role selections. */
export function withDeepSeekModels(providerId: string, base: string, list?: ModelList): ModelList | undefined {
  if (providerId !== 'deepseek' || !/^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/i.test(base)) return list;
  const current = list ?? { models: [], fetchedAt: 0, fallback: true };
  const advertised = current.models.find(model => model.id === flash.id);
  return {
    ...current,
    models: [
      { ...advertised, ...flash, description: advertised?.description ??
        (advertised ? undefined : 'Official V4.1 Flash model; not returned by the current cached/API listing.') },
      ...current.models.filter(model => model.id !== flash.id),
    ],
  };
}
