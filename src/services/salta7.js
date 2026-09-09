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
  async _request(path, { method = 'GET', query, body, token } = {}) {
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

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, init);
    } catch (networkErr) {
      const err = new Error(`Salta7 request failed: ${networkErr.message}`);
      err.status = 502;
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
      // Salta7 returns errors as { "detail": "..." }.
      const message =
        (data && (data.detail || data.message || data.error)) ||
        `Salta7 responded with ${response.status}`;
      const err = new Error(message);
      err.status = response.status;
      err.data = data;
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
    
    // Formate les tokens sous forme de texte avec un token par ligne
    const tokenList = Array.isArray(tokens)
      ? tokens.map(t => String(t).trim()).filter(Boolean).join('\n')
      : String(tokens || '').trim();

    const body = {
      tool: 'boost',
      mode: 'byot',
      invite: inviteValue,
      tokens: tokenList,
    };
    return this._request('/task/create', { method: 'POST', body });
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
