import { createLogger } from '@src/background/log';
import type BrowserContext from '../../browser/context';
import type { CachedPlan, CachedPlanStep, CachedAction } from './types';
import { ActionBuilder, type Action } from '../actions/builder';
import { NavigatorActionRegistry } from '../agents/navigator';
import { AgentContext, DEFAULT_AGENT_OPTIONS } from '../types';
import MessageManager from '../messages/service';
import { EventManager } from '../event/manager';
import { Actors, ExecutionState } from '../event/types';

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

export interface ReplayOptions {
  delayMs?: number;
}

export class ReplayCacheNavigator {
  private context: AgentContext;
  private registry: NavigatorActionRegistry;

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
    // extractorLLM not needed for replay; cast null to never to satisfy param
    const actionBuilder = new ActionBuilder(this.context, null as unknown as never);
    this.registry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions() as Action[]);
  }

  async replay(plan: CachedPlan): Promise<boolean> {
    logger.info(`Replaying plan ${plan.sourceSessionId} with ${plan.steps.length} steps`);
    for (const step of plan.steps) {
      const ok = await this.executeStep(step);
      if (!ok) return false;
    }
    return true;
  }

  private async executeStep(step: CachedPlanStep): Promise<boolean> {
    this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_START, `Replay step ${step.index}`);
    for (const action of step.actions) {
      const ok = await this.executeAction(action);
      if (!ok) {
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_FAIL, `Replay failed action ${action.type}`);
        return false;
      }
    }
    this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_OK, `Replay step ${step.index} done`);
    return true;
  }

  private async executeAction(action: CachedAction): Promise<boolean> {
    const mapped = ACTION_NAME_MAP[action.type] || action.type;
    const actionInstance = (this.registry as unknown as { getAction(name: string): Action | undefined }).getAction(
      mapped,
    );
    if (!actionInstance) {
      logger.warning('Unknown cached action, skip', action.type);
      return true; // skip unknown
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
      if (result?.error) return false;
      if (this.options.delayMs) await new Promise(r => setTimeout(r, this.options.delayMs));
      return true;
    } catch (e) {
      logger.error('Replay action error', action.type, e);
      return false;
    }
  }
}
