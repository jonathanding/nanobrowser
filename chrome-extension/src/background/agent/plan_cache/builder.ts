import type { CachedPlan, CachedPlanStep, CachedAction } from './types';
import type { StructuredSession } from '../session/types';

export class PlanCacheBuilder {
  static build(session: StructuredSession): CachedPlan {
    const steps: CachedPlanStep[] = [];
    let index = 0;
    for (const phase of session.planningPhases) {
      for (let sIdx = 0; sIdx < phase.navigationSteps.length; sIdx++) {
        const nav = phase.navigationSteps[sIdx];
        let actions: CachedAction[] = nav.actions
          .filter(a => a.type !== 'error')
          .map(a => {
            const maybeRaw = a as unknown as { rawName?: string };
            // Flatten simple numeric index if present in parameters
            const idx = typeof a.parameters.index === 'number' ? a.parameters.index : undefined;
            return {
              type: maybeRaw.rawName || a.type || 'unknown',
              selector: typeof a.parameters.selector === 'string' ? a.parameters.selector : undefined,
              text: typeof a.parameters.text === 'string' ? a.parameters.text : undefined,
              url: typeof a.parameters.url === 'string' ? a.parameters.url : undefined,
              keys: typeof a.parameters.keys === 'string' ? a.parameters.keys : undefined,
              index: idx,
              rawParams: a.parameters,
            };
          });

        // If we failed to capture concrete action types (all unknown) attempt to derive from navigator model output JSON
        const allUnknown = actions.length === 0 || actions.every(a => a.type === 'unknown');
        if (allUnknown && nav.output.navigatorModelOutput) {
          try {
            const parsed = JSON.parse(nav.output.navigatorModelOutput);
            const modelActions = Array.isArray(parsed.action) ? parsed.action : [];
            const derived: CachedAction[] = [];
            for (const entry of modelActions) {
              if (entry && typeof entry === 'object') {
                const keys = Object.keys(entry);
                if (keys.length === 1) {
                  const name = keys[0];
                  const params = (entry as Record<string, unknown>)[name];
                  if (params && typeof params === 'object') {
                    const p = params as Record<string, unknown>;
                    derived.push({
                      type: name,
                      selector: typeof p.selector === 'string' ? p.selector : undefined,
                      text: typeof p.text === 'string' ? p.text : undefined,
                      url: typeof p.url === 'string' ? p.url : undefined,
                      keys: typeof p.keys === 'string' ? p.keys : undefined,
                      index: typeof p.index === 'number' ? (p.index as number) : undefined,
                      rawParams: p,
                    });
                  }
                }
              }
            }
            if (derived.length) {
              actions = derived;
            }
          } catch {
            // swallow JSON parse errors
          }
        }
        if (actions.length || nav.output.navigatorModelOutput) {
          const stepEntry: CachedPlanStep = {
            index,
            actions,
            navigatorOutput: nav.output.navigatorModelOutput,
          };
          // Attach planner output to the first navigation step of each phase
          if (sIdx === 0 && (phase.plannerModelOutput || phase.plan)) {
            stepEntry.plannerOutput = phase.plannerModelOutput || (phase.plan ? JSON.stringify(phase.plan) : undefined);
          }
          steps.push(stepEntry);
          index++;
        }
      }
    }
    return {
      cachedAt: Date.now(),
      sourceSessionId: session.sessionId,
      task: session.task,
      sessionStatus: session.status,
      durationMs: session.summary.executionTime,
      steps,
    };
  }
}
