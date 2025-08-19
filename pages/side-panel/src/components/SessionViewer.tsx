import React, { useState, useEffect } from 'react';
import { FiActivity, FiCheckCircle, FiXCircle, FiTrendingUp } from 'react-icons/fi';

// Import types from the session system
interface SessionIndex {
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

interface SessionAnalytics {
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

interface SessionViewerProps {
  isDarkMode: boolean;
}

const SessionViewer: React.FC<SessionViewerProps> = ({ isDarkMode }) => {
  const [sessions, setSessions] = useState<SessionIndex[]>([]);
  const [analytics, setAnalytics] = useState<SessionAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'overview' | 'sessions'>('overview');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      // Load session list
      const result = await chrome.storage.local.get(['structured_sessions_index']);
      const sessionsList = result.structured_sessions_index || [];
      setSessions(sessionsList);

      // Calculate analytics
      if (sessionsList.length > 0) {
        const completedSessions = sessionsList.filter((s: SessionIndex) => s.status === 'completed');
        const successRate = completedSessions.length / sessionsList.length;
        const avgExecutionTime =
          sessionsList.reduce((sum: number, s: SessionIndex) => sum + s.duration, 0) / sessionsList.length;
        const avgSteps = sessionsList.reduce((sum: number, s: SessionIndex) => sum + s.steps, 0) / sessionsList.length;
        const avgActions =
          sessionsList.reduce((sum: number, s: SessionIndex) => sum + s.actions, 0) / sessionsList.length;
        const avgPhases =
          sessionsList.reduce((sum: number, s: SessionIndex) => sum + s.phases, 0) / sessionsList.length;

        setAnalytics({
          totalSessions: sessionsList.length,
          successRate,
          averageExecutionTime: Math.round(avgExecutionTime / 1000),
          averageStepsPerSession: Math.round(avgSteps * 10) / 10,
          averageActionsPerSession: Math.round(avgActions * 10) / 10,
          averagePhasesPerSession: Math.round(avgPhases * 10) / 10,
          commonErrors: [],
          actionTypeBreakdown: {},
          planningTriggerStats: {},
          recentSessions: sessionsList.slice(0, 10),
        });
      }
    } catch (error) {
      console.error('Error loading session data:', error);
    } finally {
      setLoading(false);
    }
  };

  const renderOverview = () => {
    if (!analytics) return null;

    return (
      <div className="space-y-6">
        <h2 className={`flex items-center gap-2 text-xl font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
          <FiTrendingUp />
          会话分析概览
        </h2>

        {/* 统计卡片 */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div
            className={`rounded-lg p-4 ${isDarkMode ? 'bg-blue-900/20 border border-blue-800' : 'bg-blue-50 border border-blue-200'}`}>
            <div className={`text-2xl font-bold ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>
              {analytics.totalSessions}
            </div>
            <div className={`text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>总会话数</div>
          </div>

          <div
            className={`rounded-lg p-4 ${isDarkMode ? 'bg-green-900/20 border border-green-800' : 'bg-green-50 border border-green-200'}`}>
            <div className={`text-2xl font-bold ${isDarkMode ? 'text-green-400' : 'text-green-600'}`}>
              {(analytics.successRate * 100).toFixed(1)}%
            </div>
            <div className={`text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>成功率</div>
          </div>

          <div
            className={`rounded-lg p-4 ${isDarkMode ? 'bg-purple-900/20 border border-purple-800' : 'bg-purple-50 border border-purple-200'}`}>
            <div className={`text-2xl font-bold ${isDarkMode ? 'text-purple-400' : 'text-purple-600'}`}>
              {analytics.averageExecutionTime}s
            </div>
            <div className={`text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>平均执行时间</div>
          </div>

          <div
            className={`rounded-lg p-4 ${isDarkMode ? 'bg-orange-900/20 border border-orange-800' : 'bg-orange-50 border border-orange-200'}`}>
            <div className={`text-2xl font-bold ${isDarkMode ? 'text-orange-400' : 'text-orange-600'}`}>
              {analytics.averageStepsPerSession}
            </div>
            <div className={`text-sm ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>平均步骤数</div>
          </div>
        </div>

        {/* 最近会话 */}
        <div>
          <h3 className={`mb-3 text-lg font-medium ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>最近会话</h3>
          {analytics.recentSessions.length === 0 ? (
            <div
              className={`rounded-lg p-6 text-center ${isDarkMode ? 'bg-gray-800 border border-gray-700' : 'bg-gray-50 border border-gray-200'}`}>
              <FiActivity className={`mx-auto mb-2 h-8 w-8 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`} />
              <p className={`${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>暂无会话记录</p>
            </div>
          ) : (
            <div className="space-y-2">
              {analytics.recentSessions.slice(0, 5).map(session => (
                <div
                  key={session.sessionId}
                  className={`flex items-center justify-between rounded-lg p-3 ${isDarkMode ? 'bg-gray-800 border border-gray-700' : 'bg-gray-50 border border-gray-200'}`}>
                  <div className="flex items-center gap-3">
                    {session.status === 'completed' ? (
                      <FiCheckCircle className="text-green-500" />
                    ) : session.status === 'failed' ? (
                      <FiXCircle className="text-red-500" />
                    ) : (
                      <FiActivity className="text-blue-500" />
                    )}
                    <div>
                      <div className={`text-sm font-medium ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
                        {session.task.length > 50 ? `${session.task.substring(0, 50)}...` : session.task}
                      </div>
                      <div className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                        {new Date(session.timestamp).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <div className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    {session.steps} 步骤
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderSessionList = () => (
    <div className="space-y-4">
      <h2 className={`flex items-center gap-2 text-xl font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
        <FiActivity />
        会话列表
      </h2>

      {sessions.length === 0 ? (
        <div
          className={`rounded-lg p-6 text-center ${isDarkMode ? 'bg-gray-800 border border-gray-700' : 'bg-gray-50 border border-gray-200'}`}>
          <FiActivity className={`mx-auto mb-2 h-8 w-8 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`} />
          <p className={`${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>暂无会话记录</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map(session => (
            <div
              key={session.sessionId}
              className={`flex items-center justify-between rounded-lg p-4 ${isDarkMode ? 'bg-gray-800 border border-gray-700' : 'bg-gray-50 border border-gray-200'}`}>
              <div className="flex items-center gap-3">
                {session.status === 'completed' ? (
                  <FiCheckCircle className="text-green-500" />
                ) : session.status === 'failed' ? (
                  <FiXCircle className="text-red-500" />
                ) : (
                  <FiActivity className="text-blue-500" />
                )}
                <div>
                  <div className={`font-medium ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>{session.task}</div>
                  <div className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    {new Date(session.timestamp).toLocaleString()} •{session.phases} 阶段 • {session.steps} 步骤 •{' '}
                    {session.actions} 操作
                  </div>
                </div>
              </div>
              <div className={`text-right text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                <div className="capitalize">{session.status}</div>
                <div>{(session.duration / 1000).toFixed(1)}s</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  if (loading) {
    return (
      <div
        className={`flex h-full items-center justify-center ${isDarkMode ? 'bg-slate-900 text-white' : 'bg-white text-gray-900'}`}>
        <div className="text-center">
          <FiActivity
            className={`mx-auto mb-2 h-8 w-8 animate-spin ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}
          />
          <div className={`${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>加载中...</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full overflow-auto ${isDarkMode ? 'bg-slate-900 text-white' : 'bg-white text-gray-900'}`}>
      {/* 导航栏 */}
      <div className={`flex border-b mb-4 ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
        <button
          onClick={() => setView('overview')}
          className={`px-4 py-2 text-sm font-medium ${
            view === 'overview'
              ? `border-b-2 border-blue-500 ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`
              : `${isDarkMode ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'}`
          }`}>
          概览
        </button>
        <button
          onClick={() => setView('sessions')}
          className={`px-4 py-2 text-sm font-medium ${
            view === 'sessions'
              ? `border-b-2 border-blue-500 ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`
              : `${isDarkMode ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'}`
          }`}>
          会话列表 ({sessions.length})
        </button>
      </div>

      {/* 内容区域 */}
      <div className="px-4 pb-4">
        {view === 'overview' && renderOverview()}
        {view === 'sessions' && renderSessionList()}
      </div>
    </div>
  );
};

export default SessionViewer;
