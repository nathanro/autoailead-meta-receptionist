import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');


/**
 * Official Meta Model API Pricing (verified Oct 26, 2026 at https://dev.meta.ai/docs/pricing-rate-limits)
 * All prices in USD.
 */
export const META_PRICING = {
  'muse-spark-1.3': {
    inputPer1M: 1.25,
    cachedInputPer1M: 0.15,
    outputPer1M: 4.25,
    webSearchPer1K: 2.50,
  },
  'muse-spark-1.2': {
    inputPer1M: 1.25,
    cachedInputPer1M: 0.15,
    outputPer1M: 4.25,
    webSearchPer1K: 2.50,
  },
  'muse-spark-1.1': {
    inputPer1M: 1.25,
    cachedInputPer1M: 0.15,
    outputPer1M: 4.25,
    webSearchPer1K: 2.50,
  },
  'muse-spark-1.3-contributor': {
    inputPer1M: 0.10,
    cachedInputPer1M: 0.002,
    outputPer1M: 0.20,
    webSearchPer1K: 2.50,
  },
  'muse-spark-1.2-contributor': {
    inputPer1M: 0.10,
    cachedInputPer1M: 0.002,
    outputPer1M: 0.20,
    webSearchPer1K: 2.50,
  },
  'muse-wonder-1.0': {
    inputPer1M: 4.00,
    cachedInputPer1M: 0.20,
    outputPer1M: 20.00,
    webSearchPer1K: 2.50,
  },
  'muse-image-1.0': {
    perImage: 0.01,
  },
  'muse-voice-transcribe-1.0': {
    perHourAudio: 0.18, // $0.003 per minute, $0.00005 per second (rounded down to whole seconds)
  },
  'sam-3.1': {
    per1KImages: 2.50, // $0.0025 per image
    per1KVideoFrames: 0.20, // min 50 frames per video request ($0.01 minimum for video)
  },
};

export function computeTokenCostUSD(model, usage = {}) {
  const spec = META_PRICING[model] || META_PRICING['muse-spark-1.3'];
  const totalInput = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const cachedInput = Number(
    usage.input_tokens_details?.cached_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      0
  );
  const uncachedInput = Math.max(0, totalInput - cachedInput);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);

  const cost =
    (uncachedInput / 1_000_000) * spec.inputPer1M +
    (cachedInput / 1_000_000) * spec.cachedInputPer1M +
    (outputTokens / 1_000_000) * spec.outputPer1M;
  return Number(cost.toFixed(8));
}

export function computeAudioCostUSD(durationMs = 0) {
  // Billed for audio processed, rounded down to whole seconds at $0.18/hour
  const wholeSeconds = Math.max(1, Math.floor(Number(durationMs) / 1000));
  const cost = (wholeSeconds / 3600) * META_PRICING['muse-voice-transcribe-1.0'].perHourAudio;
  return Number(cost.toFixed(8));
}

export function computeSamCostUSD({ images = 1, videoFrames = 0 } = {}) {
  if (videoFrames > 0) {
    const billedFrames = Math.max(50, videoFrames);
    return Number(((billedFrames / 1000) * META_PRICING['sam-3.1'].per1KVideoFrames).toFixed(8));
  }
  return Number(((images / 1000) * META_PRICING['sam-3.1'].per1KImages).toFixed(8));
}

export function computeImageCostUSD(count = 1) {
  return Number((count * META_PRICING['muse-image-1.0'].perImage).toFixed(8));
}

export function hashRequestKey(parts) {
  const raw = typeof parts === 'string' ? parts : JSON.stringify(parts);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export class SpendGuardrails {
  constructor(options = {}) {
    this.dataDir = options.dataDir || DATA_DIR;
    this.sqlitePath = path.join(this.dataDir, "guardrails.sqlite");
    this.jsonMirrorPath = path.join(this.dataDir, "runtime-cache.json");
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.maxTotalSpendUSD = Number(
      options.maxTotalSpendUSD ?? process.env.MAX_TOTAL_SPEND_USD ?? 5.0
    );
    this.maxSessionSpendUSD = Number(
      options.maxSessionSpendUSD ?? process.env.MAX_SESSION_SPEND_USD ?? 0.5
    );
    this.maxCallsPerSession = Number(
      options.maxCallsPerSession ?? process.env.MAX_CALLS_PER_SESSION ?? 15
    );
    this.sessions = new Map();
    this.state = {
      totalSpendUSD: 0,
      totalLiveCalls: 0,
      totalCacheHits: 0,
      cache: {},
      ledger: [],
    };
    this._initStorage();
  }

  _initStorage() {
    if (fs.existsSync(this.jsonMirrorPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.jsonMirrorPath, 'utf8'));
        this.state = { ...this.state, ...parsed };
      } catch (_) {
        // ignore corrupt mirror
      }
    }
    try {
      execFileSync(
        'sqlite3',
        [this.sqlitePath],
        {
          input: `CREATE TABLE IF NOT EXISTS api_cache (
            cache_key TEXT PRIMARY KEY,
            endpoint TEXT NOT NULL,
            model TEXT NOT NULL,
            cost_usd REAL NOT NULL,
            response_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS spend_ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            model TEXT NOT NULL,
            cost_usd REAL NOT NULL,
            cached INTEGER NOT NULL,
            created_at TEXT NOT NULL
          );`,
        }
      );
    } catch (_) {
      // Fallback to JSON mirror if sqlite3 CLI is unavailable in container
    }
  }

  _persist(cacheEntry = null, ledgerEntry = null) {
    fs.writeFileSync(this.jsonMirrorPath, JSON.stringify(this.state, null, 2), 'utf8');
    try {
      let sql = '';
      if (cacheEntry) {
        sql += `INSERT OR REPLACE INTO api_cache (cache_key, endpoint, model, cost_usd, response_json, created_at)
          VALUES ('${cacheEntry.key}', '${cacheEntry.endpoint.replace(/'/g, "''")}', '${cacheEntry.model.replace(/'/g, "''")}', ${Number(cacheEntry.costUSD)}, '${JSON.stringify(cacheEntry.value).replace(/'/g, "''")}', '${cacheEntry.createdAt}');\n`;
      }
      if (ledgerEntry) {
        sql += `INSERT INTO spend_ledger (session_id, endpoint, model, cost_usd, cached, created_at)
          VALUES ('${ledgerEntry.sessionId.replace(/'/g, "''")}', '${ledgerEntry.endpoint.replace(/'/g, "''")}', '${ledgerEntry.model.replace(/'/g, "''")}', ${Number(ledgerEntry.costUSD)}, ${ledgerEntry.cached ? 1 : 0}, '${ledgerEntry.createdAt}');\n`;
      }
      if (sql) {
        execFileSync('sqlite3', [this.sqlitePath], { input: sql });
      }
    } catch (_) {
      // JSON mirror already persisted
    }
  }

  getSession(sessionId = 'default') {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { spendUSD: 0, liveCalls: 0, cacheHits: 0 });
    }
    return this.sessions.get(sessionId);
  }

  getCached(cacheKey, sessionId = 'default', meta = {}) {
    const entry = this.state.cache[cacheKey];
    if (!entry) return null;
    this.state.totalCacheHits += 1;
    const sess = this.getSession(sessionId);
    sess.cacheHits += 1;
    const ledgerEntry = {
      sessionId,
      endpoint: meta.endpoint || entry.endpoint || 'unknown',
      model: meta.model || entry.model || 'unknown',
      costUSD: 0,
      cached: true,
      createdAt: new Date().toISOString(),
    };
    this.state.ledger.push(ledgerEntry);
    this._persist(null, ledgerEntry);
    return {
      ...entry.value,
      originalCostUSD: entry.costUSD,
      cachedAt: entry.createdAt,
    };
  }

  canSpend(estimatedCostUSD, sessionId = 'default') {
    const sess = this.getSession(sessionId);
    if (this.state.totalSpendUSD + estimatedCostUSD > this.maxTotalSpendUSD) {
      return {
        allowed: false,
        reason: `total_budget_cap_reached ($${this.state.totalSpendUSD.toFixed(4)} / $${this.maxTotalSpendUSD.toFixed(2)} USD)`,
      };
    }
    if (sess.spendUSD + estimatedCostUSD > this.maxSessionSpendUSD) {
      return {
        allowed: false,
        reason: `session_budget_cap_reached ($${sess.spendUSD.toFixed(4)} / $${this.maxSessionSpendUSD.toFixed(2)} USD)`,
      };
    }
    if (sess.liveCalls >= this.maxCallsPerSession) {
      return {
        allowed: false,
        reason: `session_call_limit_reached (${sess.liveCalls} / ${this.maxCallsPerSession} calls)`,
      };
    }
    return { allowed: true, reason: null };
  }

  recordLiveCall({ cacheKey, endpoint, model, costUSD, value, sessionId = 'default' }) {
    const numericCost = Number(costUSD || 0);
    this.state.totalSpendUSD = Number((this.state.totalSpendUSD + numericCost).toFixed(8));
    this.state.totalLiveCalls += 1;

    const sess = this.getSession(sessionId);
    sess.spendUSD = Number((sess.spendUSD + numericCost).toFixed(8));
    sess.liveCalls += 1;

    const createdAt = new Date().toISOString();
    let cacheEntry = null;
    if (cacheKey && value !== undefined) {
      cacheEntry = { key: cacheKey, endpoint, model, costUSD: numericCost, value, createdAt };
      this.state.cache[cacheKey] = cacheEntry;
    }
    const ledgerEntry = {
      sessionId,
      endpoint,
      model,
      costUSD: numericCost,
      cached: false,
      createdAt,
    };
    this.state.ledger.push(ledgerEntry);
    this._persist(cacheEntry, ledgerEntry);
  }

  getSummary(sessionId = 'default') {
    const sess = this.getSession(sessionId);
    const byModel = {};
    for (const item of this.state.ledger) {
      if (!byModel[item.model]) {
        byModel[item.model] = { liveCalls: 0, cacheHits: 0, spendUSD: 0 };
      }
      if (item.cached) {
        byModel[item.model].cacheHits += 1;
      } else {
        byModel[item.model].liveCalls += 1;
        byModel[item.model].spendUSD = Number(
          (byModel[item.model].spendUSD + Number(item.costUSD || 0)).toFixed(6)
        );
      }
    }
    return {
      creditPoolUSD: 150.0,
      hardCapTotalUSD: this.maxTotalSpendUSD,
      totalSpendUSD: Number(this.state.totalSpendUSD.toFixed(6)),
      remainingBudgetUSD: Number(
        Math.max(0, this.maxTotalSpendUSD - this.state.totalSpendUSD).toFixed(6)
      ),
      totalLiveCalls: this.state.totalLiveCalls,
      totalCacheHits: this.state.totalCacheHits,
      cachedEntriesCount: Object.keys(this.state.cache).length,
      byModel,
      session: {
        sessionId,
        spendUSD: Number(sess.spendUSD.toFixed(6)),
        maxSessionSpendUSD: this.maxSessionSpendUSD,
        liveCalls: sess.liveCalls,
        maxCallsPerSession: this.maxCallsPerSession,
        cacheHits: sess.cacheHits,
      },
    };
  }
}
