// EdgeOne Edge Function 入口 — [[default]] catch-all 处理所有请求路径

import { createApp } from './routes';
import { runAggregation } from './aggregator';
import { DEFAULT_SPEED_TIMEOUT_MS, DEFAULT_SITE_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS } from './core/config';
import type { AppConfig } from './core/types';
import type { Storage } from './storage/interface';

// ─── EdgeOne KV Storage Adapter ──────────────────────────────
// EdgeOne KV 提供 put/get/delete/list，接口兼容 Cloudflare KVNamespace
class EdgeOneKVStorage implements Storage {
  constructor(private kv: any) {}
  async get(key: string): Promise<string | null> {
    return this.kv.get(key);
  }
  async put(key: string, value: string): Promise<void> {
    await this.kv.put(key, value);
  }
}

// ─── In-Memory Storage（KV 未绑定时的降级方案）───────────────
// 数据不持久化，仅用于开发/测试
class InMemoryStorage implements Storage {
  private data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
}

// ─── 配置构建 ────────────────────────────────────────────────
function buildConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    adminToken: env.ADMIN_TOKEN,
    refreshToken: env.REFRESH_TOKEN,
    speedTimeoutMs: parseInt(env.SPEED_TIMEOUT_MS || '') || DEFAULT_SPEED_TIMEOUT_MS,
    siteTimeoutMs: parseInt(env.SITE_TIMEOUT_MS || '') || DEFAULT_SITE_TIMEOUT_MS,
    fetchTimeoutMs: parseInt(env.FETCH_TIMEOUT_MS || '') || DEFAULT_FETCH_TIMEOUT_MS,
    // 设置 WORKER_BASE_URL 可启用 MacCMS 代理等边缘功能
    // 不设置时核心路由（/, /admin, /status, /refresh）仍正常工作
    workerBaseUrl: env.WORKER_BASE_URL || undefined,
  };
}

// ─── EdgeOne Handler ─────────────────────────────────────────
// [[default]] catch-all：拦截所有请求路径交给 Hono 路由处理
export default async function onRequest(context: any): Promise<Response> {
  const env: Record<string, any> = context.env || {};

  // ── Shim process.env ────────────────────────────────────
  // routes.ts 及部分模块引用 process.env（DMZ、VERBOSE 等）
  // 将 EdgeOne 环境变量合并进 process.env，保证兼容性
  try {
    if (typeof globalThis.process === 'undefined') {
      (globalThis as any).process = { env: {} };
    }
    const procEnv = (globalThis as any).process.env;
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string') {
        procEnv[k] = v;
      }
    }
  } catch { /* process.env 在某些运行时中可能不可写 */ }

  // ── Shim Cache API ──────────────────────────────────────
  // CF 专属路由使用 (caches as any).default；提供 no-op 降级
  if (typeof globalThis.caches === 'undefined') {
    (globalThis as any).caches = {
      default: {
        match: async () => null,
        put: async () => {},
        delete: async () => false,
      },
    };
  }

  // ── Storage ────────────────────────────────────────────
  // 绑定 KV 时使用 EdgeOneKVStorage；否则降级到内存存储
  const kvBinding = env.KV;
  const storage: Storage = kvBinding
    ? new EdgeOneKVStorage(kvBinding)
    : new InMemoryStorage();

  if (!kvBinding) {
    console.warn('[edge-entry] KV not bound — using in-memory storage (data will NOT persist)');
  }

  // ── Config ──────────────────────────────────────────────
  const config = buildConfig(env);

  // ── Create Hono app ────────────────────────────────────
  const app = createApp({
    storage,
    config,
    triggerRefresh: () => runAggregation(storage, config),
  });

  // ── ExecutionContext shim ───────────────────────────────
  // routes.ts 中 CF 专属路由使用 c.executionCtx.waitUntil
  const execCtx = {
    waitUntil: (promise: Promise<any>) => {
      try {
        if (context.waitUntil) {
          context.waitUntil(promise);
        } else {
          promise.catch?.(() => {});
        }
      } catch {
        promise.catch?.(() => {});
      }
    },
    passThroughOnException: () => {},
  };

  // ── Dispatch request through Hono ──────────────────────
  return app.fetch(context.request, env, execCtx);
}
