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
}
interface CachedPlanStep {
  index: number;
  plannerOutput?: string;
  navigatorOutput?: string;
  actions: CachedAction[];
}
interface CachedPlan {
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
  const [cachedPlan, setCachedPlan] = useState<CachedPlan | null>(null);
  const [executing, setExecuting] = useState<'idle' | 'running' | 'success' | 'failed' | 'cleared'>('idle');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const result = await chrome.storage.local.get(['plan_cache_single']);
        if (result.plan_cache_single) setCachedPlan(result.plan_cache_single as CachedPlan);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Removed overview & session list per simplification request

  const executeCachedPlan = async () => {
    if (!cachedPlan) return;
    setExecuting('running');
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) throw new Error('No active tab');
      const port = chrome.runtime.connect({ name: 'side-panel-connection' });
      port.postMessage({ type: 'execute_cached_plan', tabId });
      port.onMessage.addListener(msg => {
        if (msg.type === 'cached_plan_status') {
          if (msg.status === 'running') setExecuting('running');
          else if (msg.status === 'success') setExecuting('success');
          else if (msg.status === 'failed') setExecuting('failed');
          else if (msg.status === 'cleared') setExecuting('cleared');
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
      setCachedPlan(null);
      setExecuting('cleared');
      setTimeout(() => setExecuting('idle'), 2000);
    } catch (e) {
      console.error(e);
    }
  };

  const renderCache = () => {
    if (!cachedPlan)
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
        <div className={`${cardBase(isDarkMode)} space-y-1 p-4`}>
          <div className={`font-medium ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>{cachedPlan.task}</div>
          <div className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            源 Session: {cachedPlan.sourceSessionId}
          </div>
          <div className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            创建时间: {new Date(cachedPlan.cachedAt).toLocaleString()}
          </div>
          {typeof cachedPlan.durationMs === 'number' && (
            <div className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              原始耗时: {(cachedPlan.durationMs / 1000).toFixed(2)}s
            </div>
          )}
          {cachedPlan.sessionStatus && (
            <div className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              原始状态: {cachedPlan.sessionStatus}
            </div>
          )}
          <div className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            步骤数: {cachedPlan.steps.length}
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              onClick={executeCachedPlan}
              disabled={executing === 'running'}
              className={`rounded-md px-3 py-1 text-xs font-medium ${executing === 'running' ? 'cursor-not-allowed opacity-60' : 'hover:opacity-90'} ${isDarkMode ? 'bg-blue-600 text-white' : 'bg-blue-500 text-white'}`}>
              执行缓存计划
            </button>
            <button
              onClick={clearCachedPlan}
              className={`rounded-md px-3 py-1 text-xs font-medium ${isDarkMode ? 'bg-red-600 text-white' : 'bg-red-500 text-white'} hover:opacity-90`}>
              清除
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
          {cachedPlan.steps.map(step => (
            <CacheStep key={step.index} step={step} isDarkMode={isDarkMode} />
          ))}
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

  const CacheStep: React.FC<{ step: CachedPlanStep; isDarkMode: boolean }> = ({ step, isDarkMode }) => {
    const [expanded, setExpanded] = useState(false);
    const copy = (text: string) => navigator.clipboard.writeText(text).catch(() => undefined);
    const plannerPretty = prettyMaybe(step.plannerOutput);
    const navigatorPretty = prettyMaybe(step.navigatorOutput);
    return (
      <div
        className={`${cardBase(isDarkMode)} p-3 shadow-sm ${isDarkMode ? 'border-slate-600 bg-gradient-to-br from-slate-800 to-slate-900' : 'border-slate-200 bg-white'}`}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div
            className={`flex items-center gap-2 text-sm font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
            <span className="inline-flex items-center rounded bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-500">
              Step {step.index}
            </span>
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
        <ol className="mt-1 space-y-1">
          {step.actions.map((a, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1 text-[11px]">
              <span
                className={`inline-flex rounded px-1.5 py-0.5 font-mono ${a.type === 'unknown' ? (isDarkMode ? 'bg-slate-700 text-slate-300' : 'bg-slate-200 text-slate-600') : isDarkMode ? 'bg-indigo-600/20 text-indigo-300' : 'bg-indigo-100 text-indigo-700'}`}>
                {a.type}
              </span>
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
