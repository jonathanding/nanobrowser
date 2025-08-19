/**
 * 会话查看工具 - 用于查看和分析执行的会话记录
 */

import { StructuredSessionCollector } from './index';
import type { StructuredSession } from './types';
import { createLogger } from '@src/background/log';

const logger = createLogger('SessionViewer');

export class SessionViewer {
  /**
   * 获取最近的会话列表
   */
  static async getRecentSessions(limit = 10) {
    try {
      const sessions = await StructuredSessionCollector.listSessions();
      const recent = sessions.slice(0, limit);

      console.log(`=== 最近 ${recent.length} 个会话 ===`);
      recent.forEach((session, index) => {
        const date = new Date(session.timestamp).toLocaleString();
        const duration = Math.round(session.duration / 1000);
        console.log(`${index + 1}. [${session.status}] ${session.task.substring(0, 60)}...`);
        console.log(`   ID: ${session.sessionId}`);
        console.log(`   时间: ${date} (${duration}秒)`);
        console.log(`   步骤: ${session.steps}, 动作: ${session.actions}, 成功率: ${session.successRate}%`);
        console.log('');
      });

      return recent;
    } catch (error) {
      logger.error('获取会话列表失败:', error);
      return [];
    }
  }

  /**
   * 查看特定会话的详细信息
   */
  static async viewSession(sessionId: string) {
    try {
      const session = await StructuredSessionCollector.loadSession(sessionId);

      if (!session) {
        console.log(`❌ 未找到会话: ${sessionId}`);
        return null;
      }

      this.printSessionDetail(session);
      return session;
    } catch (error) {
      logger.error('获取会话详情失败:', error);
      return null;
    }
  }

  /**
   * 查看最新的会话
   */
  static async viewLatestSession() {
    const sessions = await StructuredSessionCollector.listSessions();
    if (sessions.length === 0) {
      console.log('❌ 没有找到任何会话记录');
      return null;
    }

    const latestSession = sessions[0];
    console.log(`🔍 查看最新会话: ${latestSession.sessionId}`);
    return await this.viewSession(latestSession.sessionId);
  }

  /**
   * 搜索包含特定任务关键词的会话
   */
  static async searchSessions(keyword: string) {
    try {
      const sessions = await StructuredSessionCollector.listSessions();
      const filtered = sessions.filter(session => session.task.toLowerCase().includes(keyword.toLowerCase()));

      console.log(`=== 搜索结果: "${keyword}" (${filtered.length} 个会话) ===`);
      filtered.forEach((session, index) => {
        const date = new Date(session.timestamp).toLocaleString();
        console.log(`${index + 1}. [${session.status}] ${session.task}`);
        console.log(`   ID: ${session.sessionId}`);
        console.log(`   时间: ${date}`);
        console.log('');
      });

      return filtered;
    } catch (error) {
      logger.error('搜索会话失败:', error);
      return [];
    }
  }

  /**
   * 查看当前正在执行的会话（如果有）
   */
  static async viewRunningSession() {
    try {
      const sessions = await StructuredSessionCollector.listSessions();
      const runningSessions = sessions.filter(s => s.status === 'running');

      if (runningSessions.length === 0) {
        console.log('📋 当前没有正在运行的会话');
        return null;
      }

      console.log(`🔄 找到 ${runningSessions.length} 个正在运行的会话:`);
      for (const sessionInfo of runningSessions) {
        await this.viewSession(sessionInfo.sessionId);
      }

      return runningSessions;
    } catch (error) {
      logger.error('获取运行中会话失败:', error);
      return null;
    }
  }

  /**
   * 打印会话详细信息
   */
  private static printSessionDetail(session: StructuredSession) {
    console.log('='.repeat(80));
    console.log(`📊 会话详情: ${session.sessionId}`);
    console.log('='.repeat(80));

    // 基本信息
    console.log(`🎯 任务: ${session.task}`);
    if (session.followUpTasks.length > 0) {
      console.log(`📌 后续任务: ${session.followUpTasks.join(', ')}`);
    }
    console.log(`📈 状态: ${this.getStatusEmoji(session.status)} ${session.status}`);
    console.log(`⏰ 开始时间: ${new Date(session.startTime).toLocaleString()}`);
    if (session.endTime) {
      console.log(`🏁 结束时间: ${new Date(session.endTime).toLocaleString()}`);
    }
    console.log(`⌛ 执行时间: ${Math.round(session.summary.executionTime / 1000)}秒`);

    // 统计信息
    console.log('\n📊 执行统计:');
    console.log(`   规划阶段: ${session.summary.totalPlanningPhases}`);
    console.log(`   导航步骤: ${session.summary.totalNavigationSteps}`);
    console.log(`   总动作数: ${session.summary.totalActions}`);
    console.log(`   成功率: ${Math.round(session.summary.successRate * 100)}%`);
    console.log(`   平均每阶段步骤数: ${session.summary.averageStepsPerPhase.toFixed(1)}`);
    console.log(`   平均每步骤动作数: ${session.summary.averageActionsPerStep.toFixed(1)}`);

    // 错误信息
    if (session.errorSummary.totalErrors > 0) {
      console.log('\n❌ 错误统计:');
      console.log(`   总错误数: ${session.errorSummary.totalErrors}`);
      console.log('   错误类型:');
      Object.entries(session.errorSummary.errorsByType).forEach(([type, count]) => {
        console.log(`     ${type}: ${count}次`);
      });
    }

    // 规划阶段详情
    console.log('\n🗂️  规划阶段详情:');
    session.planningPhases.forEach((phase, phaseIndex) => {
      console.log(`\n   📋 阶段 ${phaseIndex + 1}: ${phase.trigger}`);
      console.log(`      时间: ${new Date(phase.timestamp).toLocaleString()}`);
      console.log(`      导航步骤: ${phase.navigationSteps.length}个`);

      if (phase.plan) {
        console.log(`      计划状态: ${phase.plan.done ? '✅ 完成' : '🔄 进行中'}`);
        console.log(`      网页任务: ${phase.plan.web_task ? '是' : '否'}`);
        console.log(`      观察: ${this.truncateText(phase.plan.observation, 100)}`);
        console.log(`      推理: ${this.truncateText(phase.plan.reasoning, 100)}`);
        console.log(`      下一步: ${this.truncateText(phase.plan.next_steps, 100)}`);
      }

      if (phase.validationResult) {
        const validation = phase.validationResult;
        console.log(`      验证: ${validation.isValid ? '✅ 有效' : '❌ 无效'}`);
        if (validation.feedback) {
          console.log(`      反馈: ${this.truncateText(validation.feedback, 100)}`);
        }
      }

      // 显示前几个导航步骤
      const stepsToShow = Math.min(3, phase.navigationSteps.length);
      for (let i = 0; i < stepsToShow; i++) {
        const step = phase.navigationSteps[i];
        console.log(`        🚶 步骤 ${i + 1}: ${step.actions.length}个动作`);

        // 显示前几个动作
        const actionsToShow = Math.min(2, step.actions.length);
        for (let j = 0; j < actionsToShow; j++) {
          const action = step.actions[j];
          const status = action.success ? '✅' : '❌';
          console.log(`          ${status} ${action.type}`);
          if (!action.success && action.error) {
            console.log(`             错误: ${action.error}`);
          }
        }

        if (step.actions.length > actionsToShow) {
          console.log(`          ... 还有 ${step.actions.length - actionsToShow} 个动作`);
        }
      }

      if (phase.navigationSteps.length > stepsToShow) {
        console.log(`        ... 还有 ${phase.navigationSteps.length - stepsToShow} 个步骤`);
      }
    });

    console.log('\n' + '='.repeat(80));
  }

  /**
   * 获取状态对应的表情符号
   */
  private static getStatusEmoji(status: string): string {
    switch (status) {
      case 'completed':
        return '✅';
      case 'failed':
        return '❌';
      case 'cancelled':
        return '⏹️';
      case 'running':
        return '🔄';
      default:
        return '❓';
    }
  }

  /**
   * 截断长文本
   */
  private static truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  /**
   * 导出会话为JSON文件（浏览器环境）
   */
  static async exportSessionToFile(sessionId: string) {
    try {
      const session = await StructuredSessionCollector.loadSession(sessionId);
      if (!session) {
        console.log(`❌ 未找到会话: ${sessionId}`);
        return;
      }

      const dataStr = JSON.stringify(session, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });

      // 创建下载链接
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `session-${sessionId}-${Date.now()}.json`;

      // 触发下载
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // 清理URL
      URL.revokeObjectURL(url);

      console.log(`✅ 会话已导出: session-${sessionId}-${Date.now()}.json`);
    } catch (error) {
      logger.error('导出会话失败:', error);
    }
  }

  /**
   * 清除所有会话数据（谨慎使用）
   */
  static async clearAllSessions() {
    try {
      const sessions = await StructuredSessionCollector.listSessions();

      if (sessions.length === 0) {
        console.log('📭 没有会话需要清除');
        return 0;
      }

      console.log(`⚠️  即将清除 ${sessions.length} 个会话，请确认操作...`);

      // 在实际使用中，你可能想要添加确认步骤
      let deletedCount = 0;
      for (const session of sessions) {
        try {
          const key = `structured_session_${session.sessionId}`;
          await chrome.storage.local.remove(key);
          deletedCount++;
        } catch (error) {
          logger.error(`删除会话 ${session.sessionId} 失败:`, error);
        }
      }

      // 清除索引
      await chrome.storage.local.remove('structured_sessions_index');

      console.log(`✅ 已清除 ${deletedCount} 个会话`);
      return deletedCount;
    } catch (error) {
      logger.error('清除会话失败:', error);
      return 0;
    }
  }
}

// 便捷的全局函数
export const viewLatestSession = () => SessionViewer.viewLatestSession();
export const viewSession = (sessionId: string) => SessionViewer.viewSession(sessionId);
export const listRecentSessions = (limit?: number) => SessionViewer.getRecentSessions(limit);
export const searchSessions = (keyword: string) => SessionViewer.searchSessions(keyword);
export const viewRunningSession = () => SessionViewer.viewRunningSession();
export const exportSession = (sessionId: string) => SessionViewer.exportSessionToFile(sessionId);
