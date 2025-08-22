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
  const [newTaskDraft, setNewTaskDraft] = useState('');
  const [planUpdateStatus, setPlanUpdateStatus] = useState<
    | { status: 'idle' }
    | { status: 'skipped'; reason: string }
    | { status: 'ok'; durationMs: number; changeSummary?: string }
    | { status: 'reject'; reason: string }
    | { status: 'error'; reason: string }
  >({ status: 'idle' });
  const [planUpdateDebug, setPlanUpdateDebug] = useState<
    { kind: string; system?: string; user?: string; raw?: string; parsed?: unknown; latencyMs?: number }[]
  >([]);
  const [planDiff, setPlanDiff] = useState<null | {
    steps: Array<{
      index: number;
      status: 'unchanged' | 'modified' | 'added' | 'removed';
      prev?: CachedPlanStep;
      next?: CachedPlanStep;
      actionChanges?: Array<{
        idx: number;
        status: 'unchanged' | 'modified' | 'added' | 'removed';
        prevAction?: CachedAction;
        nextAction?: CachedAction;
        changedFields?: string[]; // e.g. ['type','url']
      }>;
    }>;
    summary: {
      addedSteps: number;
      removedSteps: number;
      modifiedSteps: number;
      unchangedSteps: number;
      addedActions: number;
      removedActions: number;
      modifiedActions: number;
    };
  }>(null);

  // Compute detailed diff helper
  const computePlanDiff = (prev: CachedPlan, next: CachedPlan) => {
    const maxSteps = Math.max(prev.steps.length, next.steps.length);
    const stepsDiff: Array<{
      index: number;
      status: 'unchanged' | 'modified' | 'added' | 'removed';
      prev?: CachedPlanStep;
      next?: CachedPlanStep;
      actionChanges?: Array<{
        idx: number;
        status: 'unchanged' | 'modified' | 'added' | 'removed';
        prevAction?: CachedAction;
        nextAction?: CachedAction;
        changedFields?: string[];
      }>;
    }> = [];
    let addedSteps = 0;
    let removedSteps = 0;
    let modifiedSteps = 0;
    let unchangedSteps = 0;
    let addedActions = 0;
    let removedActions = 0;
    let modifiedActions = 0;
    for (let i = 0; i < maxSteps; i++) {
      const prevStep = prev.steps[i];
      const nextStep = next.steps[i];
      if (prevStep && !nextStep) {
        removedSteps++;
        removedActions += prevStep.actions.length;
        stepsDiff.push({ index: prevStep.index, status: 'removed', prev: prevStep });
      } else if (!prevStep && nextStep) {
        addedSteps++;
        addedActions += nextStep.actions.length;
        stepsDiff.push({ index: nextStep.index, status: 'added', next: nextStep });
      } else if (prevStep && nextStep) {
        const actionChanges: Array<{
          idx: number;
          status: 'unchanged' | 'modified' | 'added' | 'removed';
          prevAction?: CachedAction;
          nextAction?: CachedAction;
          changedFields?: string[];
        }> = [];
        const maxActions = Math.max(prevStep.actions.length, nextStep.actions.length);
        let stepModified = false;
        for (let a = 0; a < maxActions; a++) {
          const pa = prevStep.actions[a];
          const na = nextStep.actions[a];
          if (pa && !na) {
            removedActions++;
            stepModified = true;
            actionChanges.push({ idx: a, status: 'removed', prevAction: pa });
          } else if (!pa && na) {
            addedActions++;
            stepModified = true;
            actionChanges.push({ idx: a, status: 'added', nextAction: na });
          } else if (pa && na) {
            const changedFields: string[] = [];
            (['type', 'url', 'text', 'selector', 'keys'] as const).forEach(f => {
              if ((pa as any)[f] !== (na as any)[f]) changedFields.push(f);
            });
            if (changedFields.length > 0) {
              modifiedActions++;
              stepModified = true;
              actionChanges.push({ idx: a, status: 'modified', prevAction: pa, nextAction: na, changedFields });
            } else {
              actionChanges.push({ idx: a, status: 'unchanged', prevAction: pa, nextAction: na });
            }
          }
        }
        if (
          stepModified ||
          prevStep.plannerOutput !== nextStep.plannerOutput ||
          prevStep.navigatorOutput !== nextStep.navigatorOutput
        ) {
          modifiedSteps++;
          stepsDiff.push({ index: nextStep.index, status: 'modified', prev: prevStep, next: nextStep, actionChanges });
        } else {
          unchangedSteps++;
          stepsDiff.push({ index: nextStep.index, status: 'unchanged', prev: prevStep, next: nextStep, actionChanges });
        }
      }
    }
    return {
      steps: stepsDiff,
      summary: {
        addedSteps,
        removedSteps,
        modifiedSteps,
        unchangedSteps,
        addedActions,
        removedActions,
        modifiedActions,
      },
    };
  };
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
      loading?: boolean; // waiting for LLM response
      durationMs?: number; // LLM latency
      failingAction?: string;
      triggerError?: string;
    }[]
  >([]);
  // Track which steps should auto expand (failed or replan active)
  const [autoExpandSteps, setAutoExpandSteps] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [stepDurations, setStepDurations] = useState<Record<number, number>>({});

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
    setPlanUpdateStatus({ status: 'idle' });
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) throw new Error('No active tab');
      const port = chrome.runtime.connect({ name: 'side-panel-connection' });
      port.postMessage({ type: 'execute_cached_plan', tabId, newTask: newTaskDraft.trim() || undefined });
      const replanAttemptPerStep: Record<number, number> = {};
      port.onMessage.addListener(msg => {
        if (msg.type === 'plan_update_result') {
          if (msg.status === 'ok')
            setPlanUpdateStatus({ status: 'ok', durationMs: msg.durationMs, changeSummary: msg.changeSummary });
          else if (msg.status === 'reject') setPlanUpdateStatus({ status: 'reject', reason: msg.reason });
          else if (msg.status === 'skipped') setPlanUpdateStatus({ status: 'skipped', reason: msg.reason });
          else if (msg.status === 'error') setPlanUpdateStatus({ status: 'error', reason: msg.reason });
          // Build diff if we have original & updated
          if (msg.status === 'ok' && msg.originalPlan && msg.updatedPlan) {
            try {
              setPlanDiff(computePlanDiff(msg.originalPlan, msg.updatedPlan));
            } catch (e) {
              console.error('diff failed', e);
            }
          } else if (msg.status !== 'ok') {
            setPlanDiff(null);
          }
        }
        if (msg.type === 'plan_update_debug') {
          setPlanUpdateDebug(list => [
            ...list,
            {
              kind: msg.kind,
              system: msg.system,
              user: msg.user,
              raw: msg.raw,
              parsed: msg.parsed,
              latencyMs: msg.latencyMs,
            },
          ]);
        }
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
          else if (ev.status === 'failed') {
            setProgress({ failedStep: ev.stepIndex, error: ev.error });
            setAutoExpandSteps(s => ({ ...s, [ev.stepIndex]: true }));
          }
        } else if (msg.type === 'agent_event' && msg.event?.data?.details) {
          const details = msg.event.data.details;
          try {
            const parsed = JSON.parse(details);
            if (parsed && typeof parsed.kind === 'string') {
              if (parsed.kind === 'replay_step_timing' && typeof parsed.step === 'number') {
                if (typeof parsed.duration_ms === 'number') {
                  setStepDurations(d => ({ ...d, [parsed.step]: parsed.duration_ms }));
                }
              }
              if (parsed.kind.startsWith('replay_local_replan')) {
                const stepIdx = msg.event.data.step ?? 0;
                if (parsed.kind === 'replay_local_replan_request') {
                  replanAttemptPerStep[stepIdx] = (replanAttemptPerStep[stepIdx] || 0) + 1;
                  setReplanDebug(list => [
                    ...list,
                    {
                      step: stepIdx,
                      attempt: replanAttemptPerStep[stepIdx],
                      request: parsed.request || { system: '', user: '' },
                      raw: undefined,
                      parsed: undefined,
                      error: undefined,
                      loading: true,
                      durationMs: undefined,
                      failingAction: parsed.failing_action,
                      triggerError: parsed.trigger_error,
                    },
                  ]);
                  setAutoExpandSteps(s => ({ ...s, [stepIdx]: true }));
                } else if (
                  parsed.kind === 'replay_local_replan' ||
                  parsed.kind === 'replay_local_replan_parse_fail' ||
                  parsed.kind === 'replay_local_replan_error' ||
                  parsed.kind === 'replay_local_replan_skipped'
                ) {
                  // Update the latest attempt for this step (loading -> complete)
                  setReplanDebug(list => {
                    const idx = [...list].reverse().findIndex(r => r.step === stepIdx && r.loading);
                    const realIndex = idx === -1 ? -1 : list.length - 1 - idx;
                    const rawVal = parsed.raw ?? parsed.reason ?? parsed.text ?? parsed;
                    if (realIndex >= 0) {
                      const updated = [...list];
                      const target = { ...updated[realIndex] };
                      target.raw = rawVal;
                      target.parsed = parsed.parsed;
                      target.error = parsed.error;
                      target.loading = false;
                      if (typeof parsed.duration_ms === 'number') target.durationMs = parsed.duration_ms;
                      if (parsed.failing_action) target.failingAction = parsed.failing_action;
                      if (parsed.trigger_error) target.triggerError = parsed.trigger_error;
                      updated[realIndex] = target;
                      return updated;
                    }
                    // fallback append
                    replanAttemptPerStep[stepIdx] = (replanAttemptPerStep[stepIdx] || 0) + 1;
                    return [
                      ...list,
                      {
                        step: stepIdx,
                        attempt: replanAttemptPerStep[stepIdx],
                        request: parsed.request || { system: '', user: '' },
                        raw: rawVal,
                        parsed: parsed.parsed,
                        error: parsed.error,
                        loading: false,
                        durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : undefined,
                        failingAction: parsed.failing_action,
                        triggerError: parsed.trigger_error,
                      },
                    ];
                  });
                }
              }
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
              <div className="space-y-2 pt-2">
                <label className="block text-xs font-medium opacity-80">
                  新任务（可选，需与原任务高度相似）
                  <input
                    value={newTaskDraft}
                    onChange={e => setNewTaskDraft(e.target.value)}
                    placeholder="例如：查看北京后天的天气"
                    className={`mt-1 w-full rounded border px-2 py-1 text-xs outline-none ${isDarkMode ? 'border-slate-600 bg-slate-800 text-gray-100' : 'border-slate-300 bg-white text-gray-800'}`}
                  />
                </label>
                {planUpdateStatus.status !== 'idle' && (
                  <div className="rounded border p-2 text-[11px] leading-snug shadow-sm ${isDarkMode ? 'border-slate-600 bg-slate-800' : 'border-slate-200 bg-slate-50'}">
                    {planUpdateStatus.status === 'skipped' && <div>Plan Updater 跳过: {planUpdateStatus.reason}</div>}
                    {planUpdateStatus.status === 'ok' && (
                      <div>
                        <div className="text-green-500">Plan 已更新 ({planUpdateStatus.durationMs}ms)</div>
                        {planUpdateStatus.changeSummary && (
                          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[10px] text-green-400">
                            {planUpdateStatus.changeSummary}
                          </pre>
                        )}
                        {planDiff && (
                          <details className="mt-2" open>
                            <summary className="cursor-pointer text-[11px] font-semibold text-green-400">
                              步骤差异 (Diff) - 概览
                            </summary>
                            <div className="mt-2 space-y-3">
                              <div
                                className={`flex flex-wrap gap-2 text-[10px] ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                                <span className="rounded bg-emerald-600/20 px-2 py-0.5 text-emerald-400">
                                  新增步骤 {planDiff.summary.addedSteps}
                                </span>
                                <span className="rounded bg-red-600/20 px-2 py-0.5 text-red-400">
                                  删除步骤 {planDiff.summary.removedSteps}
                                </span>
                                <span className="rounded bg-amber-600/20 px-2 py-0.5 text-amber-400">
                                  修改步骤 {planDiff.summary.modifiedSteps}
                                </span>
                                <span className="rounded bg-slate-600/20 px-2 py-0.5 text-slate-400">
                                  未变步骤 {planDiff.summary.unchangedSteps}
                                </span>
                                <span className="rounded bg-emerald-600/10 px-2 py-0.5 text-emerald-300">
                                  新增动作 {planDiff.summary.addedActions}
                                </span>
                                <span className="rounded bg-red-600/10 px-2 py-0.5 text-red-300">
                                  删除动作 {planDiff.summary.removedActions}
                                </span>
                                <span className="rounded bg-amber-600/10 px-2 py-0.5 text-amber-300">
                                  修改动作 {planDiff.summary.modifiedActions}
                                </span>
                              </div>
                              <div className="max-h-96 overflow-auto pr-1 space-y-2">
                                {planDiff.steps.map(s => (
                                  <details
                                    key={s.index + '-' + s.status}
                                    open={s.status !== 'unchanged'}
                                    className={`rounded border p-2 text-[10px] transition-colors ${
                                      s.status === 'added'
                                        ? 'border-emerald-500/40 bg-emerald-500/10'
                                        : s.status === 'removed'
                                          ? 'border-red-500/40 bg-red-500/10'
                                          : s.status === 'modified'
                                            ? 'border-amber-500/40 bg-amber-500/10'
                                            : isDarkMode
                                              ? 'border-slate-600 bg-slate-800'
                                              : 'border-slate-200 bg-slate-50'
                                    }`}>
                                    <summary className="flex cursor-pointer items-center justify-between">
                                      <span className="font-semibold">Step {s.index}</span>
                                      <span className="uppercase tracking-wide">
                                        {s.status === 'added'
                                          ? '新增'
                                          : s.status === 'removed'
                                            ? '删除'
                                            : s.status === 'modified'
                                              ? '修改'
                                              : '未变'}
                                      </span>
                                    </summary>
                                    <div className="mt-2 space-y-2">
                                      {s.status === 'removed' && s.prev && (
                                        <div className="rounded bg-red-500/10 p-2 text-red-300">
                                          该步骤已删除 (含 {s.prev.actions.length} 动作)
                                        </div>
                                      )}
                                      {s.status === 'added' && s.next && (
                                        <div className="rounded bg-emerald-500/10 p-2 text-emerald-300">
                                          新增步骤 (含 {s.next.actions.length} 动作)
                                        </div>
                                      )}
                                      {s.status !== 'removed' && s.next && s.prev && s.status === 'modified' && (
                                        <div className="grid gap-2 md:grid-cols-2">
                                          <div className="space-y-1">
                                            <div className="text-[10px] font-semibold text-slate-400">旧 (Prev)</div>
                                            <pre
                                              className={`max-h-40 overflow-auto rounded border p-2 ${isDarkMode ? 'border-slate-700 bg-slate-900/60 text-slate-300' : 'border-slate-300 bg-white text-slate-600'}`}>
                                              {prettyMaybe(s.prev.plannerOutput || '') || '(无 plannerOutput)'}
                                            </pre>
                                          </div>
                                          <div className="space-y-1">
                                            <div className="text-[10px] font-semibold text-slate-400">新 (Next)</div>
                                            <pre
                                              className={`max-h-40 overflow-auto rounded border p-2 ${isDarkMode ? 'border-slate-700 bg-slate-900/60 text-slate-300' : 'border-slate-300 bg-white text-slate-600'}`}>
                                              {prettyMaybe(s.next.plannerOutput || '') || '(无 plannerOutput)'}
                                            </pre>
                                          </div>
                                        </div>
                                      )}
                                      {s.status !== 'removed' && s.next && (
                                        <div>
                                          <div className="mb-1 text-[10px] font-semibold text-indigo-400">动作差异</div>
                                          {s.actionChanges && s.actionChanges.length > 0 ? (
                                            <table className="w-full table-fixed border-collapse overflow-hidden rounded text-[10px]">
                                              <thead>
                                                <tr
                                                  className={
                                                    isDarkMode
                                                      ? 'bg-slate-700 text-slate-200'
                                                      : 'bg-slate-200 text-slate-700'
                                                  }>
                                                  <th className="w-10 p-1 text-left">#</th>
                                                  <th className="w-16 p-1 text-left">状态</th>
                                                  <th className="w-24 p-1 text-left">类型</th>
                                                  <th className="p-1 text-left">字段变化</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {s.actionChanges.map(ac => (
                                                  <tr
                                                    key={ac.idx}
                                                    className={
                                                      isDarkMode
                                                        ? 'border-t border-slate-700'
                                                        : 'border-t border-slate-300'
                                                    }>
                                                    <td className="p-1 align-top">{ac.idx}</td>
                                                    <td className="p-1 align-top">
                                                      <span
                                                        className={`rounded px-1 py-0.5 font-mono ${
                                                          ac.status === 'added'
                                                            ? 'bg-emerald-600/30 text-emerald-300'
                                                            : ac.status === 'removed'
                                                              ? 'bg-red-600/30 text-red-300'
                                                              : ac.status === 'modified'
                                                                ? 'bg-amber-600/30 text-amber-300'
                                                                : 'bg-slate-500/30 text-slate-300'
                                                        }`}>
                                                        {ac.status}
                                                      </span>
                                                    </td>
                                                    <td className="p-1 align-top">
                                                      {ac.prevAction &&
                                                      ac.nextAction &&
                                                      ac.prevAction.type !== ac.nextAction.type ? (
                                                        <span className="font-mono">
                                                          {ac.prevAction.type} → {ac.nextAction.type}
                                                        </span>
                                                      ) : (
                                                        <span className="font-mono">
                                                          {ac.prevAction?.type || ac.nextAction?.type}
                                                        </span>
                                                      )}
                                                    </td>
                                                    <td className="p-1 align-top">
                                                      {ac.status === 'unchanged' && (
                                                        <span className="text-slate-500">无变化</span>
                                                      )}
                                                      {ac.status !== 'unchanged' &&
                                                        ac.changedFields &&
                                                        ac.changedFields.length === 0 &&
                                                        ac.status !== 'added' &&
                                                        ac.status !== 'removed' && (
                                                          <span className="text-slate-500">参数无差异</span>
                                                        )}
                                                      {ac.status === 'modified' &&
                                                        ac.changedFields &&
                                                        ac.changedFields.length > 0 && (
                                                          <div className="space-y-0.5">
                                                            {ac.changedFields.map(f => (
                                                              <div key={f} className="flex flex-wrap gap-1">
                                                                <span className="rounded bg-amber-500/30 px-1 py-0.5 font-mono text-amber-200">
                                                                  {f}
                                                                </span>
                                                                <span className="rounded bg-red-500/20 px-1 py-0.5 line-through opacity-80">
                                                                  {String((ac.prevAction as any)[f] ?? '') || '⌀'}
                                                                </span>
                                                                <span className="rounded bg-emerald-600/20 px-1 py-0.5">
                                                                  {String((ac.nextAction as any)[f] ?? '') || '⌀'}
                                                                </span>
                                                              </div>
                                                            ))}
                                                          </div>
                                                        )}
                                                      {ac.status === 'added' && ac.nextAction && (
                                                        <div className="flex flex-wrap gap-1">
                                                          {(['url', 'text', 'selector', 'keys'] as const)
                                                            .filter(k => (ac.nextAction as any)[k])
                                                            .map(k => (
                                                              <span
                                                                key={k}
                                                                className="rounded bg-emerald-600/20 px-1 py-0.5 font-mono text-emerald-300">
                                                                {k}:{String((ac.nextAction as any)[k])}
                                                              </span>
                                                            ))}
                                                        </div>
                                                      )}
                                                      {ac.status === 'removed' && ac.prevAction && (
                                                        <div className="flex flex-wrap gap-1">
                                                          {(['url', 'text', 'selector', 'keys'] as const)
                                                            .filter(k => (ac.prevAction as any)[k])
                                                            .map(k => (
                                                              <span
                                                                key={k}
                                                                className="rounded bg-red-600/20 px-1 py-0.5 font-mono text-red-300 line-through">
                                                                {k}:{String((ac.prevAction as any)[k])}
                                                              </span>
                                                            ))}
                                                        </div>
                                                      )}
                                                    </td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          ) : (
                                            <div className="text-slate-500">无动作变化</div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </details>
                                ))}
                              </div>
                            </div>
                          </details>
                        )}
                      </div>
                    )}
                    {planUpdateStatus.status === 'reject' && (
                      <div className="text-red-500">Plan 无法适配: {planUpdateStatus.reason}</div>
                    )}
                    {planUpdateStatus.status === 'error' && (
                      <div className="text-red-500">Plan 更新错误: {planUpdateStatus.reason}</div>
                    )}
                  </div>
                )}
                {planUpdateDebug.length > 0 && (
                  <details className="mt-2" open>
                    <summary className="cursor-pointer text-[11px] font-semibold text-blue-400">
                      Plan Update 调试
                    </summary>
                    <div className="mt-1 space-y-2">
                      {planUpdateDebug.map((d, i) => (
                        <div
                          key={i}
                          className={`rounded border p-2 ${isDarkMode ? 'border-slate-600 bg-slate-800' : 'border-slate-200 bg-white'}`}>
                          <div className="mb-1 flex items-center justify-between text-[10px]">
                            <span className="font-mono">{d.kind}</span>
                            {typeof d.latencyMs === 'number' && <span className="text-slate-400">{d.latencyMs}ms</span>}
                          </div>
                          {d.system && (
                            <details className="mb-1">
                              <summary className="cursor-pointer text-[10px] font-semibold text-green-500">
                                System
                              </summary>
                              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/10 p-1 text-[10px] leading-snug dark:bg-black/30">
                                {d.system}
                              </pre>
                            </details>
                          )}
                          {d.user && (
                            <details className="mb-1">
                              <summary className="cursor-pointer text-[10px] font-semibold text-amber-500">
                                User
                              </summary>
                              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/10 p-1 text-[10px] leading-snug dark:bg-black/30">
                                {d.user}
                              </pre>
                            </details>
                          )}
                          {d.raw && (
                            <details className="mb-1" open>
                              <summary className="cursor-pointer text-[10px] font-semibold text-blue-500">Raw</summary>
                              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/10 p-1 text-[10px] leading-snug dark:bg-black/30">
                                {d.raw}
                              </pre>
                            </details>
                          )}
                          {d.parsed !== undefined && (
                            <details>
                              <summary className="cursor-pointer text-[10px] font-semibold text-purple-500">
                                Parsed
                              </summary>
                              <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-black/10 p-1 text-[10px] leading-snug dark:bg-black/30">
                                {
                                  (() => {
                                    try {
                                      return JSON.stringify(d.parsed as unknown, null, 2);
                                    } catch {
                                      return String(d.parsed);
                                    }
                                  })() as string
                                }
                              </pre>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
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
                {planDiff && planUpdateStatus.status === 'ok' && (
                  <button
                    onClick={() => setPlanDiff(null)}
                    className={`rounded-md px-3 py-1 text-xs font-medium ${isDarkMode ? 'bg-slate-700 text-slate-200 hover:bg-slate-600' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'}`}>
                    隐藏Diff
                  </button>
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
      loading?: boolean;
      durationMs?: number;
      failingAction?: string;
      triggerError?: string;
    }[];
  }> = ({ step, isDarkMode, progress, replanItems }) => {
    const [expanded, setExpanded] = useState(() => !!autoExpandSteps[step.index]);
    // auto expand when flagged later
    useEffect(() => {
      if (autoExpandSteps[step.index]) setExpanded(true);
      // intentionally only depend on step.index to avoid lint false positive; state update triggered externally
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step.index]);
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
            {!isRunning && !isFailed && typeof (stepDurations as Record<number, number>)[step.index] === 'number' && (
              <span className="inline-flex items-center rounded bg-slate-500/20 px-2 py-0.5 text-[10px] text-slate-400">
                {(stepDurations as Record<number, number>)[step.index]}ms
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
                  let rawStr = '';
                  if (item.loading) {
                    rawStr = '⏳ 等待 LLM 响应...';
                  } else if (item.raw) {
                    // Extract content only; raw may be an object or string
                    let content: unknown = item.raw;
                    if (typeof item.raw === 'string') {
                      try {
                        const parsedVal: unknown = JSON.parse(item.raw);
                        if (
                          parsedVal &&
                          typeof parsedVal === 'object' &&
                          'content' in (parsedVal as Record<string, unknown>)
                        ) {
                          content = (parsedVal as Record<string, unknown>).content;
                        } else {
                          content = parsedVal;
                        }
                      } catch {
                        content = item.raw;
                      }
                    } else if (typeof item.raw === 'object' && item.raw) {
                      if ('content' in (item.raw as Record<string, unknown>)) {
                        content = (item.raw as Record<string, unknown>).content;
                      }
                    }
                    if (typeof content === 'string') {
                      // Try JSON pretty if it's JSON
                      let trimmed = content;
                      const maybeJson = content.trim();
                      if (
                        (maybeJson.startsWith('{') && maybeJson.endsWith('}')) ||
                        (maybeJson.startsWith('[') && maybeJson.endsWith(']'))
                      ) {
                        try {
                          const obj = JSON.parse(maybeJson);
                          trimmed = JSON.stringify(obj, null, 2);
                        } catch {
                          /* ignore */
                        }
                      }
                      rawStr = trimmed.length > 4000 ? trimmed.slice(0, 4000) + '\n... (trimmed)' : trimmed;
                    } else if (typeof content === 'object') {
                      try {
                        rawStr = JSON.stringify(content, null, 2);
                      } catch {
                        rawStr = String(content);
                      }
                    } else {
                      rawStr = String(content ?? '');
                    }
                  }
                  // Shorten extremely long noise
                  if (rawStr.length > 4000) rawStr = rawStr.slice(0, 4000) + '\n... (trimmed)';
                  return (
                    <div
                      key={item.attempt}
                      className={`rounded border p-2 ${isDarkMode ? 'border-amber-800/50 bg-amber-900/20' : 'border-amber-200 bg-amber-50'}`}>
                      <div className="mb-1 flex justify-between text-[10px] font-medium text-amber-600 dark:text-amber-300">
                        <span>Attempt {item.attempt}</span>
                        <span className="flex items-center gap-2">
                          {item.failingAction && <span className="text-amber-500">{item.failingAction}</span>}
                          {!item.loading && typeof item.durationMs === 'number' && (
                            <span className="text-amber-400">{item.durationMs}ms</span>
                          )}
                          {item.loading && <span className="animate-pulse text-amber-400">等待响应...</span>}
                          {!item.loading && item.error && <span className="text-red-500">{item.error}</span>}
                        </span>
                      </div>
                      {item.triggerError && (
                        <div className="mb-1 rounded bg-red-500/10 p-1 text-[10px] text-red-400">
                          触发错误: {item.triggerError}
                        </div>
                      )}
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
                        <summary className="cursor-pointer text-[11px] font-semibold">
                          LLM Content 输出
                          {!item.loading && typeof item.durationMs === 'number' ? ` (${item.durationMs}ms)` : ''}
                        </summary>
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
