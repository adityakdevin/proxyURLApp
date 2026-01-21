import { BrowserContext, Page, Response } from 'playwright';
import { EventEmitter } from 'events';

export interface PageLoadResult {
  success: boolean;
  html?: string;
  title?: string;
  url?: string;
  status?: number;
  error?: string;
  ttfbMs?: number;
  domLoadMs?: number;
  cookies?: Array<{ name: string; value: string; domain: string; path: string }>;
}

export interface SessionMetrics {
  browserSpawnMs: number;
  queueWaitMs: number;
  pageLoadMs?: number;
  ttfbMs?: number;
  domLoadMs?: number;
}

export class HeadlessSession extends EventEmitter {
  public readonly id: string;
  public readonly opaqueId: string;
  public readonly targetUrl: string;
  public readonly userId: string;
  public queueWaitMs: number = 0;

  private context: BrowserContext;
  private page: Page | null = null;
  private requestTimeout: number;
  private idleTimeout: number;
  private lastActivityTime: number;
  private isClosed: boolean = false;
  private createdAt: number;

  // Metrics
  private ttfbMs?: number;
  private domLoadMs?: number;
  private browserSpawnMs: number = 0;

  constructor(
    id: string,
    opaqueId: string,
    targetUrl: string,
    userId: string,
    context: BrowserContext,
    requestTimeout: number,
    idleTimeout: number
  ) {
    super();
    this.id = id;
    this.opaqueId = opaqueId;
    this.targetUrl = targetUrl;
    this.userId = userId;
    this.context = context;
    this.requestTimeout = requestTimeout;
    this.idleTimeout = idleTimeout;
    this.lastActivityTime = Date.now();
    this.createdAt = Date.now();
  }

  /**
   * Load the target URL and return the rendered HTML
   */
  async loadPage(): Promise<PageLoadResult> {
    if (this.isClosed) {
      return { success: false, error: 'Session is closed' };
    }

    try {
      this.updateActivity();
      const startTime = Date.now();

      // Create new page if not exists
      if (!this.page) {
        this.page = await this.context.newPage();
        this.setupPageHandlers();
      }

      // Set request timeout
      this.page.setDefaultTimeout(this.requestTimeout);

      // Track TTFB
      let ttfbRecorded = false;
      const ttfbStart = Date.now();

      this.page.on('response', (response: Response) => {
        if (!ttfbRecorded && response.url() === this.targetUrl) {
          this.ttfbMs = Date.now() - ttfbStart;
          ttfbRecorded = true;
        }
      });

      // Navigate to the target URL
      console.log(`[HeadlessSession] Loading: ${this.targetUrl}`);

      const response = await this.page.goto(this.targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.requestTimeout,
      });

      this.domLoadMs = Date.now() - startTime;

      if (!response) {
        return { success: false, error: 'No response received' };
      }

      const status = response.status();

      // Check for error status codes
      if (status >= 400) {
        return {
          success: false,
          error: `HTTP ${status}: ${response.statusText()}`,
          status,
          ttfbMs: this.ttfbMs,
          domLoadMs: this.domLoadMs,
        };
      }

      // Wait for network to be mostly idle
      try {
        await this.page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch {
        // Network idle timeout is acceptable - page may have continuous requests
        console.log(`[HeadlessSession] Network idle timeout - continuing`);
      }

      // Get the rendered HTML
      const html = await this.page.content();
      const title = await this.page.title();
      const finalUrl = this.page.url();

      console.log(`[HeadlessSession] Page loaded in ${this.domLoadMs}ms`);

      // Extract cookies from browser context to share with direct proxy
      const browserCookies = await this.context.cookies();
      const cookies = browserCookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
      }));

      this.updateActivity();

      return {
        success: true,
        html,
        title,
        url: finalUrl,
        status,
        ttfbMs: this.ttfbMs,
        domLoadMs: this.domLoadMs,
        cookies,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[HeadlessSession] Load error: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
        ttfbMs: this.ttfbMs,
        domLoadMs: this.domLoadMs,
      };
    }
  }

  /**
   * Setup page event handlers
   */
  private setupPageHandlers(): void {
    if (!this.page) return;

    // Handle dialogs (alerts, confirms, prompts)
    this.page.on('dialog', async (dialog) => {
      console.log(`[HeadlessSession] Dialog: ${dialog.type()} - ${dialog.message()}`);
      await dialog.dismiss();
    });

    // Handle console messages
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[HeadlessSession] Console error: ${msg.text()}`);
      }
    });

    // Handle page crashes
    this.page.on('crash', () => {
      console.error(`[HeadlessSession] Page crashed`);
      this.emit('error', new Error('Page crashed'));
    });

    // Handle page close
    this.page.on('close', () => {
      console.log(`[HeadlessSession] Page closed`);
    });
  }

  /**
   * Take a screenshot of the current page
   */
  async screenshot(): Promise<Buffer | null> {
    if (!this.page || this.isClosed) return null;

    try {
      this.updateActivity();
      return await this.page.screenshot({ type: 'png', fullPage: false });
    } catch (error) {
      console.error(`[HeadlessSession] Screenshot error: ${error}`);
      return null;
    }
  }

  /**
   * Get the current page HTML
   */
  async getHtml(): Promise<string | null> {
    if (!this.page || this.isClosed) return null;

    try {
      this.updateActivity();
      return await this.page.content();
    } catch (error) {
      console.error(`[HeadlessSession] GetHtml error: ${error}`);
      return null;
    }
  }

  /**
   * Navigate to a new URL within the session
   */
  async navigate(url: string): Promise<PageLoadResult> {
    if (!this.page || this.isClosed) {
      return { success: false, error: 'Session is closed' };
    }

    try {
      this.updateActivity();
      const startTime = Date.now();

      const response = await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.requestTimeout,
      });

      const loadTime = Date.now() - startTime;

      if (!response) {
        return { success: false, error: 'No response received' };
      }

      const status = response.status();
      const html = await this.page.content();
      const title = await this.page.title();

      this.updateActivity();

      return {
        success: status < 400,
        html,
        title,
        url: this.page.url(),
        status,
        domLoadMs: loadTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Execute JavaScript in the page context
   */
  async evaluate<T>(script: string): Promise<T | null> {
    if (!this.page || this.isClosed) return null;

    try {
      this.updateActivity();
      return await this.page.evaluate(script) as T;
    } catch (error) {
      console.error(`[HeadlessSession] Evaluate error: ${error}`);
      return null;
    }
  }

  /**
   * Get session metrics
   */
  getMetrics(): SessionMetrics {
    return {
      browserSpawnMs: this.browserSpawnMs,
      queueWaitMs: this.queueWaitMs,
      pageLoadMs: this.domLoadMs,
      ttfbMs: this.ttfbMs,
      domLoadMs: this.domLoadMs,
    };
  }

  /**
   * Update last activity time
   */
  updateActivity(): void {
    this.lastActivityTime = Date.now();
  }

  /**
   * Check if session is idle
   */
  isIdle(now: number = Date.now()): boolean {
    return (now - this.lastActivityTime) > this.idleTimeout;
  }

  /**
   * Get session age in milliseconds
   */
  getAge(): number {
    return Date.now() - this.createdAt;
  }

  /**
   * Close the session
   */
  async close(): Promise<void> {
    if (this.isClosed) return;

    this.isClosed = true;
    console.log(`[HeadlessSession] Closing session ${this.id}`);

    try {
      if (this.page) {
        await this.page.close();
        this.page = null;
      }

      await this.context.close();
    } catch (error) {
      console.error(`[HeadlessSession] Close error: ${error}`);
    }

    this.emit('close');
  }

  /**
   * Check if session is closed
   */
  get closed(): boolean {
    return this.isClosed;
  }
}
