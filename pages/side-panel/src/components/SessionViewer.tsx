import React, { useEffect, useState } from 'react';
import { FiActivity } from 'react-icons/fi';

// Removed session list interface after simplification

interface CachedAction {
  type: string;
  url?: string;
  text?: string;
  selector?: string;
  keys?: string;
  index?: number;
  success?: boolean;
  error?: string;
}
interface CachedPlanStep {
  index: number;
  plannerOutput?: string;
  navigatorOutput?: string;
  actions: CachedAction[];
}
interface CachedPlan {
  planId?: string;
  cachedAt: number;
  sourceSessionId: string;
  task: string;
  steps: CachedPlanStep[];
  sessionStatus?: string;
  durationMs?: number;
}

interface Props {
  isDarkMode: boolean;
}

const cardBase = (dark: boolean) =>
  dark ? 'rounded-lg border border-gray-700 bg-gray-800' : 'rounded-lg border border-gray-200 bg-gray-50';

const SessionViewer: React.FC<Props> = ({ isDarkMode }) => {
  const [plans, setPlans] = useState<CachedPlan[]>([]);
  const [activePlanId, setActivePlanId] = useState<string | undefined>();
  const [executing, setExecuting] = useState<'idle' | 'running' | 'success' | 'failed' | 'cleared'>('idle');
  const [progress, setProgress] = useState<{ runningStep?: number; failedStep?: number; error?: string }>({});
  const [replanDebug, setReplanDebug] = useState<
    {
      step: number;
      attempt: number;
      request: { system: string; user: string };
      raw: unknown;
      parsed?: unknown;
      error?: string;
    }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const result = await chrome.storage.local.get(['plan_cache_list', 'plan_cache_single']);
        let list: CachedPlan[] = result.plan_cache_list || [];
        if ((!list || list.length === 0) && result.plan_cache_single) list = [result.plan_cache_single];
        setPlans(list);
        if (list.length) setActivePlanId(list[0].planId || list[0].sourceSessionId);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Removed overview & session list per simplification request

  const executeCachedPlan = async () => {
    if (!activePlanId) return;
    setExecuting('running');
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) throw new Error('No active tab');
      const port = chrome.runtime.connect({ name: 'side-panel-connection' });
      port.postMessage({ type: 'execute_cached_plan', tabId });
      const replanAttemptPerStep: Record<number, number> = {};
      port.onMessage.addListener(msg => {
        if (msg.type === 'cached_plan_status') {
          if (msg.status === 'running') setExecuting('running');
          else if (msg.status === 'success') {
            setExecuting('success');
            setProgress({});
          } else if (msg.status === 'failed') setExecuting('failed');
          else if (msg.status === 'cleared') setExecuting('cleared');
        } else if (msg.type === 'cached_plan_progress' && msg.event?.kind === 'step') {
          const ev = msg.event;
          if (ev.status === 'running') setProgress(p => ({ ...p, runningStep: ev.stepIndex }));
          else if (ev.status === 'success')
            setProgress(p => (p.runningStep === ev.stepIndex ? { ...p, runningStep: undefined } : p));
          else if (ev.status === 'failed') setProgress({ failedStep: ev.stepIndex, error: ev.error });
        } else if (msg.type === 'agent_event' && msg.event?.data?.details) {
          const details = msg.event.data.details;
          try {
            const parsed = JSON.parse(details);
            if (parsed && typeof parsed.kind === 'string' && parsed.kind.startsWith('replay_local_replan')) {
              const stepIdx = msg.event.data.step ?? 0;
              replanAttemptPerStep[stepIdx] = (replanAttemptPerStep[stepIdx] || 0) + 1;
              setReplanDebug(list => [
                ...list,
                {
                  step: stepIdx,
                  attempt: replanAttemptPerStep[stepIdx],
                  request: parsed.request || { system: '', user: '' },
                  raw: parsed.raw ?? parsed.reason ?? parsed.text ?? parsed,
                  parsed: parsed.parsed,
                  error: parsed.error,
                },
              ]);
            }
          } catch {
            // ignore non-JSON
          }
        }
      });
      // Auto reset status after a while
      setTimeout(() => setExecuting(s => (s === 'success' || s === 'failed' ? 'idle' : s)), 4000);
    } catch (e) {
      console.error(e);
      setExecuting('failed');
      setTimeout(() => setExecuting('idle'), 4000);
    }
  };

  const clearCachedPlan = async () => {
    try {
      const port = chrome.runtime.connect({ name: 'side-panel-connection' });
      port.postMessage({ type: 'clear_cached_plan' });
      setPlans([]);
      setActivePlanId(undefined);
      setExecuting('cleared');
      setTimeout(() => setExecuting('idle'), 2000);
    } catch (e) {
      console.error(e);
    }
  };

  const activePlan = plans.find(p => (p.planId || p.sourceSessionId) === activePlanId) || null;

  const removePlan = (planId: string | undefined) => {
    if (!planId) return;
    const port = chrome.runtime.connect({ name: 'side-panel-connection' });
    port.postMessage({ type: 'remove_cached_plan', planId });
    port.onMessage.addListener(msg => {
      if (msg.type === 'cached_plan_list') {
        setPlans(msg.plans as CachedPlan[]);
        if (msg.plans.length) setActivePlanId(msg.plans[0].planId || msg.plans[0].sourceSessionId);
        else setActivePlanId(undefined);
      }
    });
  };

  const refreshPlans = () => {
    const port = chrome.runtime.connect({ name: 'side-panel-connection' });
    port.postMessage({ type: 'list_cached_plans' });
    port.onMessage.addListener(msg => {
      if (msg.type === 'cached_plan_list') {
        setPlans(msg.plans as CachedPlan[]);
        if (msg.plans.length && !activePlanId) setActivePlanId(msg.plans[0].planId || msg.plans[0].sourceSessionId);
      }
    });
  };

  const renderCache = () => {
    if (!activePlan)
      return (
        <div className="space-y-4">
          <h2
            className={`flex items-center gap-2 text-xl font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
            缓存计划
          </h2>
          <div className={`${cardBase(isDarkMode)} p-6 text-center`}>
            <p className={isDarkMode ? 'text-gray-300' : 'text-gray-600'}>暂无缓存</p>
          </div>
        </div>
      );
    return (
      <div className="space-y-4">
        <h2 className={`flex items-center gap-2 text-xl font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
          缓存计划
        </h2>
        <div className="grid gap-4 md:grid-cols-12">
          <div className="space-y-3 md:col-span-4">
            <div className={`${cardBase(isDarkMode)} p-3`}>
              <div className="mb-2 flex items-center justify-between">
                <div className={`text-sm font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>计划列表</div>
                <button
                  onClick={refreshPlans}
                  className={`text-xs underline ${isDarkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'}`}>
                  刷新
                </button>
              </div>
              <div className="max-h-72 space-y-2 overflow-auto pr-1">
                {plans.map(p => {
                  const id = p.planId || p.sourceSessionId;
                  const active = id === activePlanId;
                  return (
                    <button
                      key={id}
                      onClick={() => setActivePlanId(id)}
                      className={`w-full rounded border px-2 py-1 text-left text-xs ${active ? (isDarkMode ? 'border-blue-500 bg-blue-600/20' : 'border-blue-500 bg-blue-50') : isDarkMode ? 'border-slate-600 hover:border-slate-400' : 'border-slate-200 hover:border-slate-400'}`}>
                      <div className="truncate font-medium">{p.task}</div>
                      <div
                        className={`mt-0.5 flex flex-wrap gap-1 text-[10px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                        <span>{new Date(p.cachedAt).toLocaleTimeString()}</span>
                        {p.sessionStatus && (
                          <span
                            className={
                              p.sessionStatus === 'completed'
                                ? 'text-green-500'
                                : p.sessionStatus === 'failed'
                                  ? 'text-red-500'
                                  : 'text-yellow-500'
                            }>
                            {p.sessionStatus}
                          </span>
                        )}
                        <span>{p.steps.length}步</span>
                      </div>
                    </button>
                  );
                })}
                {plans.length === 0 && (
                  <div className={`text-center text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>暂无</div>
                )}
              </div>
              {activePlanId && (
                <button
                  onClick={() => removePlan(activePlanId)}
                  className={`mt-2 w-full rounded bg-red-600/80 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-600`}>
                  删除当前
                </button>
              )}
              {plans.length > 0 && (
                <button
                  onClick={clearCachedPlan}
                  className={`mt-2 w-full rounded bg-red-800/60 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-800`}>
                  清空全部
                </button>
              )}
            </div>
          </div>
          <div className="space-y-3 md:col-span-8">
            <div className={`${cardBase(isDarkMode)} space-y-1 p-4`}>
              <div className={`font-medium ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>{activePlan.task}</div>
              <div className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                源 Session: {activePlan.sourceSessionId}
              </div>
              <div className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                创建时间: {new Date(activePlan.cachedAt).toLocaleString()}
              </div>
              {typeof activePlan.durationMs === 'number' && (
                <div className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  原始耗时: {(activePlan.durationMs / 1000).toFixed(2)}s
                </div>
              )}
              {activePlan.sessionStatus && (
                <div className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  原始状态:{' '}
                  <span
                    className={
                      activePlan.sessionStatus === 'completed'
                        ? 'text-green-500'
                        : activePlan.sessionStatus === 'failed'
                          ? 'text-red-500'
                          : 'text-yellow-500'
                    }>
                    {activePlan.sessionStatus}
                  </span>
                </div>
              )}
              <div className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                步骤数: {activePlan.steps.length}
              </div>
              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  onClick={executeCachedPlan}
                  disabled={executing === 'running'}
                  className={`rounded-md px-3 py-1 text-xs font-medium ${executing === 'running' ? 'cursor-not-allowed opacity-60' : 'hover:opacity-90'} ${isDarkMode ? 'bg-blue-600 text-white' : 'bg-blue-500 text-white'}`}>
                  执行缓存计划
                </button>
                {executing !== 'idle' && (
                  <span
                    className={`self-center text-xs ${executing === 'success' ? 'text-green-500' : executing === 'failed' ? 'text-red-500' : executing === 'running' ? 'text-yellow-500' : 'text-gray-400'}`}>
                    {executing === 'running'
                      ? '执行中...'
                      : executing === 'success'
                        ? '执行成功'
                        : executing === 'failed'
                          ? '执行失败'
                          : executing === 'cleared'
                            ? '已清除'
                            : ''}
                  </span>
                )}
              </div>
            </div>
            <div className="space-y-3">
              {activePlan.steps.map(step => (
                <CacheStep
                  key={step.index}
                  step={step}
                  isDarkMode={isDarkMode}
                  progress={progress}
                  replanItems={replanDebug.filter(r => r.step === step.index)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const prettyMaybe = (raw?: string) => {
    if (!raw) return undefined;
    try {
      const obj = JSON.parse(raw);
      return JSON.stringify(obj, null, 2);
    } catch {
      return raw;
    }
  };

  const CacheStep: React.FC<{
    step: CachedPlanStep;
    isDarkMode: boolean;
    progress?: { runningStep?: number; failedStep?: number; error?: string };
    replanItems?: {
      step: number;
      attempt: number;
      request: { system: string; user: string };
      raw: unknown;
      parsed?: unknown;
      error?: string;
    }[];
  }> = ({ step, isDarkMode, progress, replanItems }) => {
    const [expanded, setExpanded] = useState(false);
    const [showReplan, setShowReplan] = useState(true);
    const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => undefined);
    const plannerPretty = prettyMaybe(step.plannerOutput);
    const navigatorPretty = prettyMaybe(step.navigatorOutput);
    const isRunning = progress?.runningStep === step.index;
    const isFailed = progress?.failedStep === step.index;
    return (
      <div
        className={`${cardBase(isDarkMode)} relative p-3 shadow-sm ${isDarkMode ? 'border-slate-600 bg-gradient-to-br from-slate-800 to-slate-900' : 'border-slate-200 bg-white'} ${isFailed ? 'border-red-500 ring-1 ring-red-500/60' : isRunning ? 'border-blue-500 ring-1 ring-blue-500/40' : ''}`}>
        {isFailed && progress?.error && (
          <div className="absolute -top-2 right-2 rounded bg-red-600 px-2 py-0.5 text-[10px] font-medium text-white shadow">
            失败: {progress.error}
          </div>
        )}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div
            className={`flex items-center gap-2 text-sm font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
            <span className="inline-flex items-center rounded bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-500">
              Step {step.index}
            </span>
            {isRunning && (
              <span className="inline-flex animate-pulse items-center rounded bg-blue-500/20 px-2 py-0.5 text-[10px] text-blue-400">
                运行中
              </span>
            )}
            {isFailed && (
              <span className="inline-flex items-center rounded bg-red-500/20 px-2 py-0.5 text-[10px] text-red-400">
                执行失败
              </span>
            )}
            {step.actions.length > 0 && (
              <span className="inline-flex items-center rounded bg-purple-500/10 px-2 py-0.5 text-[11px] font-medium text-purple-500">
                {step.actions.length} action{step.actions.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {(step.plannerOutput || step.navigatorOutput) && (
              <button
                onClick={() => setExpanded(e => !e)}
                className={`rounded px-2 py-0.5 text-xs ${isDarkMode ? 'bg-slate-700 text-gray-200' : 'bg-gray-200 text-gray-700'} hover:opacity-80`}>
                {expanded ? '折叠' : '展开'}
              </button>
            )}
          </div>
        </div>
        {expanded && step.plannerOutput && (
          <div className="mb-2">
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-green-500">
              <span>Planner Output</span>
              <button
                onClick={() => copy(step.plannerOutput!)}
                className="rounded bg-green-600/20 px-1 py-0.5 text-[10px] text-green-400 hover:bg-green-600/30">
                复制
              </button>
            </div>
            <pre
              className={`max-h-60 overflow-auto rounded-md border p-2 text-[11px] leading-snug ${isDarkMode ? 'border-slate-600 bg-slate-900/60 text-green-300' : 'border-slate-200 bg-slate-50 text-green-700'} whitespace-pre`}>
              {plannerPretty}
            </pre>
          </div>
        )}
        {expanded && step.navigatorOutput && (
          <div className="mb-2">
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-blue-500">
              <span>Navigator Output</span>
              <button
                onClick={() => copy(step.navigatorOutput!)}
                className="rounded bg-blue-600/20 px-1 py-0.5 text-[10px] text-blue-400 hover:bg-blue-600/30">
                复制
              </button>
            </div>
            <pre
              className={`max-h-60 overflow-auto rounded-md border p-2 text-[11px] leading-snug ${isDarkMode ? 'border-slate-600 bg-slate-900/60 text-blue-300' : 'border-slate-200 bg-slate-50 text-blue-700'} whitespace-pre`}>
              {navigatorPretty}
            </pre>
          </div>
        )}
        {expanded && replanItems && replanItems.length > 0 && (
          <div className="mb-2">
            <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-amber-500">
              <span>Replan Attempts ({replanItems.length})</span>
              <button
                onClick={() => setShowReplan(s => !s)}
                className="rounded bg-amber-600/20 px-1 py-0.5 text-[10px] text-amber-400 hover:bg-amber-600/30">
                {showReplan ? '隐藏' : '显示'}
              </button>
            </div>
            {showReplan && (
              <div className="space-y-2">
                {replanItems.map(item => {
                  const sysPretty = item.request.system.trim();
                  const userPretty = item.request.user.trim();
                  const rawStr = typeof item.raw === 'string' ? item.raw : JSON.stringify(item.raw, null, 2);
                  return (
                    <div
                      key={item.attempt}
                      className={`rounded border p-2 ${isDarkMode ? 'border-amber-800/50 bg-amber-900/20' : 'border-amber-200 bg-amber-50'}`}>
                      <div className="mb-1 flex justify-between text-[10px] font-medium text-amber-600 dark:text-amber-300">
                        <span>Attempt {item.attempt}</span>
                        {item.error && <span className="text-red-500">{item.error}</span>}
                      </div>
                      <details className="mb-1" open>
                        <summary className="cursor-pointer text-[11px] font-semibold">System Prompt</summary>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/10 p-1 text-[10px] leading-snug dark:bg-black/30">
                          {sysPretty}
                        </pre>
                      </details>
                      <details className="mb-1" open>
                        <summary className="cursor-pointer text-[11px] font-semibold">User Message</summary>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/10 p-1 text-[10px] leading-snug dark:bg-black/30">
                          {userPretty}
                        </pre>
                      </details>
                      <details open>
                        <summary className="cursor-pointer text-[11px] font-semibold">LLM Raw Output</summary>
                        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/10 p-1 text-[10px] leading-snug dark:bg-black/30">
                          {rawStr}
                        </pre>
                      </details>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <ol className="mt-1 space-y-1">
          {step.actions.map((a, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1 text-[11px]">
              <span
                className={`inline-flex rounded px-1.5 py-0.5 font-mono ${a.type === 'unknown' ? (isDarkMode ? 'bg-slate-700 text-slate-300' : 'bg-slate-200 text-slate-600') : isDarkMode ? 'bg-indigo-600/20 text-indigo-300' : 'bg-indigo-100 text-indigo-700'}`}>
                {a.type}
              </span>
              {a.success === true && <span className="rounded bg-green-500/15 px-1 py-0.5 text-green-500">OK</span>}
              {a.success === false && <span className="rounded bg-red-500/15 px-1 py-0.5 text-red-500">ERR</span>}
              {a.url && (
                <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-emerald-600 dark:text-emerald-300">
                  url={a.url}
                </span>
              )}
              {a.selector && (
                <span className="rounded bg-pink-500/10 px-1 py-0.5 text-pink-600 dark:text-pink-300">
                  sel={a.selector}
                </span>
              )}
              {a.text && (
                <span className="rounded bg-amber-500/10 px-1 py-0.5 text-amber-600 dark:text-amber-300">
                  text=&quot;{a.text}&quot;
                </span>
              )}
              {a.keys && (
                <span className="rounded bg-teal-500/10 px-1 py-0.5 text-teal-600 dark:text-teal-300">
                  keys={a.keys}
                </span>
              )}
              {typeof a.index === 'number' && (
                <span className="rounded bg-gray-500/10 px-1 py-0.5 text-gray-500 dark:text-gray-300">
                  idx={a.index}
                </span>
              )}
              {a.success === false && a.error && (
                <span className="max-w-[180px] truncate rounded bg-red-500/10 px-1 py-0.5 text-red-400" title={a.error}>
                  {a.error}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    );
  };

  if (loading)
    return (
      <div
        className={`flex h-full items-center justify-center ${isDarkMode ? 'bg-slate-900 text-white' : 'bg-white text-gray-900'}`}>
        <div className="text-center">
          <FiActivity className="mx-auto mb-2 size-8 animate-spin text-gray-400" />
          <div className={isDarkMode ? 'text-gray-400' : 'text-gray-500'}>加载中...</div>
        </div>
      </div>
    );

  return (
    <div className={`h-full overflow-auto ${isDarkMode ? 'bg-slate-900 text-white' : 'bg-white text-gray-900'}`}>
      <div className="px-4 pb-4">{renderCache()}</div>
    </div>
  );
};

export default SessionViewer;
