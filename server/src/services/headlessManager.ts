import { chromium, Browser, BrowserContext } from 'playwright';
import { HeadlessSession } from './headlessSession.js';
import { EventEmitter } from 'events';

export interface HeadlessConfig {
  maxConcurrent: number;      // Maximum concurrent headless instances
  idleTimeoutMs: number;      // Session idle timeout (default 30s)
  requestTimeoutMs: number;   // Request timeout (default 60s)
  queueMaxSize: number;       // Maximum queue size
  browserArgs: string[];      // Browser launch arguments
}

export interface QueuedRequest {
  id: string;
  opaqueId: string;
  targetUrl: string;
  userId: string;
  resolve: (session: HeadlessSession) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

export interface HeadlessMetrics {
  activeSessions: number;
  maxSessions: number;
  queueLength: number;
  queueMaxSize: number;
  totalSessionsCreated: number;
  totalSessionsCompleted: number;
  avgSpawnTimeMs: number;
}

const DEFAULT_CONFIG: HeadlessConfig = {
  maxConcurrent: parseInt(process.env.HEADLESS_MAX_CONCURRENT || '3', 10),
  idleTimeoutMs: parseInt(process.env.HEADLESS_IDLE_TIMEOUT_MS || '30000', 10),
  requestTimeoutMs: parseInt(process.env.HEADLESS_REQUEST_TIMEOUT_MS || '60000', 10),
  queueMaxSize: parseInt(process.env.HEADLESS_QUEUE_MAX_SIZE || '10', 10),
  browserArgs: [
    '--disable-gpu',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
  ]
};

export class HeadlessManager extends EventEmitter {
  private static instance: HeadlessManager | null = null;

  private activeSessions: Map<string, HeadlessSession> = new Map();
  private requestQueue: QueuedRequest[] = [];
  private config: HeadlessConfig;
  private browser: Browser | null = null;
  private isShuttingDown: boolean = false;

  // Metrics tracking
  private totalSessionsCreated: number = 0;
  private totalSessionsCompleted: number = 0;
  private spawnTimes: number[] = [];

  private constructor(config?: Partial<HeadlessConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Start idle session cleanup interval
    setInterval(() => this.checkIdleSessions(), 5000);
  }

  /**
   * Get singleton instance of HeadlessManager
   */
  static getInstance(config?: Partial<HeadlessConfig>): HeadlessManager {
    if (!HeadlessManager.instance) {
      HeadlessManager.instance = new HeadlessManager(config);
    }
    return HeadlessManager.instance;
  }

  /**
   * Initialize the browser instance
   */
  async initialize(): Promise<void> {
    if (this.browser) return;

    console.log('[HeadlessManager] Initializing browser...');

    this.browser = await chromium.launch({
      headless: true,
      args: this.config.browserArgs,
    });

    this.browser.on('disconnected', () => {
      console.log('[HeadlessManager] Browser disconnected');
      this.browser = null;
      // Clean up all sessions
      for (const session of this.activeSessions.values()) {
        session.close();
      }
      this.activeSessions.clear();
    });

    console.log('[HeadlessManager] Browser initialized');
  }

  /**
   * Acquire a headless session for a request
   */
  async acquireSession(
    opaqueId: string,
    targetUrl: string,
    userId: string,
    headlessTimeout?: number
  ): Promise<HeadlessSession> {
    if (this.isShuttingDown) {
      throw new Error('HeadlessManager is shutting down');
    }

    // Check if we can create a new session immediately
    if (this.activeSessions.size < this.config.maxConcurrent) {
      return this.createSession(opaqueId, targetUrl, userId, headlessTimeout);
    }

    // Check queue capacity
    if (this.requestQueue.length >= this.config.queueMaxSize) {
      throw new Error('Headless queue is full. Please try again later.');
    }

    // Queue the request
    return new Promise<HeadlessSession>((resolve, reject) => {
      const request: QueuedRequest = {
        id: `${opaqueId}-${Date.now()}`,
        opaqueId,
        targetUrl,
        userId,
        resolve,
        reject,
        timestamp: Date.now(),
      };

      this.requestQueue.push(request);
      console.log(`[HeadlessManager] Request queued. Queue length: ${this.requestQueue.length}`);

      // Set timeout for queued request
      setTimeout(() => {
        const index = this.requestQueue.findIndex(r => r.id === request.id);
        if (index !== -1) {
          this.requestQueue.splice(index, 1);
          reject(new Error('Queue timeout exceeded'));
        }
      }, this.config.requestTimeoutMs);
    });
  }

  /**
   * Create a new headless session
   */
  private async createSession(
    opaqueId: string,
    targetUrl: string,
    userId: string,
    headlessTimeout?: number
  ): Promise<HeadlessSession> {
    const startTime = Date.now();

    // Ensure browser is initialized
    await this.initialize();

    if (!this.browser) {
      throw new Error('Browser not available');
    }

    console.log(`[HeadlessManager] Creating session for ${opaqueId}`);

    // Create a new browser context for isolation
    const context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'Asia/Kolkata',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
      },
    });

    // Create session
    const sessionId = `${opaqueId}-${userId}-${Date.now()}`;
    const session = new HeadlessSession(
      sessionId,
      opaqueId,
      targetUrl,
      userId,
      context,
      headlessTimeout || this.config.requestTimeoutMs,
      this.config.idleTimeoutMs
    );

    // Track session
    this.activeSessions.set(sessionId, session);
    this.totalSessionsCreated++;

    // Record spawn time
    const spawnTime = Date.now() - startTime;
    this.spawnTimes.push(spawnTime);
    if (this.spawnTimes.length > 100) {
      this.spawnTimes.shift();
    }

    // Listen for session close
    session.on('close', () => {
      this.activeSessions.delete(sessionId);
      this.totalSessionsCompleted++;
      console.log(`[HeadlessManager] Session ${sessionId} closed. Active: ${this.activeSessions.size}`);
      this.processQueue();
    });

    console.log(`[HeadlessManager] Session created in ${spawnTime}ms. Active: ${this.activeSessions.size}`);

    return session;
  }

  /**
   * Release a session
   */
  async releaseSession(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      await session.close();
      this.activeSessions.delete(sessionId);
      this.processQueue();
    }
  }

  /**
   * Process queued requests
   */
  private async processQueue(): Promise<void> {
    if (this.requestQueue.length === 0) return;
    if (this.activeSessions.size >= this.config.maxConcurrent) return;

    const request = this.requestQueue.shift();
    if (!request) return;

    const queueWaitMs = Date.now() - request.timestamp;
    console.log(`[HeadlessManager] Processing queued request. Wait time: ${queueWaitMs}ms`);

    try {
      const session = await this.createSession(
        request.opaqueId,
        request.targetUrl,
        request.userId
      );
      session.queueWaitMs = queueWaitMs;
      request.resolve(session);
    } catch (error) {
      request.reject(error as Error);
    }
  }

  /**
   * Check for idle sessions and clean them up
   */
  private checkIdleSessions(): void {
    const now = Date.now();

    for (const session of this.activeSessions.values()) {
      if (session.isIdle(now)) {
        console.log(`[HeadlessManager] Closing idle session: ${session.id}`);
        session.close();
      }
    }
  }

  /**
   * Get current metrics
   */
  getMetrics(): HeadlessMetrics {
    const avgSpawnTime = this.spawnTimes.length > 0
      ? this.spawnTimes.reduce((a, b) => a + b, 0) / this.spawnTimes.length
      : 0;

    return {
      activeSessions: this.activeSessions.size,
      maxSessions: this.config.maxConcurrent,
      queueLength: this.requestQueue.length,
      queueMaxSize: this.config.queueMaxSize,
      totalSessionsCreated: this.totalSessionsCreated,
      totalSessionsCompleted: this.totalSessionsCompleted,
      avgSpawnTimeMs: Math.round(avgSpawnTime),
    };
  }

  /**
   * Get number of active sessions
   */
  getActiveCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Get queue length
   */
  getQueueLength(): number {
    return this.requestQueue.length;
  }

  /**
   * Get a specific session by ID
   */
  getSession(sessionId: string): HeadlessSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Find session by opaqueId and userId
   */
  findSession(opaqueId: string, userId: string): HeadlessSession | undefined {
    for (const session of this.activeSessions.values()) {
      if (session.opaqueId === opaqueId && session.userId === userId) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    console.log('[HeadlessManager] Shutting down...');
    this.isShuttingDown = true;

    // Reject all queued requests
    for (const request of this.requestQueue) {
      request.reject(new Error('HeadlessManager is shutting down'));
    }
    this.requestQueue = [];

    // Close all active sessions
    const closePromises = Array.from(this.activeSessions.values()).map(
      session => session.close()
    );
    await Promise.all(closePromises);
    this.activeSessions.clear();

    // Close browser
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }

    console.log('[HeadlessManager] Shutdown complete');
  }
}

// Export singleton getter
export const getHeadlessManager = () => HeadlessManager.getInstance();
