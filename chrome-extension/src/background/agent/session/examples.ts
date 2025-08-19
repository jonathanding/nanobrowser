/**
 * 示例：如何使用结构化会话追踪和分析功能
 *
 * 这个文件展示了如何使用新的会话追踪系统来分析AI Agent的执行过程
 */

import { SessionAnalyzer, StructuredSessionCollector } from './index';
import type { StructuredSession } from './types';

// 示例1: 获取会话分析报告
async function getSessionAnalytics() {
  const analytics = await SessionAnalyzer.getSessionAnalytics();

  console.log('=== 会话分析报告 ===');
  console.log(`总会话数: ${analytics.totalSessions}`);
  console.log(`成功率: ${analytics.successRate * 100}%`);
  console.log(`平均执行时间: ${analytics.averageExecutionTime}秒`);
  console.log(`平均每会话步骤数: ${analytics.averageStepsPerSession}`);
  console.log(`平均每会话动作数: ${analytics.averageActionsPerSession}`);
  console.log(`平均每会话规划阶段数: ${analytics.averagePhasesPerSession}`);

  console.log('\n=== 常见错误 ===');
  analytics.commonErrors.forEach(({ error, count }) => {
    console.log(`${error}: ${count}次`);
  });

  console.log('\n=== 动作类型分布 ===');
  Object.entries(analytics.actionTypeBreakdown).forEach(([type, count]) => {
    console.log(`${type}: ${count}次`);
  });

  console.log('\n=== 规划触发统计 ===');
  Object.entries(analytics.planningTriggerStats).forEach(([trigger, count]) => {
    console.log(`${trigger}: ${count}次`);
  });
}

// 示例2: 获取特定会话的详细信息
async function getSessionDetails(sessionId: string) {
  const session = await SessionAnalyzer.getSessionDetailedReport(sessionId);

  if (!session) {
    console.log('会话未找到');
    return;
  }

  console.log(`=== 会话详情: ${sessionId} ===`);
  console.log(`任务: ${session.task}`);
  console.log(`状态: ${session.status}`);
  console.log(`开始时间: ${new Date(session.startTime).toLocaleString()}`);
  console.log(`结束时间: ${session.endTime ? new Date(session.endTime).toLocaleString() : '未结束'}`);
  console.log(`执行时间: ${Math.round(session.summary.executionTime / 1000)}秒`);

  console.log('\n=== 规划阶段 ===');
  session.planningPhases.forEach((phase, index) => {
    console.log(`\n阶段 ${index + 1}: ${phase.trigger}`);
    console.log(`时间: ${new Date(phase.timestamp).toLocaleString()}`);

    if (phase.plan) {
      console.log(`计划完成状态: ${phase.plan.done}`);
      console.log(`是否为网页任务: ${phase.plan.web_task}`);
      console.log(`推理过程: ${phase.plan.reasoning.substring(0, 100)}...`);
      console.log(`下一步计划: ${phase.plan.next_steps.substring(0, 100)}...`);
    }

    console.log(`导航步骤数: ${phase.navigationSteps.length}`);

    if (phase.validationResult) {
      console.log(`验证结果: ${phase.validationResult.isValid ? '有效' : '无效'}`);
      if (phase.validationResult.feedback) {
        console.log(`验证反馈: ${phase.validationResult.feedback.substring(0, 100)}...`);
      }
    }

    // 显示导航步骤详情
    phase.navigationSteps.forEach((step, stepIndex) => {
      console.log(`  步骤 ${stepIndex + 1}: ${step.actions.length} 个动作`);
      step.actions.forEach((action, actionIndex) => {
        console.log(`    动作 ${actionIndex + 1}: ${action.type} (${action.success ? '成功' : '失败'})`);
        if (!action.success && action.error) {
          console.log(`      错误: ${action.error}`);
        }
      });
    });
  });

  console.log('\n=== 错误总结 ===');
  console.log(`总错误数: ${session.errorSummary.totalErrors}`);
  console.log('错误类型统计:');
  Object.entries(session.errorSummary.errorsByType).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}次`);
  });
}

// 示例3: 列出所有会话
async function listAllSessions() {
  const sessions = await StructuredSessionCollector.listSessions();

  console.log('=== 所有会话列表 ===');
  sessions.forEach((session, index) => {
    console.log(`${index + 1}. ${session.sessionId}`);
    console.log(`   任务: ${session.task.substring(0, 50)}...`);
    console.log(`   状态: ${session.status}`);
    console.log(`   时间: ${new Date(session.timestamp).toLocaleString()}`);
    console.log(`   步骤: ${session.steps}, 动作: ${session.actions}`);
    console.log(`   成功率: ${session.successRate}%`);
    console.log('');
  });
}

// 示例4: 导出会话数据用于分析
async function exportSessionData(sessionIds?: string[]) {
  const data = await SessionAnalyzer.exportSessionData(sessionIds);

  // 在实际使用中，你可能想要保存到文件或发送到服务器
  console.log('导出的会话数据:');
  console.log(data.substring(0, 1000) + '...');

  // 示例：保存到本地存储或下载
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // 创建下载链接
  const a = document.createElement('a');
  a.href = url;
  a.download = `session-data-${Date.now()}.json`;
  a.click();

  URL.revokeObjectURL(url);
}

// 示例5: 清理旧会话
async function cleanupOldSessions() {
  const deletedCount = await SessionAnalyzer.clearOldSessions(30); // 删除30天前的会话
  console.log(`已删除 ${deletedCount} 个旧会话`);
}

// 示例6: 实时监控执行器会话
class SessionMonitor {
  private executor: unknown; // 你的 Executor 实例

  constructor(executor: unknown) {
    this.executor = executor;
  }

  startMonitoring() {
    // 订阅执行事件
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.executor as any).subscribeExecutionEvents((event: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.log(`执行事件: ${(event as any).state} - ${(event as any).details}`);

      // 获取当前会话状态
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = (this.executor as any).getStructuredSession();
      this.logSessionProgress(session);
    });
  }

  private logSessionProgress(session: StructuredSession) {
    const currentPhase = session.planningPhases[session.planningPhases.length - 1];
    if (currentPhase) {
      console.log(`当前阶段: ${currentPhase.phaseNumber}`);
      console.log(`导航步骤: ${currentPhase.navigationSteps.length}`);

      const lastStep = currentPhase.navigationSteps[currentPhase.navigationSteps.length - 1];
      if (lastStep) {
        console.log(`最后一步: ${lastStep.actions.length} 个动作`);
      }
    }
  }

  stopMonitoring() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.executor as any).clearExecutionEvents();
  }
}

export {
  getSessionAnalytics,
  getSessionDetails,
  listAllSessions,
  exportSessionData,
  cleanupOldSessions,
  SessionMonitor,
};
