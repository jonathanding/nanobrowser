import { createLogger } from '@src/background/log';
import type BrowserContext from '../../browser/context';
import type { CachedPlan, CachedPlanStep, CachedAction } from './types';
import { ActionBuilder, type Action } from '../actions/builder';
import { NavigatorActionRegistry } from '../agents/navigator';
import { AgentNameEnum, llmProviderStore, agentModelStore } from '@extension/storage';
import { replayNavigatorSystemPromptTemplate } from '../prompts/templates/replay_navigator';
import { createChatModel } from '../helper';
import { AgentContext, DEFAULT_AGENT_OPTIONS } from '../types';
import MessageManager from '../messages/service';
import { EventManager } from '../event/manager';
import { Actors, ExecutionState, EventType, type AgentEvent } from '../event/types';

const logger = createLogger('ReplayCacheNavigator');

const ACTION_NAME_MAP: Record<string, string> = {
  go_to_url: 'go_to_url',
  open_tab: 'open_tab',
  click_element: 'click_element',
  input_text: 'input_text',
  send_keys: 'send_keys',
  switch_tab: 'switch_tab',
  close_tab: 'close_tab',
  scroll_to_percent: 'scroll_to_percent',
  scroll_to_text: 'scroll_to_text',
  scroll_to_top: 'scroll_to_top',
  scroll_to_bottom: 'scroll_to_bottom',
  previous_page: 'previous_page',
  next_page: 'next_page',
  done: 'done',
};

// Minimal chat model interface we rely on for replay replanning
interface ChatMessage {
  role: string;
  content: string;
}

interface ChatInvokeResult {
  content: unknown;
  [k: string]: unknown;
}

interface ChatModelLike {
  invoke(messages: ChatMessage[]): Promise<ChatInvokeResult>;
}

interface ReplanActionEntry {
  // single key whose name is action type mapping to params
  [actionType: string]: Record<string, unknown>;
}

interface ReplanJSON {
  action: ReplanActionEntry[];
  rationale?: string;
}

function isReplanJSON(value: unknown): value is ReplanJSON {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.action)) return false;
  return v.action.every(entry => {
    if (!entry || typeof entry !== 'object') return false;
    const keys = Object.keys(entry);
    if (keys.length !== 1) return false;
    const params = (entry as Record<string, unknown>)[keys[0]];
    return !!params && typeof params === 'object';
  });
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function getNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' ? v : undefined;
}

export interface ReplayOptions {
  delayMs?: number;
  enableLocalReplan?: boolean; // when true, on first action failure attempt LLM guided single-step replan
  verbose?: boolean; // emit extra console.log for debugging
}

export interface ReplayProgressEvent {
  kind: 'step';
  stepIndex: number;
  status: 'running' | 'success' | 'failed';
  error?: string;
  failingActionType?: string;
}

export class ReplayCacheNavigator {
  private context: AgentContext;
  private registry: NavigatorActionRegistry;
  private replayLLMReady = false;
  private maxActionsPerRecovery = 3;

  constructor(
    private browserContext: BrowserContext,
    private options: ReplayOptions = {},
  ) {
    const messageManager = new MessageManager();
    const eventManager = new EventManager();
    this.context = new AgentContext(`replay_${Date.now()}`, browserContext, messageManager, eventManager, {
      ...DEFAULT_AGENT_OPTIONS,
      maxSteps: 1,
    });
    // Subscribe to events to forward replan debug info externally if needed
    eventManager.subscribe(EventType.EXECUTION, async evt => {
      if (typeof evt.data?.details === 'string' && evt.data.details.includes('replay_local_replan')) {
        if (this.options.verbose) {
          // eslint-disable-next-line no-console
          console.log('[Replay] event', evt.data.details);
        }
        // Attempt to also broadcast via window (side panel may poll?) - fallback log only
        try {
          // service worker might not have window
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const anyGlobal: any = globalThis as any;
          if (anyGlobal && typeof anyGlobal.postMessage === 'function') {
            anyGlobal.postMessage({ type: 'agent_event', event: evt });
          }
        } catch (broadcastErr) {
          if (this.options.verbose) {
            // eslint-disable-next-line no-console
            console.log('[Replay] broadcast error', broadcastErr);
          }
        }
      }
    });
    // extractorLLM not needed for replay; cast null to never to satisfy param
    const actionBuilder = new ActionBuilder(this.context, null as unknown as never);
    this.registry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions() as Action[]);
  }

  async replay(plan: CachedPlan, onProgress?: (ev: ReplayProgressEvent) => void): Promise<boolean> {
    logger.info(`Replaying plan ${plan.sourceSessionId} with ${plan.steps.length} steps`);
    if (this.options.verbose) {
      // eslint-disable-next-line no-console
      console.log('[Replay] start', { planId: plan.planId, steps: plan.steps.length });
    }
    for (const step of plan.steps) {
      // Ensure emitted events carry correct step index for UI correlation
      (this.context as unknown as { nSteps: number }).nSteps = step.index;
      onProgress?.({ kind: 'step', stepIndex: step.index, status: 'running' });
      const result = await this.executeStep(step);
      if (!result.ok) {
        if (this.options.verbose) {
          // eslint-disable-next-line no-console
          console.log('[Replay] step failure', {
            step: step.index,
            failingAction: result.failingActionType,
            error: result.error,
          });
        }
        // Attempt local re-plan if enabled
        if (this.options.enableLocalReplan) {
          try {
            const recovered = await this.tryLocalReplan(
              plan.task,
              step,
              result.failingActionType || 'unknown',
              result.error,
            );
            if (recovered) {
              if (this.options.verbose) {
                // eslint-disable-next-line no-console
                console.log('[Replay] recovery succeeded', { step: step.index });
              }
              onProgress?.({ kind: 'step', stepIndex: step.index, status: 'success' });
              continue; // proceed to next step
            }
          } catch (e) {
            logger.error('Local replan errored', e);
            if (this.options.verbose) {
              // eslint-disable-next-line no-console
              console.log('[Replay] recovery exception', { step: step.index, error: e });
            }
          }
        }
        onProgress?.({
          kind: 'step',
          stepIndex: step.index,
          status: 'failed',
          error: result.error,
          failingActionType: result.failingActionType,
        });
        return false;
      }
      onProgress?.({ kind: 'step', stepIndex: step.index, status: 'success' });
    }
    if (this.options.verbose) {
      // eslint-disable-next-line no-console
      console.log('[Replay] finished all steps');
    }
    return true;
  }

  private async executeStep(
    step: CachedPlanStep,
  ): Promise<{ ok: boolean; error?: string; failingActionType?: string }> {
    this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_START, `Replay step ${step.index}`);
    for (const action of step.actions) {
      const result = await this.executeAction(action);
      if (!result.ok) {
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, `Replay failed action ${action.type}`);
        return { ok: false, error: result.error, failingActionType: action.type };
      }
    }
    this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OK, `Replay step ${step.index} done`);
    return { ok: true };
  }

  private async executeAction(action: CachedAction): Promise<{ ok: boolean; error?: string }> {
    const mapped = ACTION_NAME_MAP[action.type] || action.type;
    const actionInstance = (this.registry as unknown as { getAction(name: string): Action | undefined }).getAction(
      mapped,
    );
    if (!actionInstance) {
      logger.warning('Unknown cached action, skip', action.type);
      return { ok: true }; // skip unknown
    }
    let input: Record<string, unknown> = action.rawParams ? { ...action.rawParams } : {};
    if (Object.keys(input).length === 0) {
      if (mapped === 'go_to_url' && action.url) input = { url: action.url };
      if (mapped === 'click_element' && typeof action.index === 'number') input = { index: action.index };
      if (mapped === 'input_text' && typeof action.index === 'number')
        input = { index: action.index, text: action.text || '' };
      if (mapped === 'send_keys' && action.keys) input = { keys: action.keys };
    }
    try {
      const result = await actionInstance.call(input);
      if (result?.error) return { ok: false, error: String(result.error) };
      if (this.options.delayMs) await new Promise(r => setTimeout(r, this.options.delayMs));
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Action threw error';
      // Suppress loud error when we intend to replan; downgrade severity
      if (this.options.enableLocalReplan) {
        logger.info('Replay action failed (will attempt local replan)', action.type, msg);
      } else {
        logger.error('Replay action error', action.type, e);
      }
      if (this.options.verbose) {
        // direct console log for quick debugging
        // eslint-disable-next-line no-console
        console.log('[Replay] action failure', { action: action.type, params: action.rawParams, error: msg });
      }
      return { ok: false, error: msg };
    }
  }

  private async ensureReplayLLM() {
    if (this.replayLLMReady) return;
    try {
      const agentModels = await agentModelStore.getAllAgentModels();
      const providers = await llmProviderStore.getAllProviders();
      const replayModel = agentModels[AgentNameEnum.ReplayNavigator];
      if (!replayModel) {
        logger.info('No ReplayNavigator model configured; skipping local replan');
        if (this.options.verbose) {
          // eslint-disable-next-line no-console
          console.log('[ReplayReplan] skip: no ReplayNavigator model configured');
        }
        // Emit skip event so UI can show reason
        this.context.emitEvent(
          Actors.NAVIGATOR,
          ExecutionState.STEP_START,
          JSON.stringify({
            kind: 'replay_local_replan_skipped',
            reason: 'no_model_configured',
          }),
        );
        this.replayLLMReady = true; // mark checked
        return;
      }
      const providerConfig = providers[replayModel.provider];
      if (!providerConfig) {
        logger.warning('ReplayNavigator provider missing; skipping local replan');
        this.context.emitEvent(
          Actors.NAVIGATOR,
          ExecutionState.STEP_START,
          JSON.stringify({
            kind: 'replay_local_replan_skipped',
            reason: 'provider_missing',
          }),
        );
        this.replayLLMReady = true;
        return;
      }
      // Create a lightweight chat model instance and attach to context (reuse navigator style call path)
      (this as unknown as { replayLLM?: ReturnType<typeof createChatModel> }).replayLLM = createChatModel(
        providerConfig,
        replayModel,
      );
      this.replayLLMReady = true;
    } catch (e) {
      logger.error('Failed initializing replay LLM', e);
      this.context.emitEvent(
        Actors.NAVIGATOR,
        ExecutionState.STEP_START,
        JSON.stringify({
          kind: 'replay_local_replan_skipped',
          reason: 'init_error',
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      this.replayLLMReady = true; // avoid repeated attempts
    }
  }

  private async tryLocalReplan(
    task: string,
    step: CachedPlanStep,
    failingAction: string,
    error?: string,
  ): Promise<boolean> {
    await this.ensureReplayLLM();
    const replayLLM = (this as unknown as { replayLLM?: ChatModelLike }).replayLLM;
    if (!replayLLM) {
      // ensureReplayLLM already emitted skip reason; reinforce if needed
      if (this.options.verbose) {
        // eslint-disable-next-line no-console
        console.log('[ReplayReplan] abort: replayLLM unavailable');
      }
      this.context.emitEvent(
        Actors.NAVIGATOR,
        ExecutionState.STEP_START,
        JSON.stringify({
          kind: 'replay_local_replan_skipped',
          reason: 'llm_unavailable_after_init',
        }),
      );
      return false;
    }
    if (this.options.verbose) {
      // eslint-disable-next-line no-console
      console.log('[ReplayReplan] Trigger replan start', { step: step.index, failingAction, error });
    }
    // Gather current browser state (lightweight cached) similar to NavigatorAgent state message
    const browserState = await this.browserContext.getCachedState(false, true);
    // Provide reduced interactive elements list (selectors + texts) to save tokens
    let interactiveElements = '';
    try {
      const selectorEntries: string[] = [];
      // selectorMap may be large; cap at first 40 entries
      const maxSelectors = 40;
      let count = 0;
      const selectorMap = (
        browserState as unknown as { selectorMap?: Map<number, { tagName?: string; text?: string }> }
      ).selectorMap;
      if (selectorMap) {
        for (const [idx, domEl] of selectorMap.entries()) {
          if (count >= maxSelectors) break;
          const textVal = typeof domEl.text === 'string' ? domEl.text.slice(0, 60) : '';
          const tagLower = domEl.tagName ? domEl.tagName.toLowerCase() : 'el';
          selectorEntries.push(`${idx}: <${tagLower}> ${textVal}`.trim());
          count++;
        }
      }
      interactiveElements = selectorEntries.join('\n');
    } catch (e) {
      interactiveElements = 'unavailable';
    }

    // Available actions (names + prompt schema) similar to action.prompt()
    const actionPrompts = this.registry
      .listActions()
      .map(a => a.prompt())
      .join('\n');

    const taskSafe = task || 'Unknown task';
    const plannerNext = step.plannerOutput || '';
    const prompt = replayNavigatorSystemPromptTemplate.replace('{{max_actions}}', String(this.maxActionsPerRecovery));
    const userContent = `
<task>${taskSafe}</task>
<planner_next_steps>${plannerNext}</planner_next_steps>
<failing_action>${failingAction}</failing_action>
<error_message>${error || ''}</error_message>
<available_actions>\n${actionPrompts}\n</available_actions>
<interactive_elements>\n${interactiveElements}\n</interactive_elements>
<current_url>${browserState.url}</current_url>
<tabs>${browserState.tabs.map(t => `${t.id}:${t.title}`).join(' | ')}</tabs>
`;
    let response: ChatInvokeResult | undefined;
    try {
      const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: userContent },
      ];
      response = await replayLLM.invoke(messages);
      // Emit debug info event for UI (prompt + raw model output)
      this.context.emitEvent(
        Actors.NAVIGATOR,
        ExecutionState.STEP_START,
        JSON.stringify({ kind: 'replay_local_replan', request: { system: prompt, user: userContent }, raw: response }),
      );
      const text = typeof response?.content === 'string' ? response.content : JSON.stringify(response?.content);
      let parsed: ReplanJSON | undefined;
      try {
        const candidate = JSON.parse(text);
        if (isReplanJSON(candidate)) parsed = candidate;
      } catch (e) {
        // swallow JSON.parse error; will fall through
      }
      if (!parsed) {
        logger.warning('Replay LLM output not valid ReplanJSON');
        this.context.emitEvent(
          Actors.NAVIGATOR,
          ExecutionState.STEP_START,
          JSON.stringify({ kind: 'replay_local_replan_parse_fail', text }),
        );
        if (this.options.verbose) {
          // eslint-disable-next-line no-console
          console.log('[ReplayReplan] Parse failed', { step: step.index, text: text?.slice(0, 400) });
        }
        return false;
      }
      for (const actionEntry of parsed.action.slice(0, this.maxActionsPerRecovery)) {
        const [name, params] = Object.entries(actionEntry)[0] ?? [];
        if (!name || !params || typeof params !== 'object') continue;
        const ca: CachedAction = {
          type: name,
          rawParams: params as Record<string, unknown>,
          selector: getString(params as Record<string, unknown>, 'selector'),
          url: getString(params as Record<string, unknown>, 'url'),
          text: getString(params as Record<string, unknown>, 'text'),
          keys: getString(params as Record<string, unknown>, 'keys'),
          index: getNumber(params as Record<string, unknown>, 'index'),
        };
        if (this.options.verbose) {
          // eslint-disable-next-line no-console
          console.log('[ReplayReplan] Executing recovery action', { name, params });
        }
        const exec = await this.executeAction(ca);
        if (!exec.ok) return false;
        if (name === 'done') return true;
      }
      return true;
    } catch (e) {
      logger.error('Local replan invoke failed', e);
      this.context.emitEvent(
        Actors.NAVIGATOR,
        ExecutionState.STEP_START,
        JSON.stringify({ kind: 'replay_local_replan_error', error: e instanceof Error ? e.message : String(e) }),
      );
      if (this.options.verbose) {
        // eslint-disable-next-line no-console
        console.log('[ReplayReplan] Replan error', { step: step.index, failingAction, error: e });
      }
      return false;
    }
  }

  /** Allow external subscribers (background script) to forward replay events to UI */
  onEvent(callback: (event: AgentEvent) => void) {
    this.context.eventManager.subscribe(EventType.EXECUTION, async evt => {
      try {
        callback(evt);
      } catch (err) {
        if (this.options.verbose) {
          // eslint-disable-next-line no-console
          console.log('[Replay] onEvent callback error', err);
        }
      }
    });
  }
}
