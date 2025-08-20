import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type ActionResult, AgentContext, type AgentOptions } from './types';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { ValidatorAgent } from './agents/validator';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import { ValidatorPrompt } from './prompts/validator';
import { createLogger } from '@src/background/log';
import MessageManager from './messages/service';
import type BrowserContext from '../browser/context';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import {
  ChatModelAuthError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
} from './agents/errors';
import { wrapUntrustedContent } from './messages/utils';
import { URLNotAllowedError } from '../browser/views';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import type { AgentStepHistory } from './history';
import type { GeneralSettingsConfig } from '@extension/storage';
import { StructuredSessionCollector } from './session/collector';
import type { StructuredSession } from './session/types';

const logger = createLogger('Executor');

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  validatorLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly validator: ValidatorAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly validatorPrompt: ValidatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private readonly sessionCollector: StructuredSessionCollector;
  private tasks: string[] = [];
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: BaseChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    const messageManager = new MessageManager();

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const validatorLLM = extraArgs?.validatorLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
    );

    this.generalSettings = extraArgs?.generalSettings;
    this.tasks.push(task);
    this.navigatorPrompt = new NavigatorPrompt(context.options.maxActionsPerStep);
    this.plannerPrompt = new PlannerPrompt();
    this.validatorPrompt = new ValidatorPrompt(task);

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
    });

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
    });

    this.validator = new ValidatorAgent({
      chatLLM: validatorLLM,
      context: context,
      prompt: this.validatorPrompt,
    });

    this.context = context;
    // Initialize structured session collector
    this.sessionCollector = new StructuredSessionCollector(taskId, task, context);
    // Initialize message history
    this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string): void {
    this.tasks.push(task);
    this.context.messageManager.addNewTask(task);
    // update validator prompt
    this.validatorPrompt.addFollowUpTask(task);

    // Record follow-up task in session
    this.sessionCollector.addFollowUpTask(task);

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }

  /**
   * Execute the task
   *
   * @returns {Promise<void>}
   */
  async execute(): Promise<void> {
    logger.info(`🚀 Executing task: ${this.tasks[this.tasks.length - 1]}`);
    // reset the step counter
    const context = this.context;
    context.nSteps = 0;
    const allowedMaxSteps = this.context.options.maxSteps;

    let sessionStatus: 'completed' | 'failed' | 'cancelled' = 'failed';

    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      let done = false;
      let step = 0;
      let validatorFailed = false;
      let webTask = undefined;
      for (step = 0; step < allowedMaxSteps; step++) {
        context.stepInfo = {
          stepNumber: context.nSteps,
          maxSteps: context.options.maxSteps,
        };

        logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);
        if (await this.shouldStop()) {
          break;
        }

        // Run planner if configured
        if (this.planner && (context.nSteps % context.options.planningInterval === 0 || validatorFailed)) {
          const trigger = step === 0 ? 'initial' : validatorFailed ? 'validator_failed' : 'periodic';

          // Start planning phase
          this.sessionCollector.startPlanningPhase(trigger, context);

          validatorFailed = false;
          // The first planning step is special, we don't want to add the browser state message to memory
          let positionForPlan = 0;
          if (this.tasks.length > 1 || step > 0) {
            await this.navigator.addStateMessageToMemory();
            positionForPlan = this.context.messageManager.length() - 1;
          } else {
            positionForPlan = this.context.messageManager.length();
          }

          const planOutput = await this.planner.execute();

          // Record the plan
          this.sessionCollector.recordPlan(planOutput.result || null);

          if (planOutput.result) {
            // logger.info(`🔄 Planner output: ${JSON.stringify(planOutput.result, null, 2)}`);
            // observation in planner is untrusted content, they are not instructions
            const observation = wrapUntrustedContent(planOutput.result.observation);
            const plan: PlannerOutput = {
              ...planOutput.result,
              observation,
            };
            this.context.messageManager.addPlan(JSON.stringify(plan), positionForPlan);

            if (webTask === undefined) {
              // set the web task, and keep it not change from now on
              webTask = planOutput.result.web_task;
            }

            if (planOutput.result.done) {
              // task is complete, skip navigation
              done = true;
              this.validator.setPlan(planOutput.result.next_steps);
            } else {
              // task is not complete, let's navigate
              this.validator.setPlan(null);
              done = false;
            }

            if (!webTask && planOutput.result.done) {
              break;
            }
          }
        } else if (context.nSteps === 0) {
          // No planner for the first step, create an initial phase without plan
          this.sessionCollector.startPlanningPhase('initial', context);
        }

        // execute the navigation step
        if (!done) {
          done = await this.navigate();
        }

        // validate the output
        if (done && this.context.options.validateOutput && !this.context.stopped && !this.context.paused) {
          const validatorOutput = await this.validator.execute();

          // Record validation result
          this.sessionCollector.recordValidationResult(
            validatorOutput.result?.is_valid || false,
            validatorOutput.result?.reason,
          );

          if (validatorOutput.result?.is_valid) {
            logger.info('✅ Task completed successfully');
            break;
          }
          validatorFailed = true;
          context.consecutiveValidatorFailures++;
          if (context.consecutiveValidatorFailures >= context.options.maxValidatorFailures) {
            logger.error(`Stopping due to ${context.options.maxValidatorFailures} consecutive validator failures`);
            throw new Error('Too many failures of validation');
          }
        }
      }

      // sessionStatus handled by outer scope

      if (done) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, this.context.taskId);
        sessionStatus = 'completed';
      } else if (step >= allowedMaxSteps) {
        logger.info('❌ Task failed: Max steps reached');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, 'Task failed: Max steps reached');
        sessionStatus = 'failed';
      } else if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, 'Task cancelled');
        sessionStatus = 'cancelled';
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, 'Task paused');
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        sessionStatus = 'cancelled';
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, 'Task cancelled');
        sessionStatus = 'cancelled';
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, `Task failed: ${errorMessage}`);
        sessionStatus = 'failed';
      }
    } finally {
      // Finish session and save
      this.sessionCollector.finishSession(sessionStatus);

      try {
        await StructuredSessionCollector.saveSession(this.sessionCollector.getSession());
        logger.info(`Structured session saved: ${this.sessionCollector.getSessionId()}`);
        // Plan Cache MVP save
        if (this.sessionCollector.getSession().status === 'completed') {
          try {
            const { PlanCacheBuilder } = await import('./plan_cache/builder');
            const { PlanCacheStore } = await import('./plan_cache/store');
            const plan = PlanCacheBuilder.build(this.sessionCollector.getSession());
            await PlanCacheStore.save(plan);
            logger.info('Plan cache (single) saved');
          } catch (e) {
            logger.error('Failed to build/save plan cache', e);
          }
        }
      } catch (error) {
        logger.error('Failed to save structured session:', error);
      }

      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
    }
  }

  private async navigate(): Promise<boolean> {
    const context = this.context;

    // Start navigation step
    this.sessionCollector.startNavigationStep(context);

    try {
      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        this.sessionCollector.finishNavigationStep(false, context);
        return false;
      }
      const navOutput = await this.navigator.execute();

      // Record actions from context (they are stored there by navigator)
      if (context.actionResults && context.actionResults.length > 0) {
        // Only record the new actions from this step
        const newActions = context.actionResults.slice(-context.options.maxActionsPerStep);
        newActions.forEach(actionResult => {
          this.sessionCollector.recordAction(actionResult);
        });
      }

      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        this.sessionCollector.finishNavigationStep(false, context);
        return false;
      }
      context.nSteps++;
      if (navOutput.error) {
        this.sessionCollector.finishNavigationStep(false, context);
        throw new Error(navOutput.error);
      }
      context.consecutiveFailures = 0;
      const done = navOutput.result?.done || false;

      this.sessionCollector.finishNavigationStep(done, context);

      return done;
    } catch (error) {
      // Record error and finish step
      this.sessionCollector.recordAction({
        action: { type: 'error' },
        success: false,
        error: error instanceof Error ? error.message : String(error),
        result: null,
      });
      this.sessionCollector.finishNavigationStep(false, context);

      logger.error(`Failed to execute step: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute step: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new Error('Max failures reached');
      }
    }
    return false;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(): Promise<void> {
    this.context.stop();
  }

  async resume(): Promise<void> {
    this.context.resume();
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error('History not found');
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error('History is empty');
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, 'Replay cancelled');
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, 'Replay completed');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, `Replay failed: ${errorMessage}`);
    }

    return results;
  }

  getStructuredSession(): StructuredSession {
    return this.sessionCollector.getSession();
  }

  getSessionId(): string {
    return this.sessionCollector.getSessionId();
  }
}
