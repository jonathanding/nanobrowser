import type { CachedPlan } from './types';

const SINGLE_KEY = 'plan_cache_single';
const MULTI_KEY = 'plan_cache_list';
const MAX_PLANS = 10;

export class PlanCacheStore {
  // Load latest (for backward compatibility)
  static async loadLatest(): Promise<CachedPlan | null> {
    const res = await chrome.storage.local.get([MULTI_KEY, SINGLE_KEY]);
    const list: CachedPlan[] = res[MULTI_KEY] || [];
    if (list.length > 0) return list[0];
    if (res[SINGLE_KEY]) return res[SINGLE_KEY] as CachedPlan;
    return null;
  }

  static async loadAll(): Promise<CachedPlan[]> {
    const res = await chrome.storage.local.get([MULTI_KEY, SINGLE_KEY]);
    let list: CachedPlan[] = res[MULTI_KEY] || [];
    // Migration: if single exists and list empty, migrate
    if ((!list || list.length === 0) && res[SINGLE_KEY]) {
      const single = res[SINGLE_KEY] as CachedPlan;
      list = [single];
      await chrome.storage.local.set({ [MULTI_KEY]: list });
    }
    return list;
  }

  static async save(plan: CachedPlan): Promise<void> {
    const list = await this.loadAll();
    // Insert at front
    const newList = [plan, ...list.filter(p => p.planId !== plan.planId)];
    // Limit size
    if (newList.length > MAX_PLANS) newList.length = MAX_PLANS;
    await chrome.storage.local.set({ [MULTI_KEY]: newList });
    // Keep single key pointing to latest for old UI until fully removed
    await chrome.storage.local.set({ [SINGLE_KEY]: plan });
  }

  static async clearAll(): Promise<void> {
    await chrome.storage.local.remove([MULTI_KEY, SINGLE_KEY]);
  }

  static async remove(planId: string): Promise<void> {
    const list = await this.loadAll();
    const newList = list.filter(p => p.planId !== planId);
    await chrome.storage.local.set({ [MULTI_KEY]: newList });
    if (newList.length > 0) {
      await chrome.storage.local.set({ [SINGLE_KEY]: newList[0] });
    } else {
      await chrome.storage.local.remove(SINGLE_KEY);
    }
  }
}
