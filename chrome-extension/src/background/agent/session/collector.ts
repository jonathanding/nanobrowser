import type { AgentContext } from '../types';
import type { PlannerOutput } from '../agents/planner';
import type { StructuredSession, PlanningPhase, NavigationStep, BrowserStateSnapshot, SessionIndex } from './types';
import { createLogger } from '@src/background/log';

const logger = createLogger('StructuredSessionCollector');

export class StructuredSessionCollector {
  private session: StructuredSession;
  private currentPhase: PlanningPhase | null = null;
  private currentStep: NavigationStep | null = null;
  private phaseCounter = 0;
  private stepCounter = 0;
  private stepsSinceLastPlan = 0;

  constructor(taskId: string, task: string, context: AgentContext) {
    console.log('🔥 StructuredSessionCollector constructor called', { taskId, task });
    logger.info('Initializing StructuredSessionCollector', { taskId, task });

    this.session = {
      sessionId: `session_${taskId}_${Date.now()}`,
      taskId,
      task,
      followUpTasks: [],
      startTime: Date.now(),
      status: 'running',
      planningPhases: [],
      summary: {
        totalPlanningPhases: 0,
        totalNavigationSteps: 0,
        totalActions: 0,
        executionTime: 0,
        successRate: 0,
        averageStepsPerPhase: 0,
        averageActionsPerStep: 0,
      },
      metadata: {
        maxSteps: context.options.maxSteps,
        planningInterval: context.options.planningInterval,
        validateOutput: context.options.validateOutput,
        useVision: context.options.useVision,
        useVisionForPlanner: context.options.useVisionForPlanner,
        extensionVersion: chrome.runtime.getManifest().version,
      },
      errorSummary: {
        totalErrors: 0,
        errorsByType: {},
        commonErrors: [],
      },
    };

    console.log('🔥 StructuredSessionCollector initialized', this.session.sessionId);
  }

  addFollowUpTask(task: string): void {
    this.session.followUpTasks.push(task);
    logger.debug(`Added follow-up task: ${task}`);
  }

  startPlanningPhase(trigger: 'initial' | 'periodic' | 'validator_failed', context: AgentContext): void {
    // Finish previous phase if exists
    if (this.currentPhase) {
      this.finishPlanningPhase();
    }

    this.currentPhase = {
      phaseNumber: ++this.phaseCounter,
      timestamp: Date.now(),
      trigger,
      input: {
        currentState: this.getCurrentBrowserState(context),
        messageHistory: [...context.messageManager.getMessages()],
        stepsSinceLastPlan: this.stepsSinceLastPlan,
      },
      plan: null,
      navigationSteps: [],
    };

    // Reset steps counter for this phase
    this.stepsSinceLastPlan = 0;

    logger.debug(`Started planning phase ${this.phaseCounter} (${trigger})`);
  }

  recordPlan(plan: PlannerOutput | null): void {
    if (!this.currentPhase) {
      logger.error('No current planning phase to record plan');
      return;
    }

    this.currentPhase.plan = plan;
    if (plan) {
      try {
        this.currentPhase.plannerModelOutput = JSON.stringify(plan);
      } catch {
        this.currentPhase.plannerModelOutput = undefined;
      }
    }
    logger.debug(`Recorded plan for phase ${this.currentPhase.phaseNumber}:`, {
      done: plan?.done,
      webTask: plan?.web_task,
      nextSteps: plan?.next_steps?.substring(0, 100) + '...',
    });
  }

  startNavigationStep(context: AgentContext): void {
    if (!this.currentPhase) {
      // Create an initial phase if none exists
      this.startPlanningPhase('initial', context);
    }

    this.currentStep = {
      stepNumber: ++this.stepCounter,
      timestamp: Date.now(),
      input: {
        messages: [...context.messageManager.getMessages()],
        browserState: this.getCurrentBrowserState(context),
      },
      actions: [],
      output: {
        done: false,
      },
    };

    this.stepsSinceLastPlan++;

    logger.debug(`Started navigation step ${this.stepCounter}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recordAction(actionResult: any): void {
    if (!this.currentStep) {
      logger.error('No current navigation step to record action');
      return;
    }

    // Preserve original action object if available (llm chosen action before execution)
    const original = actionResult?.action || {};
    const action = {
      type: original.type || actionResult?.action?.type || 'unknown',
      rawName: original.type || 'unknown',
      parameters: original.parameters || actionResult?.action?.parameters || {},
      result: actionResult?.result,
      success: Boolean(actionResult?.success),
      error: actionResult?.error,
      duration: actionResult?.duration,
      toolCallId: actionResult?.toolCallId,
    } as const;

    this.currentStep.actions.push(action);

    // Update error tracking
    if (!actionResult?.success && actionResult?.error) {
      this.session.errorSummary.totalErrors++;
      const errorType = actionResult?.action?.type || 'unknown';
      this.session.errorSummary.errorsByType[errorType] = (this.session.errorSummary.errorsByType[errorType] || 0) + 1;
    }

    logger.debug(`Recorded action: ${action.type} (success: ${action.success})`);
  }

  finishNavigationStep(done: boolean, context: AgentContext): void {
    if (!this.currentStep || !this.currentPhase) {
      logger.error('No current step or phase to finish');
      return;
    }

    this.currentStep.output = {
      done,
      newBrowserState: this.getCurrentBrowserState(context),
      navigatorModelOutput: context.lastNavigatorModelOutput,
    };

    this.currentPhase.navigationSteps.push(this.currentStep);
    this.currentStep = null;

    logger.debug(`Finished navigation step ${this.stepCounter} (done: ${done})`);
  }

  recordValidationResult(isValid: boolean, feedback?: string): void {
    if (!this.currentPhase) {
      logger.error('No current planning phase to record validation');
      return;
    }

    this.currentPhase.validationResult = {
      isValid,
      feedback,
      timestamp: Date.now(),
    };

    logger.debug(`Recorded validation result: ${isValid}`, feedback ? { feedback } : {});
  }

  finishPlanningPhase(): void {
    if (!this.currentPhase) {
      return;
    }

    this.session.planningPhases.push(this.currentPhase);
    this.currentPhase = null;

    logger.debug(`Finished planning phase ${this.phaseCounter}`);
  }

  finishSession(status: 'completed' | 'failed' | 'cancelled'): void {
    console.log('🔥 finishSession called', status, this.session.sessionId);
    // Finish current phase if exists
    if (this.currentPhase) {
      this.finishPlanningPhase();
    }

    this.session.status = status;
    this.session.endTime = Date.now();
    this.updateSummary();

    console.log('🔥 Session finished with summary:', this.session.summary);
    logger.info(`Finished session ${this.session.sessionId} with status: ${status}`, {
      phases: this.session.summary.totalPlanningPhases,
      steps: this.session.summary.totalNavigationSteps,
      actions: this.session.summary.totalActions,
      duration: this.session.summary.executionTime,
    });
  }

  private getCurrentBrowserState(context: AgentContext): BrowserStateSnapshot {
    try {
      return {
        timestamp: Date.now(),
        contextInfo: {
          nSteps: context.nSteps,
          consecutiveFailures: context.consecutiveFailures,
          actionResultsCount: context.actionResults.length,
        },
      };
    } catch (error) {
      logger.error('Failed to get browser state:', error);
      return {
        timestamp: Date.now(),
        contextInfo: {
          nSteps: context.nSteps || 0,
          consecutiveFailures: context.consecutiveFailures || 0,
          actionResultsCount: context.actionResults?.length || 0,
        },
      };
    }
  }

  private updateSummary(): void {
    const totalActions = this.session.planningPhases.reduce(
      (sum, phase) => sum + phase.navigationSteps.reduce((stepSum, step) => stepSum + step.actions.length, 0),
      0,
    );

    const successfulActions = this.session.planningPhases.reduce(
      (sum, phase) =>
        sum +
        phase.navigationSteps.reduce(
          (stepSum, step) => stepSum + step.actions.filter(action => action.success).length,
          0,
        ),
      0,
    );

    const totalNavigationSteps = this.session.planningPhases.reduce(
      (sum, phase) => sum + phase.navigationSteps.length,
      0,
    );

    // Calculate common errors
    const errorCounts = Object.entries(this.session.errorSummary.errorsByType)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([error]) => error);

    this.session.summary = {
      totalPlanningPhases: this.session.planningPhases.length,
      totalNavigationSteps,
      totalActions,
      executionTime: this.session.endTime
        ? this.session.endTime - this.session.startTime
        : Date.now() - this.session.startTime,
      successRate: totalActions > 0 ? successfulActions / totalActions : 0,
      averageStepsPerPhase:
        this.session.planningPhases.length > 0 ? totalNavigationSteps / this.session.planningPhases.length : 0,
      averageActionsPerStep: totalNavigationSteps > 0 ? totalActions / totalNavigationSteps : 0,
    };

    this.session.errorSummary.commonErrors = errorCounts;
  }

  getSession(): StructuredSession {
    return { ...this.session };
  }

  getSessionId(): string {
    return this.session.sessionId;
  }

  // Static methods for storage
  static async saveSession(session: StructuredSession): Promise<void> {
    try {
      console.log('🔥 saveSession called', session.sessionId, session);
      const key = `structured_session_${session.sessionId}`;
      await chrome.storage.local.set({ [key]: session });
      console.log('🔥 Session saved to chrome storage', key);

      // Update index
      await this.updateSessionIndex(session);
      console.log('🔥 Session index updated');

      logger.info(`Structured session saved: ${session.sessionId}`);
    } catch (error) {
      console.error('🔥 Failed to save structured session:', error);
      logger.error('Failed to save structured session:', error);
      throw error;
    }
  }

  static async loadSession(sessionId: string): Promise<StructuredSession | null> {
    try {
      const key = `structured_session_${sessionId}`;
      const result = await chrome.storage.local.get(key);
      return result[key] || null;
    } catch (error) {
      logger.error(`Failed to load structured session ${sessionId}:`, error);
      return null;
    }
  }

  static async listSessions(): Promise<SessionIndex[]> {
    try {
      const indexKey = 'structured_sessions_index';
      const result = await chrome.storage.local.get(indexKey);
      return result[indexKey] || [];
    } catch (error) {
      logger.error('Failed to list structured sessions:', error);
      return [];
    }
  }

  private static async updateSessionIndex(session: StructuredSession): Promise<void> {
    const indexKey = 'structured_sessions_index';

    try {
      console.log('🔥 updateSessionIndex called', session.sessionId);
      const result = await chrome.storage.local.get(indexKey);
      const index = result[indexKey] || [];
      console.log('🔥 Current index length:', index.length);

      const indexItem = {
        sessionId: session.sessionId,
        taskId: session.taskId,
        task: session.task,
        timestamp: session.startTime,
        status: session.status,
        duration: session.summary.executionTime,
        phases: session.summary.totalPlanningPhases,
        steps: session.summary.totalNavigationSteps,
        actions: session.summary.totalActions,
        successRate: Math.round(session.summary.successRate * 100),
      };

      console.log('🔥 Index item created:', indexItem);

      // Remove existing entry if it exists
      const filteredIndex = index.filter((item: SessionIndex) => item.sessionId !== session.sessionId);
      filteredIndex.push(indexItem);

      // Keep only latest 100 sessions
      filteredIndex.sort((a: SessionIndex, b: SessionIndex) => b.timestamp - a.timestamp);
      const trimmedIndex = filteredIndex.slice(0, 100);

      console.log('🔥 Final index length:', trimmedIndex.length);
      await chrome.storage.local.set({ [indexKey]: trimmedIndex });
      console.log('🔥 Index saved to storage');
    } catch (error) {
      console.error('🔥 Failed to update structured session index:', error);
      logger.error('Failed to update structured session index:', error);
    }
  }
}
