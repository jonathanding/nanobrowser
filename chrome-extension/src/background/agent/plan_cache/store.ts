import type { CachedPlan } from './types';

const STORAGE_KEY = 'plan_cache_single';

export class PlanCacheStore {
  static async load(): Promise<CachedPlan | null> {
    const res = await chrome.storage.local.get([STORAGE_KEY]);
    return (res[STORAGE_KEY] as CachedPlan) || null;
  }

  static async save(plan: CachedPlan): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: plan });
  }

  static async clear(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEY);
  }
}
