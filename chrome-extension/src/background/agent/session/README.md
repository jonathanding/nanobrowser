# 会话追踪系统 (Session Tracking System)

这个系统为 Nanobrowser 的 AI Agent 提供了完整的执行过程追踪和分析功能。

## 功能概览

### 🎯 主要特性

1. **结构化会话记录**: 按照 `任务 → 规划阶段 → 导航步骤 → 动作` 的层次结构记录完整的执行过程
2. **实时追踪**: 在任务执行过程中实时记录每个步骤的详细信息
3. **持久化存储**: 将会话数据保存到 Chrome 扩展的本地存储中
4. **分析工具**: 提供丰富的分析功能来理解执行模式和问题
5. **导出功能**: 支持导出会话数据用于进一步分析

### 📊 数据结构

```
StructuredSession
├── 基本信息 (任务ID、开始时间、状态等)
├── 规划阶段数组 (PlanningPhase[])
│   ├── 触发原因 (initial/periodic/validator_failed)
│   ├── 输入状态 (消息历史、浏览器状态)
│   ├── 生成的计划 (PlannerOutput)
│   ├── 导航步骤数组 (NavigationStep[])
│   │   ├── 输入 (消息、浏览器状态)
│   │   ├── 执行的动作 (actions[])
│   │   └── 输出 (完成状态、新状态)
│   └── 验证结果 (可选)
├── 执行总结 (步骤数、动作数、成功率等)
└── 错误总结 (错误类型、频率等)
```

## 使用方法

### 基本使用

会话追踪已经集成到 `Executor` 类中，无需额外配置：

```typescript
import { Executor } from './executor';

// 创建执行器时会自动开始会话追踪
const executor = new Executor(task, taskId, browserContext, llm);

// 执行任务 - 所有步骤都会被自动记录
await executor.execute();

// 获取会话信息
const session = executor.getStructuredSession();
console.log('会话ID:', executor.getSessionId());
```

### 分析功能

```typescript
import { SessionAnalyzer } from './session';

// 获取总体分析报告
const analytics = await SessionAnalyzer.getSessionAnalytics();
console.log(`成功率: ${analytics.successRate}%`);
console.log(`平均执行时间: ${analytics.averageExecutionTime}秒`);

// 获取特定会话详情
const sessionDetails = await SessionAnalyzer.getSessionDetailedReport(sessionId);

// 导出数据
const exportData = await SessionAnalyzer.exportSessionData();
```

### 查询会话

```typescript
import { StructuredSessionCollector } from './session';

// 列出所有会话
const sessions = await StructuredSessionCollector.listSessions();

// 加载特定会话
const session = await StructuredSessionCollector.loadSession(sessionId);
```

## 分析报告

### 成功率分析
- 任务完成率
- 步骤成功率
- 动作成功率

### 性能分析
- 平均执行时间
- 平均步骤数
- 平均动作数
- 规划频率

### 错误分析
- 常见错误类型
- 错误频率统计
- 失败模式识别

### 行为模式
- 动作类型分布
- 规划触发原因统计
- 执行路径分析

## API 参考

### StructuredSessionCollector

```typescript
class StructuredSessionCollector {
  // 添加后续任务
  addFollowUpTask(task: string): void
  
  // 开始规划阶段
  startPlanningPhase(trigger: 'initial' | 'periodic' | 'validator_failed', context: AgentContext): void
  
  // 记录计划
  recordPlan(plan: PlannerOutput | null): void
  
  // 开始导航步骤
  startNavigationStep(context: AgentContext): void
  
  // 记录动作
  recordAction(actionResult: any): void
  
  // 完成导航步骤
  finishNavigationStep(done: boolean, context: AgentContext): void
  
  // 记录验证结果
  recordValidationResult(isValid: boolean, feedback?: string): void
  
  // 完成会话
  finishSession(status: 'completed' | 'failed' | 'cancelled'): void
  
  // 获取会话数据
  getSession(): StructuredSession
  
  // 静态方法
  static saveSession(session: StructuredSession): Promise<void>
  static loadSession(sessionId: string): Promise<StructuredSession | null>
  static listSessions(): Promise<SessionIndex[]>
}
```

### SessionAnalyzer

```typescript
class SessionAnalyzer {
  // 获取总体分析
  static getSessionAnalytics(): Promise<SessionAnalytics>
  
  // 获取常见错误
  static getCommonErrors(): Promise<Array<{ error: string; count: number }>>
  
  // 获取动作类型分布
  static getActionTypeBreakdown(): Promise<Record<string, number>>
  
  // 获取规划触发统计
  static getPlanningTriggerStats(): Promise<Record<string, number>>
  
  // 获取详细报告
  static getSessionDetailedReport(sessionId: string): Promise<StructuredSession | null>
  
  // 导出数据
  static exportSessionData(sessionIds?: string[]): Promise<string>
  
  // 清理旧会话
  static clearOldSessions(olderThanDays?: number): Promise<number>
}
```

## 存储说明

### 存储结构
- 会话数据: `structured_session_{sessionId}`
- 会话索引: `structured_sessions_index`

### 存储限制
- 最多保留 100 个会话的索引
- 支持手动清理旧会话
- 数据存储在 Chrome 扩展的本地存储中

## 示例场景

查看 `examples.ts` 文件了解具体的使用示例，包括：

1. 获取会话分析报告
2. 查看特定会话详情
3. 列出所有会话
4. 导出会话数据
5. 清理旧会话
6. 实时监控执行过程

## 注意事项

1. **性能影响**: 会话追踪对性能影响很小，因为只在关键节点记录数据
2. **存储空间**: 定期清理旧会话以避免存储空间过大
3. **隐私**: 所有数据都存储在本地，不会发送到外部服务器
4. **调试**: 在开发模式下会输出更详细的调试信息

## 扩展性

这个系统设计为可扩展的：

1. **自定义分析**: 可以添加新的分析维度
2. **数据导出**: 支持多种格式的数据导出
3. **可视化**: 可以基于这些数据构建可视化界面
4. **集成**: 可以与其他分析工具集成

---

通过这个会话追踪系统，你可以深入了解 AI Agent 的执行过程，识别性能瓶颈，改进策略，并为进一步的优化提供数据支持。
