import type { BaseMessage } from '@langchain/core/messages';
import type { PlannerOutput } from '../agents/planner';

export interface BrowserStateSnapshot {
  timestamp: number;
  url?: string;
  title?: string;
  contextInfo: {
    nSteps: number;
    consecutiveFailures: number;
    actionResultsCount: number;
  };
}

export interface NavigationStep {
  stepNumber: number;
  timestamp: number;
  input: {
    messages: BaseMessage[];
    browserState: BrowserStateSnapshot;
  };
  actions: {
    type: string;
    parameters: Record<string, unknown>;
    result: unknown;
    success: boolean;
    error?: string;
    duration?: number;
    toolCallId?: string;
  }[];
  output: {
    done: boolean;
    newBrowserState?: BrowserStateSnapshot;
  };
}

export interface PlanningPhase {
  phaseNumber: number;
  timestamp: number;
  trigger: 'initial' | 'periodic' | 'validator_failed';
  input: {
    currentState: BrowserStateSnapshot;
    messageHistory: BaseMessage[];
    stepsSinceLastPlan: number;
  };
  plan: PlannerOutput | null;
  navigationSteps: NavigationStep[];
  validationResult?: {
    isValid: boolean;
    feedback?: string;
    timestamp: number;
  };
}

export interface StructuredSession {
  sessionId: string;
  taskId: string;
  task: string;
  followUpTasks: string[];
  startTime: number;
  endTime?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';

  planningPhases: PlanningPhase[];

  summary: {
    totalPlanningPhases: number;
    totalNavigationSteps: number;
    totalActions: number;
    executionTime: number;
    successRate: number;
    averageStepsPerPhase: number;
    averageActionsPerStep: number;
  };

  metadata: {
    maxSteps: number;
    planningInterval: number;
    validateOutput: boolean;
    useVision: boolean;
    useVisionForPlanner: boolean;
    llmModel?: string;
    extensionVersion?: string;
  };

  errorSummary: {
    totalErrors: number;
    errorsByType: Record<string, number>;
    commonErrors: string[];
  };
}

export interface SessionIndex {
  sessionId: string;
  taskId: string;
  task: string;
  timestamp: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  duration: number;
  phases: number;
  steps: number;
  actions: number;
  successRate: number;
}
