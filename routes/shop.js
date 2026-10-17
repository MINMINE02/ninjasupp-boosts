'use strict';

/* Shop API — /api/shop
 *   GET  /packs            public: the packs on sale
 *   GET  /me               the account's wallet + premium state (auth)
 *   POST /checkout         { packId, method: 'wallet' | 'ltc' } (auth)
 *   GET  /orders           the account's latest orders (auth)
 *   GET  /orders/:id       one order; a waiting Litecoin order is checked on the chain (auth)
 * Prices always come from the database, never from the request. */

const express = require('express');
const supabase = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/helpers');
const { rateLimit } = require('../utils/rateLimit');
const shop = require('../services/shop');
const wallet = require('./wallet');

const router = express.Router();
const checkoutLimiter = rateLimit({ windowMs: 60_000, max: 12 });
const notReady = (res) => res.status(503).json({ error: shop.NOT_READY });

router.get('/packs', asyncHandler(async (req, res) => {
  if (!(await shop.ready())) return res.json({ packs: [], ready: false });
  res.set('Cache-Control', 'public, max-age=20');
  // the per-boost fee of new premium accounts is the admin's business, not shown to visitors
  res.json({ packs: (await shop.listPacks()).map(({ boostPrice, ...pub }) => pub), ready: true });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  if (!(await shop.ready())) return notReady(res);
  const state = await shop.userState(req.user.id);
  let ltcRate = null;
  if (wallet.tatum.isConfigured()) {
    try { ltcRate = await wallet.tatum.getRate('LTC', 'USD'); } catch { ltcRate = null; }
  }
  res.set('Cache-Control', 'no-store');
  res.json({ ...state, topupEnabled: wallet.tatum.isConfigured(), ltcRate });
}));

router.post('/checkout', requireAuth, checkoutLimiter, asyncHandler(async (req, res) => {
  if (!(await shop.ready())) return notReady(res);
  const method = req.body && req.body.method;
  if (method !== 'wallet' && method !== 'ltc') return res.status(400).json({ error: 'Choose how to pay: wallet or Litecoin' });

  const pack = await shop.getPack(req.body && req.body.packId);
  if (!pack || !pack.active) return res.status(404).json({ error: 'This pack is not available' });
  const price = Number(pack.price_usd);

  if (method === 'wallet') {
    // A pack that only gives credits can't be bought with credits — Litecoin only.
    if (!pack.grants_premium) {
      return res.status(400).json({ error: 'This pack only gives credits, so it can only be paid with Litecoin.', code: 'LTC_ONLY' });
    }
    const state = await shop.userState(req.user.id);
    if (!state) return res.status(401).json({ error: 'Account not found' });
    if (state.balance + 1e-9 < price) {
      return res.status(402).json({
        error: `Not enough credits: this pack costs $${price.toFixed(2)} and your wallet has $${state.balance.toFixed(2)}.`,
        balance: state.balance, missing: Number((price - state.balance).toFixed(2)),
      });
    }
    const order = await shop.createOrder(req.user.id, pack, 'wallet');
    const result = await shop.fulfillOrder(order.id);
    if (!result.done) {
      await supabase.from('shop_orders').update({ status: 'cancelled' }).eq('id', order.id);
      return res.status(402).json({ error: 'Not enough credits to complete this purchase.', balance: result.balance });
    }
    return res.status(201).json({ order: shop.mapOrder(result.order), balance: result.balance, premium: result.premium });
  }

  // Litecoin: a deposit made for this order; the order completes the moment it is confirmed.
  if (!wallet.tatum.isConfigured()) return res.status(503).json({ error: 'Litecoin payments are not available right now' });
  await shop.closeStaleOrders(req.user.id);
  if ((await shop.countOpenOrders(req.user.id)) >= shop.MAX_OPEN_ORDERS) {
    return res.status(429).json({ error: 'You have several unpaid orders already. Pay or wait for them to expire (24 h).' });
  }
  let created;
  try {
    created = await wallet.createDeposit(req.user.id, price);
  } catch (err) {
    if ([400, 502, 503].includes(err.status)) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  const order = await shop.createOrder(req.user.id, pack, 'ltc', { deposit_id: created.deposit.id });
  res.status(201).json({ order: shop.mapOrder(order), deposit: created.deposit, qr: created.qr });
}));

// A Litecoin order whose payment arrived a little short: finish it from the wallet.
router.post('/orders/:id/complete', requireAuth, checkoutLimiter, asyncHandler(async (req, res) => {
  if (!(await shop.ready())) return notReady(res);
  const order = await shop.getOrder(req.user.id, req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'awaiting_payment') return res.status(409).json({ error: 'This order is not waiting for payment' });
  // Credit-only packs can't be paid with credits: they complete only through their own Litecoin payment.
  if (!order.grants_premium) {
    return res.status(400).json({ error: 'This pack only gives credits, so it can only be paid with Litecoin. Send the full Litecoin amount and it completes by itself.', code: 'LTC_ONLY' });
  }
  const result = await shop.fulfillOrder(order.id);
  if (!result.done) {
    const missing = Math.max(0, Number(order.price_usd) - Number(result.balance || 0));
    return res.status(402).json({ error: `Your wallet is $${missing.toFixed(2)} short for this order.`, balance: result.balance, missing: Number(missing.toFixed(2)) });
  }
  res.json({ order: shop.mapOrder(result.order), balance: result.balance, premium: result.premium });
}));

// A Litecoin order whose payment arrived short: pay only the difference in Litecoin.
router.post('/orders/:id/topup', requireAuth, checkoutLimiter, asyncHandler(async (req, res) => {
  if (!(await shop.ready())) return notReady(res);
  const order = await shop.getOrder(req.user.id, req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'awaiting_payment' || order.method !== 'ltc' || !order.deposit_id) {
    return res.status(409).json({ error: 'This order is not waiting for a Litecoin payment' });
  }
  if (!wallet.tatum.isConfigured()) return res.status(503).json({ error: 'Litecoin payments are not available right now' });

  const { data: dep } = await supabase.from('deposits').select('*').eq('id', order.deposit_id).maybeSingle();
  if (!dep || dep.status !== 'completed') {
    return res.status(409).json({ error: 'Your first payment is not confirmed yet — wait for it, then pay the difference.' });
  }
  const missing = shop.missingUsd(order, dep);
  if (missing <= 0) {
    // Fully paid in Litecoin already: just finish it.
    const done = await shop.fulfillOrder(order.id);
    if (done.done) return res.json({ order: shop.mapOrder(done.order), balance: done.balance, premium: done.premium });
    return res.status(409).json({ error: 'Your payment is complete — the order will finish in a moment.' });
  }

  let created;
  try {
    created = await wallet.createDeposit(req.user.id, missing);
  } catch (err) {
    if ([400, 502, 503].includes(err.status)) return res.status(err.status).json({ error: err.message });
    throw err;
  }
  // The order now waits for this new deposit (it completes the moment it is confirmed).
  const { data: moved } = await supabase.from('shop_orders')
    .update({ deposit_id: created.deposit.id }).eq('id', order.id).eq('status', 'awaiting_payment').eq('deposit_id', dep.id).select('id');
  if (!moved || !moved.length) return res.status(409).json({ error: 'This order just changed — reload and try again.' });
  const fresh = await shop.getOrder(req.user.id, order.id);
  res.status(201).json({ order: shop.mapOrder(fresh || order), deposit: created.deposit, qr: created.qr, missingUsd: missing });
}));

router.get('/orders', requireAuth, asyncHandler(async (req, res) => {
  if (!(await shop.ready())) return notReady(res);
  await shop.closeStaleOrders(req.user.id);
  res.set('Cache-Control', 'no-store');
  res.json({ orders: await shop.listOrders(req.user.id) });
}));

router.get('/orders/:id', requireAuth, asyncHandler(async (req, res) => {
  if (!(await shop.ready())) return notReady(res);
  let order = await shop.getOrder(req.user.id, req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  let deposit = null;
  let qr = null;
  if (order.deposit_id) {
    const { data: dep } = await supabase.from('deposits').select('*').eq('id', order.deposit_id).maybeSingle();
    if (dep && order.status === 'awaiting_payment' && dep.status === 'pending') {
      // checks the chain; when the payment is enough it credits the wallet and completes this order
      try { await wallet.processDeposit(dep); } catch { /* the next poll retries */ }
      order = (await shop.getOrder(req.user.id, req.params.id)) || order;
    }
    const { data: fresh } = await supabase.from('deposits').select('*').eq('id', order.deposit_id).maybeSingle();
    if (fresh) {
      const d = wallet.mapDeposit(fresh);
      // only what the customer needs to see (no internal forwarding data)
      deposit = {
        status: d.status,
        address: d.address,
        paymentUri: d.paymentUri,
        ltcAmount: d.ltcAmount,
        usdAmount: d.usdAmount,
        rate: d.rate,
        received: d.received,
        receivedUsd: d.receivedUsd,
        missingUsd: shop.missingUsd(order, fresh),
        txId: d.txId || null,
        createdAt: d.createdAt,
        completedAt: d.completedAt || null,
      };
      // the payment page can be reopened while the order still waits for this payment
      if (order.status === 'awaiting_payment' && fresh.status === 'pending' && d.paymentUri) qr = await wallet.makeQr(d.paymentUri);
    }
  }
  const state = order.status === 'completed' ? await shop.userState(req.user.id) : null;
  res.set('Cache-Control', 'no-store');
  res.json({ order: shop.mapOrder(order), deposit, qr, balance: state ? state.balance : undefined, premium: state ? state.premium : undefined });
}));

module.exports = router;
