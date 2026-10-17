'use strict';

/**
 * Salta7Service
 * -------------
 * Thin wrapper around the Salta7 external API
 * (https://salta7.store — docs at https://salta7.store/api). Paths are
 * appended directly to the base URL (no /api prefix), e.g.
 * `${baseUrl}/balance`, `${baseUrl}/task/create`.
 *
 * Every request is authenticated with the Master Token stored in the
 * environment. The service is intentionally stateless — it only knows how to
 * talk to Salta7; persistence and business rules live in the route handlers.
 */
const { extractToken } = require('../utils/helpers');
// Every token sent upstream is reduced to the bare token, so a stored `email:pass:token:2fa` line
// (or a value saved before the 2FA handling existed) is never sent as is.
const bareTokens = (list) => (Array.isArray(list) ? list : [])
  .map((t) => extractToken(typeof t === 'string' ? t : (t && t.token) || ''))
  .filter(Boolean);

class Salta7Service {
  constructor(options = {}) {
    this.baseUrl = (
      options.baseUrl ||
      process.env.SALTA7_BASE_URL ||
      'https://salta7.store'
    ).replace(/\/+$/, '');

    this.masterToken = options.masterToken || process.env.SALTA7_MASTER_TOKEN || '';

    this.captchaCost = Number(
      options.captchaCost || process.env.CAPTCHA_COST || 0.015
    );
    this.boostsPerToken = Number(
      options.boostsPerToken || process.env.BOOSTS_PER_TOKEN || 2
    );
  }

  /**
   * Internal fetch helper. Attaches the bearer token, parses JSON and turns
   * non-2xx responses into thrown errors carrying the upstream status/body.
   */
  async _request(path, { method = 'GET', query, body, token, timeout = 0 } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers = {
      Authorization: `Bearer ${token || this.masterToken}`,
    };
    const init = { method, headers };
    // Optional cap, so a hung upstream turns into a clean (retryable) error instead of the
    // serverless function being killed with no answer at all.
    if (timeout > 0 && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) init.signal = AbortSignal.timeout(timeout);

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, init);
    } catch (networkErr) {
      console.error('[salta7] network error:', networkErr.message);
      const err = new Error('Service temporarily unavailable');
      err.status = 502;
      err.upstream = true;
      throw err;
    }

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      let rawMsg = data?.detail || data?.message || data?.error || data;
      if (typeof rawMsg === 'object') {
        rawMsg = JSON.stringify(rawMsg);
      }
      // Full upstream detail stays in the server logs only — never in err.message,
      // which can end up in an HTTP response.
      console.error(`[salta7] ${method} ${path} -> ${response.status}:`, rawMsg);
      const err = new Error('Service temporarily unavailable');
      err.status = response.status;
      err.upstream = true;
      // Short provider reason, for ADMIN-facing screens only (callers decide whether to show it).
      err.detail = String(rawMsg).replace(/\s+/g, ' ').slice(0, 200);
      throw err;
    }


    return data;
  }

  /**
   * GET /balance — check the account balance on Salta7.
   * A per-user token can be passed; otherwise the master token is used.
   */
  async getBalance(userToken) {
    return this._request('/balance', { method: 'GET', token: userToken });
  }

  /**
   * The Salta7 balance as a number (USD), or null when the answer has no
   * recognisable amount. Never throws on a missing field.
   */
  async getBalanceAmount(userToken) {
    const d = await this.getBalance(userToken);
    if (typeof d === 'number') return d;
    const raw = d && (d.balance ?? d.amount ?? d.credits ?? d.credit ?? d.usd ?? d.funds);
    const n = Number(raw);
    return raw === undefined || raw === null || raw === '' || !Number.isFinite(n) ? null : n;
  }

  /**
   * POST /task/create — start a boost job (BYOT). This is the ONLY request
   * shape used for boosting, exactly as documented:
   *
   *   POST {BASE}/task/create
   *   { "tool": "boost", "mode": "byot", "invite": "...", "tokens": [...] }
   *
   * @param {string}   invite   invite (e.g. "discord.gg/abc123" or a code)
   * @param {string[]} tokens   the tokens to boost with (stock or the user's)
   */
      async createBoostJob(invite, tokens) {
    const raw = String(invite || '');
    const inviteValue = raw.includes('/') ? raw : `discord.gg/${raw}`;

    // On garantit une liste d'éléments texte nettoyés
    let list = [];
    if (Array.isArray(tokens)) {
      list = tokens;
    } else if (typeof tokens === 'string') {
      list = tokens.split(/[\r\n,]+/).map(t => t.trim()).filter(Boolean);
    }

    const cleanTokens = bareTokens(list);

    const body = {
      tool: 'boost',
      mode: 'byot',
      invite: inviteValue,
      tokens: cleanTokens,
    };

    return this._request('/task/create', { method: 'POST', body });
  }



  /**
   * POST /task/create — start a JOIN job with the caller's own tokens
   * (tool "join", mode "byot", max 100 tokens). Join only, no boost. In the
   * job object boosts_requested / boosts_delivered count ACCOUNTS joined.
   */
  async createJoinJob(invite, tokens) {
    const raw = String(invite || '');
    const inviteValue = raw.includes('/') ? raw : `discord.gg/${raw}`;
    const list = bareTokens(tokens);
    return this._request('/task/create', {
      method: 'POST',
      body: { tool: 'join', mode: 'byot', invite: inviteValue, tokens: list },
    });
  }

  /**
   * POST /task/create — token CHECK (free, up to 1000 tokens). The reply is a
   * receipt { job_id, total, skipped_* }; poll getCheckItems with the job id.
   */
  async createCheckJob(tokens) {
    const list = [...new Set(bareTokens(tokens))];
    return this._request('/task/create', { method: 'POST', body: { tool: 'check', tokens: list } });
  }

  /**
   * POST /task/create — HUMANIZE job with the caller's own tokens (tool
   * "humanize", mode "byot", max 1000 tokens, no server join / no invite).
   * `humanize` is the profile object: any of avatar / name / bio, each
   * { source: "random" } or { source: "custom", value }. Poll with
   * getJobStatus(): status stays "running" until the profiles are written,
   * `humanized` / `humanize_failed` track the per-account work.
   */
  async createHumanizeJob(tokens, humanize) {
    const list = bareTokens(tokens).slice(0, 1000);
    return this._request('/task/create', {
      method: 'POST',
      body: { tool: 'humanize', mode: 'byot', tokens: list, humanize },
    });
  }

  /**
   * GET /task/items for a CHECK job: { status, total, checked, counts, last_id,
   * results[] }. `after` is a cursor — results with a greater id only.
   */
  async getCheckItems(jobId, after = 0, timeout = 0) {
    return this._request('/task/items', { method: 'GET', query: { job_id: jobId, after }, timeout });
  }

  /**
   * GET /task/status — check the progress of a job.
   */
  async getJobStatus(jobId) {
    return this._request('/task/status', {
      method: 'GET',
      query: { job_id: jobId },
    });
  }

  /**
   * POST /task/byot/quote — calculate the price for using your own tokens.
   *
   * @param {string[]} tokens        the tokens the user intends to use
   * @param {number}   boostsNeeded  how many boosts the user wants
   */
  async getBYOTQuote(tokens, boostsNeeded = 0, opts = {}) {
    const list = Array.isArray(tokens) ? tokens : [];
    const captchaCost =
      opts.captchaCost !== undefined ? Number(opts.captchaCost) : this.captchaCost;
    const body = { tokens: list, boosts_needed: Number(boostsNeeded) };

    try {
      const remote = await this._request('/task/byot/quote', {
        method: 'POST',
        body,
      });
      // Normalise the remote shape so the frontend always gets the same keys.
      return this._normaliseQuote(remote, list, boostsNeeded, captchaCost);
    } catch (err) {
      // If the upstream quote endpoint is unavailable we still return a
      // best-effort local estimate so the UI stays responsive.
      if (err.status && err.status >= 500) {
        return this._localQuote(list, boostsNeeded, captchaCost);
      }
      throw err;
    }
  }

  /**
   * GET /task/items — job results in Stock mode.
   */
  async getJobItems(jobId) {
    return this._request('/task/items', {
      method: 'GET',
      query: { job_id: jobId },
    });
  }

  /**
   * GET /task/byot/items — job results in BYOT mode.
   */
  async getBYOTItems(jobId) {
    return this._request('/task/byot/items', {
      method: 'GET',
      query: { job_id: jobId },
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  _normaliseQuote(remote = {}, tokens, boostsNeeded, captchaCost = this.captchaCost) {
    const tokenCount = tokens.length;
    const local = this._localQuote(tokens, boostsNeeded, captchaCost);

    return {
      // Real field is `will_use` (how many tokens will actually be spent).
      tokensToUse:
        remote.will_use ?? remote.tokensToUse ?? remote.tokens_to_use ?? local.tokensToUse,
      // Real field is `join_price` (per-token captcha price for boosting).
      captchaCost:
        remote.join_price ?? remote.captchaCost ?? remote.captcha_cost ?? local.captchaCost,
      // Real field is `max_total` (worst-case total cost across all tokens).
      estimatedMaxCost:
        remote.max_total ??
        remote.estimatedMaxCost ??
        remote.estimated_max_cost ??
        remote.maxCost ??
        local.estimatedMaxCost,
      maxBoosts:
        remote.maxBoosts ?? remote.max_boosts ?? tokenCount * this.boostsPerToken,
      raw: remote,
    };
  }

  /**
   * Local BYOT quote: in BYOT mode the user only pays per captcha, and each
   * token can solve up to one captcha, so max cost = tokensUsed * captchaCost.
   */
  _localQuote(tokens, boostsNeeded, captchaCost = this.captchaCost) {
    const tokenCount = tokens.length;
    const maxBoosts = tokenCount * this.boostsPerToken;

    // How many tokens are actually needed to satisfy the request.
    const needed = Number(boostsNeeded) > 0 ? Number(boostsNeeded) : maxBoosts;
    const tokensToUse =
      this.boostsPerToken > 0
        ? Math.min(tokenCount, Math.ceil(needed / this.boostsPerToken))
        : tokenCount;

    const totalCaptchaCost = Number((tokensToUse * Number(captchaCost)).toFixed(4));

    return {
      tokensToUse,
      captchaCost: totalCaptchaCost,
      estimatedMaxCost: totalCaptchaCost,
      maxBoosts,
      raw: null,
    };
  }
}

module.exports = Salta7Service;
module.exports.Salta7Service = Salta7Service;
