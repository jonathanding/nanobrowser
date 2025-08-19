import { StructuredSessionCollector } from './collector';
import type { StructuredSession, SessionIndex } from './types';
import { createLogger } from '@src/background/log';

const logger = createLogger('SessionAnalyzer');

export interface SessionAnalytics {
  totalSessions: number;
  successRate: number;
  averageExecutionTime: number;
  averageStepsPerSession: number;
  averageActionsPerSession: number;
  averagePhasesPerSession: number;
  commonErrors: Array<{ error: string; count: number }>;
  actionTypeBreakdown: Record<string, number>;
  planningTriggerStats: Record<string, number>;
  recentSessions: SessionIndex[];
}

export class SessionAnalyzer {
  static async getSessionAnalytics(): Promise<SessionAnalytics> {
    const sessions = await StructuredSessionCollector.listSessions();

    if (sessions.length === 0) {
      return {
        totalSessions: 0,
        successRate: 0,
        averageExecutionTime: 0,
        averageStepsPerSession: 0,
        averageActionsPerSession: 0,
        averagePhasesPerSession: 0,
        commonErrors: [],
        actionTypeBreakdown: {},
        planningTriggerStats: {},
        recentSessions: [],
      };
    }

    const completedSessions = sessions.filter(s => s.status === 'completed');
    const successRate = completedSessions.length / sessions.length;

    const avgExecutionTime = sessions.reduce((sum, s) => sum + s.duration, 0) / sessions.length;
    const avgSteps = sessions.reduce((sum, s) => sum + s.steps, 0) / sessions.length;
    const avgActions = sessions.reduce((sum, s) => sum + s.actions, 0) / sessions.length;
    const avgPhases = sessions.reduce((sum, s) => sum + s.phases, 0) / sessions.length;

    // Get detailed analysis from full sessions
    const commonErrors = await this.getCommonErrors();
    const actionTypeBreakdown = await this.getActionTypeBreakdown();
    const planningTriggerStats = await this.getPlanningTriggerStats();

    return {
      totalSessions: sessions.length,
      successRate: Math.round(successRate * 100) / 100,
      averageExecutionTime: Math.round(avgExecutionTime / 1000), // Convert to seconds
      averageStepsPerSession: Math.round(avgSteps * 10) / 10,
      averageActionsPerSession: Math.round(avgActions * 10) / 10,
      averagePhasesPerSession: Math.round(avgPhases * 10) / 10,
      commonErrors,
      actionTypeBreakdown,
      planningTriggerStats,
      recentSessions: sessions.slice(0, 10),
    };
  }

  static async getCommonErrors(): Promise<Array<{ error: string; count: number }>> {
    const sessions = await StructuredSessionCollector.listSessions();
    const errorCounts: Record<string, number> = {};

    for (const sessionInfo of sessions.slice(0, 50)) {
      // Limit to recent 50 sessions
      try {
        const session = await StructuredSessionCollector.loadSession(sessionInfo.sessionId);
        if (session) {
          Object.entries(session.errorSummary.errorsByType).forEach(([error, count]) => {
            errorCounts[error] = (errorCounts[error] || 0) + count;
          });
        }
      } catch (error) {
        logger.error(`Failed to load session ${sessionInfo.sessionId}:`, error);
      }
    }

    return Object.entries(errorCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([error, count]) => ({ error, count }));
  }

  static async getActionTypeBreakdown(): Promise<Record<string, number>> {
    const sessions = await StructuredSessionCollector.listSessions();
    const actionCounts: Record<string, number> = {};

    for (const sessionInfo of sessions.slice(0, 20)) {
      // Limit to recent 20 sessions
      try {
        const session = await StructuredSessionCollector.loadSession(sessionInfo.sessionId);
        if (session) {
          session.planningPhases.forEach(phase => {
            phase.navigationSteps.forEach(step => {
              step.actions.forEach(action => {
                actionCounts[action.type] = (actionCounts[action.type] || 0) + 1;
              });
            });
          });
        }
      } catch (error) {
        logger.error(`Failed to load session ${sessionInfo.sessionId}:`, error);
      }
    }

    return actionCounts;
  }

  static async getPlanningTriggerStats(): Promise<Record<string, number>> {
    const sessions = await StructuredSessionCollector.listSessions();
    const triggerCounts: Record<string, number> = {};

    for (const sessionInfo of sessions.slice(0, 20)) {
      // Limit to recent 20 sessions
      try {
        const session = await StructuredSessionCollector.loadSession(sessionInfo.sessionId);
        if (session) {
          session.planningPhases.forEach(phase => {
            triggerCounts[phase.trigger] = (triggerCounts[phase.trigger] || 0) + 1;
          });
        }
      } catch (error) {
        logger.error(`Failed to load session ${sessionInfo.sessionId}:`, error);
      }
    }

    return triggerCounts;
  }

  static async getSessionDetailedReport(sessionId: string): Promise<StructuredSession | null> {
    return await StructuredSessionCollector.loadSession(sessionId);
  }

  static async exportSessionData(sessionIds?: string[]): Promise<string> {
    const sessionsToExport: StructuredSession[] = [];

    if (sessionIds && sessionIds.length > 0) {
      // Export specific sessions
      for (const sessionId of sessionIds) {
        const session = await StructuredSessionCollector.loadSession(sessionId);
        if (session) {
          sessionsToExport.push(session);
        }
      }
    } else {
      // Export all recent sessions
      const sessionList = await StructuredSessionCollector.listSessions();
      for (const sessionInfo of sessionList.slice(0, 50)) {
        const session = await StructuredSessionCollector.loadSession(sessionInfo.sessionId);
        if (session) {
          sessionsToExport.push(session);
        }
      }
    }

    return JSON.stringify(sessionsToExport, null, 2);
  }

  static async clearOldSessions(olderThanDays = 30): Promise<number> {
    const sessions = await StructuredSessionCollector.listSessions();
    const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const oldSessions = sessions.filter(s => s.timestamp < cutoffTime);

    let deletedCount = 0;
    for (const session of oldSessions) {
      try {
        const key = `structured_session_${session.sessionId}`;
        await chrome.storage.local.remove(key);
        deletedCount++;
      } catch (error) {
        logger.error(`Failed to delete session ${session.sessionId}:`, error);
      }
    }

    // Update index
    const remainingSessions = sessions.filter(s => s.timestamp >= cutoffTime);
    await chrome.storage.local.set({
      structured_sessions_index: remainingSessions,
    });

    logger.info(`Deleted ${deletedCount} old sessions`);
    return deletedCount;
  }
}
