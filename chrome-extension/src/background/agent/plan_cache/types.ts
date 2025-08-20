// Plan cache MVP types
export interface CachedAction {
  type: string;
  selector?: string;
  text?: string;
  url?: string;
  keys?: string;
  index?: number;
  rawParams?: Record<string, unknown>; // original primitive params for richer replay
}

export interface CachedPlanStep {
  index: number;
  plannerOutput?: string; // raw planner model segment for phase if first step of phase
  navigatorOutput?: string; // raw navigator model output for this step
  actions: CachedAction[];
}

export interface CachedPlan {
  cachedAt: number;
  sourceSessionId: string;
  task: string;
  sessionStatus?: string; // completed | failed | cancelled
  durationMs?: number; // original session execution time
  steps: CachedPlanStep[];
}
