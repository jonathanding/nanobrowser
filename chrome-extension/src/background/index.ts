import 'webextension-polyfill';
import {
  agentModelStore,
  AgentNameEnum,
  firewallStore,
  generalSettingsStore,
  llmProviderStore,
} from '@extension/storage';
import BrowserContext from './browser/context';
import { Executor } from './agent/executor';
import { createLogger } from './log';
import { ExecutionState } from './agent/event/types';
import { createChatModel } from './agent/helper';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { DEFAULT_AGENT_OPTIONS } from './agent/types';
import { SpeechToTextService } from './services/speechToText';
import { injectBuildDomTreeScripts } from './browser/dom/service';

const logger = createLogger('background');

const browserContext = new BrowserContext({});
let currentExecutor: Executor | null = null;
let currentPort: chrome.runtime.Port | null = null;

// Setup side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => console.error(error));

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId && changeInfo.status === 'complete' && tab.url?.startsWith('http')) {
    await injectBuildDomTreeScripts(tabId);
  }
});

// Listen for debugger detached event
// if canceled_by_user, remove the tab from the browser context
chrome.debugger.onDetach.addListener(async (source, reason) => {
  console.log('Debugger detached:', source, reason);
  if (reason === 'canceled_by_user') {
    if (source.tabId) {
      currentExecutor?.cancel();
      await browserContext.cleanup();
    }
  }
});

// Cleanup when tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
  browserContext.removeAttachedPage(tabId);
});

logger.info('background loaded');

// Listen for simple messages (e.g., from options page)
chrome.runtime.onMessage.addListener(() => {
  // Handle other message types if needed in the future
  // Return false if response is not sent asynchronously
  // return false;
});

// Setup connection listener for long-lived connections (e.g., side panel)
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'side-panel-connection') {
    currentPort = port;

    port.onMessage.addListener(async message => {
      try {
        switch (message.type) {
          case 'heartbeat':
            // Acknowledge heartbeat
            port.postMessage({ type: 'heartbeat_ack' });
            break;

          case 'new_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: 'No task provided' });
            if (!message.tabId) return port.postMessage({ type: 'error', error: 'No tab ID provided' });

            logger.info('new_task', message.tabId, message.task);
            currentExecutor = await setupExecutor(message.taskId, message.task, browserContext);
            subscribeToExecutorEvents(currentExecutor);

            const result = await currentExecutor.execute();
            logger.info('new_task execution result', message.tabId, result);
            break;
          }

          case 'follow_up_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: 'No follow up task provided' });
            if (!message.tabId) return port.postMessage({ type: 'error', error: 'No tab ID provided' });

            logger.info('follow_up_task', message.tabId, message.task);

            // If executor exists, add follow-up task
            if (currentExecutor) {
              currentExecutor.addFollowUpTask(message.task);
              // Re-subscribe to events in case the previous subscription was cleaned up
              subscribeToExecutorEvents(currentExecutor);
              const result = await currentExecutor.execute();
              logger.info('follow_up_task execution result', message.tabId, result);
            } else {
              // executor was cleaned up, can not add follow-up task
              logger.info('follow_up_task: executor was cleaned up, can not add follow-up task');
              return port.postMessage({ type: 'error', error: 'Executor was cleaned up, can not add follow-up task' });
            }
            break;
          }

          case 'cancel_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: 'No task to cancel' });
            await currentExecutor.cancel();
            break;
          }

          case 'resume_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: 'No task to resume' });
            await currentExecutor.resume();
            return port.postMessage({ type: 'success' });
          }

          case 'pause_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: 'No task to pause' });
            await currentExecutor.pause();
            return port.postMessage({ type: 'success' });
          }

          case 'screenshot': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: 'No tab ID provided' });
            const page = await browserContext.switchTab(message.tabId);
            const screenshot = await page.takeScreenshot();
            logger.info('screenshot', message.tabId, screenshot);
            return port.postMessage({ type: 'success', screenshot });
          }

          case 'state': {
            try {
              const browserState = await browserContext.getState(true);
              const elementsText = browserState.elementTree.clickableElementsToString(
                DEFAULT_AGENT_OPTIONS.includeAttributes,
              );

              logger.info('state', browserState);
              logger.info('interactive elements', elementsText);
              return port.postMessage({ type: 'success', msg: 'State printed to console' });
            } catch (error) {
              logger.error('Failed to get state:', error);
              return port.postMessage({ type: 'error', error: 'Failed to get state' });
            }
          }

          case 'nohighlight': {
            const page = await browserContext.getCurrentPage();
            await page.removeHighlight();
            return port.postMessage({ type: 'success', msg: 'highlight removed' });
          }

          case 'speech_to_text': {
            try {
              if (!message.audio) {
                return port.postMessage({
                  type: 'speech_to_text_error',
                  error: 'No audio data provided',
                });
              }

              logger.info('Processing speech-to-text request...');

              // Get all providers for speech-to-text service
              const providers = await llmProviderStore.getAllProviders();

              // Create speech-to-text service with all providers
              const speechToTextService = await SpeechToTextService.create(providers);

              // Extract base64 audio data (remove data URL prefix if present)
              let base64Audio = message.audio;
              if (base64Audio.startsWith('data:')) {
                base64Audio = base64Audio.split(',')[1];
              }

              // Transcribe audio
              const transcribedText = await speechToTextService.transcribeAudio(base64Audio);

              logger.info('Speech-to-text completed successfully');
              return port.postMessage({
                type: 'speech_to_text_result',
                text: transcribedText,
              });
            } catch (error) {
              logger.error('Speech-to-text failed:', error);
              return port.postMessage({
                type: 'speech_to_text_error',
                error: error instanceof Error ? error.message : 'Speech recognition failed',
              });
            }
          }

          case 'replay': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: 'No tab ID provided' });
            if (!message.taskId) return port.postMessage({ type: 'error', error: 'No task ID provided' });
            if (!message.historySessionId)
              return port.postMessage({ type: 'error', error: 'No history session ID provided' });
            logger.info('replay', message.tabId, message.taskId, message.historySessionId);

            try {
              // Switch to the specified tab
              await browserContext.switchTab(message.tabId);
              // Setup executor with the new taskId and a dummy task description
              currentExecutor = await setupExecutor(message.taskId, message.task, browserContext);
              subscribeToExecutorEvents(currentExecutor);

              // Run replayHistory with the history session ID
              const result = await currentExecutor.replayHistory(message.historySessionId);
              logger.debug('replay execution result', message.tabId, result);
            } catch (error) {
              logger.error('Replay failed:', error);
              return port.postMessage({
                type: 'error',
                error: error instanceof Error ? error.message : 'Replay failed',
              });
            }
            break;
          }

          case 'execute_cached_plan': {
            try {
              const { PlanCacheStore } = await import('./agent/plan_cache/store');
              let plan = await PlanCacheStore.loadLatest();
              if (!plan) return port.postMessage({ type: 'error', error: 'No cached plan available' });
              if (!message.tabId) return port.postMessage({ type: 'error', error: 'No tab ID provided' });
              // Optional updated task flow
              if (message.newTask && typeof message.newTask === 'string' && message.newTask.trim().length > 0) {
                try {
                  const startUpdate = Date.now();
                  const { agentModelStore, llmProviderStore, AgentNameEnum } = await import('@extension/storage');
                  const { planUpdaterSystemPromptTemplate } = await import('./agent/prompts/templates/plan_updater');
                  const agentModels = await agentModelStore.getAllAgentModels();
                  const updaterModel = agentModels[AgentNameEnum.PlanUpdater];
                  if (!updaterModel) {
                    port.postMessage({ type: 'plan_update_result', status: 'skipped', reason: 'no_model' });
                  } else {
                    const providers = await llmProviderStore.getAllProviders();
                    const providerCfg = providers[updaterModel.provider];
                    if (!providerCfg) {
                      port.postMessage({ type: 'plan_update_result', status: 'skipped', reason: 'provider_missing' });
                    } else {
                      const { createChatModel } = await import('./agent/helper');
                      const chat = createChatModel(providerCfg, updaterModel);
                      const system = planUpdaterSystemPromptTemplate;
                      const user = `<original_task>${plan.task}</original_task>\n<new_task>${message.newTask}</new_task>\n<cached_plan_json>${JSON.stringify(plan)}</cached_plan_json>`;
                      const resp = await chat.invoke([
                        { role: 'system', content: system },
                        { role: 'user', content: user },
                      ]);
                      let text = '';
                      if (typeof resp.content === 'string') text = resp.content;
                      else text = JSON.stringify(resp.content);
                      interface ParsedUpdatedAction {
                        type: string;
                        selector?: string;
                        text?: string;
                        url?: string;
                        keys?: string;
                        index?: number;
                        rawParams?: Record<string, unknown>;
                      }
                      interface ParsedUpdatedStep {
                        index?: number;
                        plannerOutput?: string;
                        navigatorOutput?: string;
                        actions?: ParsedUpdatedAction[];
                      }
                      interface ParsedPlanOk {
                        status: 'ok';
                        updated_task?: string;
                        plan: { steps: ParsedUpdatedStep[] };
                        change_summary?: string;
                      }
                      interface ParsedPlanReject {
                        status: 'reject';
                        reason: string;
                      }
                      type ParsedResult = ParsedPlanOk | ParsedPlanReject | Record<string, unknown>;
                      let parsed: ParsedResult | undefined;
                      try {
                        parsed = JSON.parse(text);
                      } catch {
                        /* ignore */
                      }
                      if (
                        parsed &&
                        (parsed as ParsedPlanOk).status === 'ok' &&
                        (parsed as ParsedPlanOk).plan &&
                        Array.isArray((parsed as ParsedPlanOk).plan.steps)
                      ) {
                        // Build new plan object
                        plan = {
                          ...plan,
                          task: (parsed as ParsedPlanOk).updated_task || message.newTask,
                          steps: (parsed as ParsedPlanOk).plan.steps.map((s, idx: number) => ({
                            index: typeof s.index === 'number' ? s.index : idx,
                            plannerOutput: s.plannerOutput,
                            navigatorOutput: s.navigatorOutput,
                            actions: (s.actions || []).map(a => ({
                              type: a.type,
                              selector: a.selector,
                              text: a.text,
                              url: a.url,
                              keys: a.keys,
                              index: a.index,
                              rawParams: a.rawParams,
                            })),
                          })),
                        };
                        port.postMessage({
                          type: 'plan_update_result',
                          status: 'ok',
                          durationMs: Date.now() - startUpdate,
                          changeSummary: (parsed as ParsedPlanOk).change_summary,
                        });
                      } else if (parsed && (parsed as ParsedPlanReject).status === 'reject') {
                        port.postMessage({
                          type: 'plan_update_result',
                          status: 'reject',
                          reason: (parsed as ParsedPlanReject).reason,
                        });
                        return; // abort replay
                      } else {
                        port.postMessage({
                          type: 'plan_update_result',
                          status: 'error',
                          reason: 'parse_failed',
                          raw: text,
                        });
                      }
                    }
                  }
                } catch (e) {
                  port.postMessage({
                    type: 'plan_update_result',
                    status: 'error',
                    reason: e instanceof Error ? e.message : 'update_failed',
                  });
                }
              }
              await browserContext.switchTab(message.tabId);
              const { ReplayCacheNavigator } = await import('./agent/plan_cache/replay_navigator');
              const replay = new ReplayCacheNavigator(browserContext, {
                delayMs: 400,
                enableLocalReplan: true,
                verbose: true,
              });
              // Forward replay internal events (including replan debug) to UI
              replay.onEvent(evt => {
                try {
                  port.postMessage({ type: 'agent_event', event: evt });
                } catch (fwdErr) {
                  logger.error('Failed forwarding replay event', fwdErr);
                }
              });
              port.postMessage({ type: 'cached_plan_status', status: 'running' });
              const ok = await replay.replay(plan, ev => {
                port.postMessage({ type: 'cached_plan_progress', event: ev });
              });
              port.postMessage({ type: 'cached_plan_status', status: ok ? 'success' : 'failed' });
            } catch (e) {
              logger.error('execute_cached_plan failed', e);
              port.postMessage({
                type: 'cached_plan_status',
                status: 'failed',
                error: e instanceof Error ? e.message : 'Unknown error',
              });
            }
            break;
          }

          case 'clear_cached_plan': {
            try {
              const { PlanCacheStore } = await import('./agent/plan_cache/store');
              await PlanCacheStore.clearAll();
              port.postMessage({ type: 'cached_plan_status', status: 'cleared' });
            } catch (e) {
              logger.error('clear_cached_plan failed', e);
              port.postMessage({ type: 'error', error: e instanceof Error ? e.message : 'Failed to clear cache' });
            }
            break;
          }

          case 'list_cached_plans': {
            try {
              const { PlanCacheStore } = await import('./agent/plan_cache/store');
              const plans = await PlanCacheStore.loadAll();
              port.postMessage({ type: 'cached_plan_list', plans });
            } catch (e) {
              logger.error('list_cached_plans failed', e);
              port.postMessage({
                type: 'error',
                error: e instanceof Error ? e.message : 'Failed to list cached plans',
              });
            }
            break;
          }

          case 'remove_cached_plan': {
            try {
              if (!message.planId) return port.postMessage({ type: 'error', error: 'No planId provided' });
              const { PlanCacheStore } = await import('./agent/plan_cache/store');
              await PlanCacheStore.remove(message.planId);
              const plans = await PlanCacheStore.loadAll();
              port.postMessage({ type: 'cached_plan_list', plans });
            } catch (e) {
              logger.error('remove_cached_plan failed', e);
              port.postMessage({
                type: 'error',
                error: e instanceof Error ? e.message : 'Failed to remove cached plan',
              });
            }
            break;
          }

          default:
            return port.postMessage({ type: 'error', error: 'Unknown message type' });
        }
      } catch (error) {
        console.error('Error handling port message:', error);
        port.postMessage({
          type: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    port.onDisconnect.addListener(() => {
      // this event is also triggered when the side panel is closed, so we need to cancel the task
      console.log('Side panel disconnected');
      currentPort = null;
      currentExecutor?.cancel();
    });
  }
});

async function setupExecutor(taskId: string, task: string, browserContext: BrowserContext) {
  const providers = await llmProviderStore.getAllProviders();
  // if no providers, need to display the options page
  if (Object.keys(providers).length === 0) {
    throw new Error('Please configure API keys in the settings first');
  }
  const agentModels = await agentModelStore.getAllAgentModels();
  // verify if every provider used in the agent models exists in the providers
  for (const agentModel of Object.values(agentModels)) {
    if (!providers[agentModel.provider]) {
      throw new Error(`Provider ${agentModel.provider} not found in the settings`);
    }
  }

  const navigatorModel = agentModels[AgentNameEnum.Navigator];
  if (!navigatorModel) {
    throw new Error('Please choose a model for the navigator in the settings first');
  }
  // Log the provider config being used for the navigator
  const navigatorProviderConfig = providers[navigatorModel.provider];
  const navigatorLLM = createChatModel(navigatorProviderConfig, navigatorModel);

  let plannerLLM: BaseChatModel | null = null;
  const plannerModel = agentModels[AgentNameEnum.Planner];
  if (plannerModel) {
    // Log the provider config being used for the planner
    const plannerProviderConfig = providers[plannerModel.provider];
    plannerLLM = createChatModel(plannerProviderConfig, plannerModel);
  }

  let validatorLLM: BaseChatModel | null = null;
  const validatorModel = agentModels[AgentNameEnum.Validator];
  if (validatorModel) {
    // Log the provider config being used for the validator
    const validatorProviderConfig = providers[validatorModel.provider];
    validatorLLM = createChatModel(validatorProviderConfig, validatorModel);
  }

  // Apply firewall settings to browser context
  const firewall = await firewallStore.getFirewall();
  if (firewall.enabled) {
    browserContext.updateConfig({
      allowedUrls: firewall.allowList,
      deniedUrls: firewall.denyList,
    });
  } else {
    browserContext.updateConfig({
      allowedUrls: [],
      deniedUrls: [],
    });
  }

  const generalSettings = await generalSettingsStore.getSettings();
  browserContext.updateConfig({
    minimumWaitPageLoadTime: generalSettings.minWaitPageLoad / 1000.0,
    displayHighlights: generalSettings.displayHighlights,
  });

  const executor = new Executor(task, taskId, browserContext, navigatorLLM, {
    plannerLLM: plannerLLM ?? navigatorLLM,
    validatorLLM: validatorLLM ?? navigatorLLM,
    agentOptions: {
      maxSteps: generalSettings.maxSteps,
      maxFailures: generalSettings.maxFailures,
      maxActionsPerStep: generalSettings.maxActionsPerStep,
      useVision: generalSettings.useVision,
      useVisionForPlanner: true,
      planningInterval: generalSettings.planningInterval,
    },
    generalSettings: generalSettings,
  });

  return executor;
}

// Update subscribeToExecutorEvents to use port
async function subscribeToExecutorEvents(executor: Executor) {
  // Clear previous event listeners to prevent multiple subscriptions
  executor.clearExecutionEvents();

  // Subscribe to new events
  executor.subscribeExecutionEvents(async event => {
    try {
      if (currentPort) {
        currentPort.postMessage(event);
      }
    } catch (error) {
      logger.error('Failed to send message to side panel:', error);
    }

    if (
      event.state === ExecutionState.TASK_OK ||
      event.state === ExecutionState.TASK_FAIL ||
      event.state === ExecutionState.TASK_CANCEL
    ) {
      await currentExecutor?.cleanup();
    }
  });
}
