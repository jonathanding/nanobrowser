# Plan Cache MVP Design (Simplified)

> 目标：用最少的代码，在现有成功 `StructuredSession` 的基础上，缓存一次成功执行的任务（只存一份），并在下一次任务执行时，用户可选择“使用缓存计划”直接复用该计划里的步骤与动作（不做匹配，不做回退，不做智能修复）。

本设计刻意去掉：匹配、参数抽取、置信度、版本、优化、合并、修复、动态替换、embedding、指标体系等所有后期复杂能力，只保留验证“缓存一次→下一次直接复用”这一核心闭环。

---

## 1. MVP 范围（Scope）
1. 当一个任务成功（status = completed）执行结束：
   - 读取该任务的 `StructuredSession`（已经有的结构）。
   - 抽取最简单的可复用信息：任务原始描述、顺序化的导航步骤、每步下成功的原子动作（仅保留基本字段：type / selector / text / url / keys / timestamp(可选) / result）。
   - 保存为唯一的缓存文件（覆盖式保存），命名例如：`plan_cache_single`。
2. 下一个任务开始前（或用户在输入前）：侧边面板提供一个“使用上次缓存计划”按钮：
   - 点击后，直接走 **缓存执行模式**：按缓存中的步骤 → 动作顺序执行。
   - 不调用 Planner / Navigator / Validator。
3. 执行中不做：
   - 失败重试 / 局部修复 / 重新规划。
   - 参数替换或语义适配。
   - 动态元素稳定性判断。
4. 如果某个动作执行失败：
   - 直接停止缓存执行（标记本次任务失败即可）。
   - 不修改缓存内容。
5. 成功后：可再次覆盖缓存（即缓存永远只有最近一次成功任务的“提炼版”）。

---

## 2. 数据模型（MVP 极简）

```ts
# Plan Cache MVP Design (Simplified)

> 目标：用最少的代码，在现有成功 `StructuredSession` 的基础上，缓存一次成功执行的任务（只存一份），并在下一次任务执行时，用户可选择“使用缓存计划”直接复用该计划里的步骤与动作（不做匹配，不做回退，不做智能修复）。

本设计刻意去掉：匹配、参数抽取、置信度、版本、优化、合并、修复、动态替换、embedding、指标体系等所有后期复杂能力，只保留验证“缓存一次→下一次直接复用”这一核心闭环。

---

## 1. MVP 范围（Scope）

1. 当一个任务成功（status = completed）执行结束：
   - 读取该任务的 `StructuredSession`（已经有的结构）。
   - 抽取最简单的可复用信息：任务原始描述、顺序化的导航步骤、每步下成功的原子动作（仅保留基本字段：type / selector / text / url / keys / timestamp(可选) / result）。
   - 保存为唯一的缓存文件（覆盖式保存），命名例如：`plan_cache_single`。
2. 下一个任务开始前（或用户在输入前）：侧边面板提供一个“使用上次缓存计划”按钮：
   - 点击后，直接走 **缓存执行模式**：按缓存中的步骤 → 动作顺序执行。
   - 不调用 Planner / Navigator / Validator。
3. 执行中不做：
   - 失败重试 / 局部修复 / 重新规划。
   - 参数替换或语义适配。
   - 动态元素稳定性判断。
4. 如果某个动作执行失败：
   - 直接停止缓存执行（标记本次任务失败即可）。
   - 不修改缓存内容。
5. 成功后：可再次覆盖缓存（即缓存永远只有最近一次成功任务的“提炼版”）。

---

## 2. 数据模型（MVP 极简）

```ts
// Stored at chrome.storage.local['plan_cache_single']
interface CachedPlan {
  cachedAt: number;          // 保存时间
  sourceSessionId: string;   // 来源 sessionId
  task: string;              // 原任务文本
  steps: CachedPlanStep[];   // 线性步骤序列
}

interface CachedPlanStep {
  index: number;             // 步骤顺序
  actions: CachedAction[];   // 该步骤的动作（顺序执行）
}

interface CachedAction {
  type: string;              // click / input / navigate / etc.
  selector?: string;         // 原始成功使用的 selector（如果有）
  text?: string;             // 输入文本（如 input）
  url?: string;              // 导航目标（navigate）
  keys?: string;             // 键盘操作
  // 下面字段仅保留最少可执行信息；不做稳定性 / 统计
}
```

提取策略（从 StructuredSession）：

```text
for each planningPhase in order:
  for each navigationStep:
    collect actions where action.success == true (或 result == 'success')
    if 至少有一个成功动作 → 生成一个 CachedPlanStep
```

忽略：失败动作、验证结果、plan reasoning、errorSummary、metadata、截图等。

---

## 3. 组件（MVP）

| 组件 | 作用 | 说明 |
| ---- | ---- | ---- |
| PlanCacheStore | 读写缓存 | 包装 chrome.storage.local set/get/remove 单一 key `plan_cache_single` |
| PlanCacheBuilder | 从 StructuredSession 构建 CachedPlan | 过滤动作，线性化步骤 |
| CachedPlanExecutor | 执行缓存计划 | 顺序遍历 steps / actions 并调用现有低层 action 执行器（或封装一个最小 dispatcher） |
| UI Hook | 侧边面板按钮 | “保存最新成功任务为缓存”（可自动） + “使用缓存执行” |

现阶段 **不新增**：匹配器 / 参数替换器 / 优化器 / 指标。

---

## 4. 写入流程（成功后缓存）

```ts
onExecutorFinish(session, status):
  if status === 'completed':
     const plan = PlanCacheBuilder.build(session)
     PlanCacheStore.save(plan) // 覆盖
```

可能的集成点：现在 `Executor` 保存 structured session 的 `finally` 块内部 —— 在成功分支后追加。

---

## 5. 读取并执行流程（使用缓存）

```ts
userClicksUseCache():
  plan = PlanCacheStore.load()
  if !plan: 提示“暂无缓存”
  else:
     CachedPlanExecutor.run(plan)

CachedPlanExecutor.run(plan):
  for step in plan.steps:
    for action in step.actions:
       dispatch(action)
       if 执行报错:
          emit task fail & stop
          return
  emit task success
```

调度层可直接复用现有 action 执行（如果已有统一的 ActionBuilder / Executor），否则创建一个最小映射：

```ts
switch(action.type){
  case 'click': performClick(selector)
  case 'input': performInput(selector, text)
  case 'navigate': navigateTo(url)
  // 其它按需添加
}
```

---

## 6. 用户交互（UI 简化）

| 位置 | 按钮 | 行为 |
| ---- | ---- | ---- |
| 任务成功 Toast / 或设置面板 | 保存为缓存（可自动，无 UI） | 默认自动覆盖即可，可加日志 |
| Chat 输入区上方（或 header 图标） | 使用缓存计划 | 触发缓存执行（不需要输入新指令） |

初期可以：

1. 自动缓存最后一次成功任务，无需按钮。
2. 只提供“使用缓存计划”按钮。

---

## 7. 非目标（Out of Scope for MVP）

- 多条缓存 / 索引 / 检索 / 相似度匹配
- 参数提取与变量替换
- 失败回退（局部 navigator / 全局 planner）
- 选择器稳定性 / 多候选合并
- 统计指标（成功率 / 耗时 / 版本号）
- LLM 参与的 plan 精炼 / 合并 / 升级
- embedding / 向量索引
- 分阶段计划 / DSL / 复杂依赖管理

---

## 8. 最小实现步骤（建议顺序）

1. 定义 `CachedPlan` / `CachedPlanStep` / `CachedAction` Type（新文件 `plan_cache/types.ts`）。
2. 实现 `PlanCacheStore`：`load() | save(plan) | clear()`。
3. 实现 `PlanCacheBuilder.build(structuredSession)`：提取成功 actions。
4. 在 `Executor` 成功结束后调用 builder + store.save。
5. 实现 `CachedPlanExecutor`（最小 switch）。
6. 在 SidePanel 增加一个按钮：`使用缓存计划` → 发送一条特殊指令到 background（如 `{type: 'use_cached_plan'}`）。
7. background 收到后：加载 plan → 直接通过 CachedPlanExecutor 执行。
8. 简单日志：开始 / 每步 / 失败 / 完成。

完成即获得端到端验证：一次真实执行 → 缓存 → 无 LLM 复用。

---

## 9. 简单错误处理策略

- 如果执行前发现无缓存：UI 弹提示（或在按钮上禁用）。
- 如果缓存为空 steps：直接标记失败并清除缓存（防止脏数据）。
- 单个动作失败：终止整个缓存执行（不做任何智能补救）。

---

## 10. 未来 TODO（仅列出，不影响当前实现）

> 以下内容本设计 **不落地**，仅为后续演进备忘，不要提前在代码/数据结构中预留字段。

短期：

- 支持多条缓存与简单列表选择
- 失败动作回退到 Navigator
- 参数占位符抽象与替换

中期：

- 相似任务匹配（关键词 / embedding）
- 选择器多候选与稳定性评分
- Plan 版本化与合并优化

长期：

- 局部修复 + 全局重规划策略
- Prompt 级 Plan 抽象（PlanCacherAgent）
- 指标 dashboard & 可视化
- 远程同步 / 共享市场

---

## 11. 验证标准（MVP Done Definition）

| 项目 | 验证方式 |
| ---- | ---- |
| 成功任务后生成缓存 | 查看 storage: 存在 `plan_cache_single` 且含 steps/actions |
| 使用缓存执行 | 点击按钮后无 Planner/Navigator 调用日志，仅执行动作日志 |
| 动作执行顺序正确 | 控制台日志顺序与缓存结构一致 |
| 动作失败终止 | 人为破坏 selector，执行被中止并记录失败 |
| 覆盖式保存 | 第二次成功任务后缓存被替换 |

---

**下一步：按第 8 节顺序开始编码。**

