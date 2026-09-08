'use strict';

/**
 * TatumService
 * ------------
 * Litecoin helpers built on the Tatum API (https://apidoc.tatum.io).
 *
 * Non-custodial flow:
 *   - Deposit addresses are derived from an extended public key (xpub) at an
 *     incrementing index, so every top-up gets its own address.
 *   - Incoming funds are detected by querying the address balance (and/or a
 *     webhook subscription).
 *   - Once received, funds are forwarded to a single main address using a
 *     private key derived from the wallet mnemonic.
 *
 * All secrets come from the environment; nothing here is persisted.
 */
class TatumService {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.TATUM_API_KEY || '';
    this.baseUrl = (options.baseUrl || process.env.TATUM_BASE_URL || 'https://api.tatum.io/v3')
      .replace(/\/+$/, '');
    this.xpub = options.xpub || process.env.LTC_XPUB || '';
    this.mnemonic = options.mnemonic || process.env.LTC_MNEMONIC || '';
    this.mainAddress = options.mainAddress || process.env.LTC_MAIN_ADDRESS || '';
    this.startIndex = Number(options.startIndex || process.env.LTC_START_INDEX || 1);
    this.forwardFee = String(options.forwardFee || process.env.LTC_FORWARD_FEE || '0.0001');
    this.webhookBaseUrl = options.webhookBaseUrl || process.env.WEBHOOK_BASE_URL || '';
  }

  /** Minimum config needed to hand out deposit addresses. */
  isConfigured() {
    return Boolean(this.apiKey && this.xpub && this.mainAddress);
  }

  /** Whether we can also forward funds (needs the mnemonic to sign). */
  canForward() {
    return Boolean(this.mnemonic && this.mainAddress);
  }

  async _request(path, { method = 'GET', body } = {}) {
    const headers = { 'x-api-key': this.apiKey };
    const init = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (networkErr) {
      const err = new Error(`Tatum request failed: ${networkErr.message}`);
      err.status = 502;
      throw err;
    }

    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (!response.ok) {
      const message =
        (data && (data.message || data.errorCode || data.cause)) ||
        `Tatum responded with ${response.status}`;
      const err = new Error(Array.isArray(message) ? message.join('; ') : String(message));
      err.status = response.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /**
   * Exchange rate: USD price of 1 unit of `currency` (default LTC).
   * Uses Tatum's rate endpoint; returns a number.
   */
  async getRate(currency = 'LTC', basePair = 'USD') {
    const data = await this._request(
      `/tatum/rate/${currency}?basePair=${basePair}`
    );
    const value = Number(data.value);
    if (!(value > 0)) throw new Error('Invalid exchange rate from Tatum');
    return value;
  }

  /** Derive the deposit address for a given index. */
  async getAddress(index) {
    const data = await this._request(`/litecoin/address/${this.xpub}/${index}`);
    return data.address;
  }

  /** Get the private key for an index (needed to forward funds). */
  async getPrivateKey(index) {
    const data = await this._request('/litecoin/wallet/priv', {
      method: 'POST',
      body: { index: Number(index), mnemonic: this.mnemonic },
    });
    return data.key;
  }

  /**
   * Address balance. Tatum returns strings like { incoming, outgoing }.
   * Returns { incoming, outgoing, received } as numbers (received = net in).
   */
  async getAddressBalance(address) {
    const data = await this._request(`/litecoin/address/${address}`);
    const incoming = Number(data.incoming || 0);
    const outgoing = Number(data.outgoing || 0);
    return { incoming, outgoing, received: incoming };
  }

  /**
   * Forward the given amount of LTC from a derived deposit address to the
   * configured main address. Returns { txId }.
   */
  async forwardToMain(index, amountLtc) {
    const [fromAddress, privateKey] = await Promise.all([
      this.getAddress(index),
      this.getPrivateKey(index),
    ]);

    const value = Number(amountLtc) - Number(this.forwardFee);
    if (!(value > 0)) {
      throw new Error('Amount too small to forward after fee');
    }

    const data = await this._request('/litecoin/transaction', {
      method: 'POST',
      body: {
        fromAddress: [{ address: fromAddress, privateKey }],
        to: [{ address: this.mainAddress, value: Number(value.toFixed(8)) }],
        fee: this.forwardFee,
        changeAddress: this.mainAddress,
      },
    });
    return { txId: data.txId || data.txHash || null };
  }

  /**
   * Optionally register a webhook subscription so Tatum notifies us when a
   * transaction hits the deposit address. Best-effort; failures are ignored
   * by the caller (polling still works).
   */
  async subscribeAddress(address) {
    if (!this.webhookBaseUrl) return null;
    const url = `${this.webhookBaseUrl.replace(/\/+$/, '')}/api/wallet/webhook/tatum`;
    const data = await this._request('/subscription', {
      method: 'POST',
      body: {
        type: 'ADDRESS_TRANSACTION',
        attr: { address, chain: 'LTC', url },
      },
    });
    return data.id || null;
  }
}

module.exports = TatumService;
module.exports.TatumService = TatumService;
