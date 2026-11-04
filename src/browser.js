import { chromium } from 'playwright';
import { PiuError } from './errors.js';

export const PIU_ORIGIN = 'https://www.piugame.com';
export const PUMBILITY_URL = PIU_ORIGIN + '/my_page/pumbility.php';
export const RECENT_URL = PIU_ORIGIN + '/my_page/recently_played.php';
export const PLAY_DATA_URL = PIU_ORIGIN + '/my_page/play_data.php';
export const TITLE_URL = PIU_ORIGIN + '/my_page/title.php';
const HOSTS = new Set(['piugame.com', 'www.piugame.com', 'api.am-pass.net', 'am-pass.net', 'www.am-pass.net']);
export function isOfficialUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.username && !url.password && (!url.port || url.port === '443');
  } catch { return false; }
}

export class BrowserManager {
  constructor(config = {}) { this.config = config; this.pending = null; }
  async browser() {
    if (!this.pending) {
      const launchOptions = { headless: this.config.headless ?? true, channel: this.config.channel, executablePath: this.config.executablePath };
      if (this.config.proxy) launchOptions.proxy = { server: this.config.proxy };
      this.pending = chromium.launch(launchOptions).catch(error => { this.pending = null; throw error; });
    }
    return this.pending;
  }
  async context(storageState) {
    const browser = await this.browser();
    const context = await browser.newContext({storageState, viewport: {width: 1024, height: 900},
      locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block'});
    context.setDefaultTimeout(12000);
    context.setDefaultNavigationTimeout(35000);
    await context.route('**/*', async route => {
      const value = route.request().url();
      if (isOfficialUrl(value) || /^(data:|blob:)/.test(value)) return route.continue();
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', route => route.close());
    // The relay operates one visible tab. Social-login popups are intentionally unsupported.
    context.on('page', page => {
      page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      page.on('download', download => download.cancel().catch(() => {}));
      if (context.pages().length > 1) page.close().catch(() => {});
    });
    return context;
  }
  async createLogin() {
    const context = await this.context();
    try {
      const page = await context.newPage();
      await page.goto(PUMBILITY_URL, {waitUntil: 'domcontentloaded'});
      return {context, page};
    } catch (error) {
      if (globalThis.logger?.error) globalThis.logger.error(`[PIU] 打开官网登录页失败: ${error?.stack || error?.message || error}`);
      await context.close();
      throw new PiuError('NETWORK', `无法打开 PIU 官网登录页（${error?.message || '网络连接超时'}），请检查服务器网络或代理。`);
    }
  }
  async close() {
    if (this.pending) { const browser = await this.pending.catch(() => null); this.pending = null; await browser?.close(); }
  }
}
