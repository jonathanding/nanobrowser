import { createLogger } from '@src/background/log';
import type { CachedPlan, CachedAction } from './types';
import type BrowserContext from '../../browser/context';
import type Page from '../../browser/page';

const logger = createLogger('CachedPlanExecutor');

export class CachedPlanExecutor {
  constructor(private browserContext: BrowserContext) {}

  async run(plan: CachedPlan): Promise<boolean> {
    logger.info(`Running cached plan from session ${plan.sourceSessionId} with ${plan.steps.length} steps`);
    for (const step of plan.steps) {
      logger.info(`Step ${step.index} with ${step.actions.length} actions`);
      for (const action of step.actions) {
        const ok = await this.executeAction(action);
        if (!ok) {
          logger.error(`Action failed, aborting cached plan. Type=${action.type}`);
          return false;
        }
      }
    }
    logger.info('Cached plan executed successfully');
    return true;
  }

  private async executeAction(action: CachedAction): Promise<boolean> {
    try {
      switch (action.type) {
        case 'navigate':
          if (action.url) {
            await this.browserContext.navigateTo(action.url);
            return true;
          }
          return false;
        case 'click':
        case 'input': {
          if (!action.selector) return false;
          const page: Page = await this.browserContext.getCurrentPage();
          // attempt puppeteer direct interaction if attached
          if (page.attached) {
            try {
              await page.attachPuppeteer();
              if (action.type === 'click') {
                // reuse simple DOM evaluate via existing puppeteer page
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const puppeteerPage: any = (page as unknown as { _puppeteerPage?: any })._puppeteerPage;
                if (puppeteerPage) {
                  await puppeteerPage.evaluate((sel: string) => {
                    const el = document.querySelector(sel) as HTMLElement | null;
                    if (!el) throw new Error('Element not found');
                    el.click();
                  }, action.selector);
                  return true;
                }
              } else if (action.type === 'input') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const puppeteerPage: any = (page as unknown as { _puppeteerPage?: any })._puppeteerPage;
                if (puppeteerPage) {
                  await puppeteerPage.evaluate(
                    (sel: string, value: string) => {
                      const el = document.querySelector(sel) as
                        | HTMLInputElement
                        | HTMLTextAreaElement
                        | HTMLElement
                        | null;
                      if (!el) throw new Error('Element not found');
                      if ('value' in el) {
                        (el as HTMLInputElement).value = value || '';
                      } else {
                        el.textContent = value || '';
                      }
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                    },
                    action.selector,
                    action.text || '',
                  );
                  return true;
                }
              }
            } catch (e) {
              logger.info('Puppeteer interaction failed, falling back to message-based action', e);
            }
          }
          // Fallback: not implemented for non-attached pages in MVP
          return false;
        }
        default:
          logger.info(`Unsupported cached action type (ignored): ${action.type}`);
          return true; // ignore unknown types for MVP
      }
    } catch (e) {
      logger.error('Cached action execution error', e);
      return false;
    }
  }
}
