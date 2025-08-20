// Plan cache MVP types
export interface CachedAction {
  type: string;
  selector?: string;
  text?: string;
  url?: string;
  keys?: string;
  index?: number;
  rawParams?: Record<string, unknown>; // original primitive params for richer replay
  success?: boolean;
  error?: string;
}

export interface CachedPlanStep {
  index: number;
  plannerOutput?: string; // raw planner model segment for phase if first step of phase
  navigatorOutput?: string; // raw navigator model output for this step
  actions: CachedAction[];
}

export interface CachedPlan {
  planId?: string; // unique identifier (defaults to sessionId)
  cachedAt: number;
  sourceSessionId: string;
  task: string;
  sessionStatus?: string; // completed | failed | cancelled
  durationMs?: number; // original session execution time
  steps: CachedPlanStep[];
}
