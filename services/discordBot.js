'use strict';

/* =========================================================================
 * Ninja Boost admin bot — Discord slash commands over HTTP "Interactions"
 * (no bot process, no gateway: Discord calls POST /api/discord/interactions,
 * which works on serverless hosts like Vercel).
 *
 *   /stock /restock /genkey /boost /job /jobs /key /revoke /balance   (+ /link /unlink)
 *
 * Two kinds of people use the same commands, and the commands adapt to who is calling:
 *  - admins (DISCORD_ADMIN_IDS)   -> the platform: platform stock, every key and job;
 *  - premium accounts             -> their OWN stock, keys, jobs and wallet only. A premium account
 *                                    links its Discord account once with /link (code from the panel).
 *
 * Security
 *  - every request must carry a valid Ed25519 signature from Discord;
 *  - nobody else than an admin or a linked, active premium account may run a command;
 *  - a premium account can never read or change anything that belongs to someone else;
 *  - every answer is public (everybody in the channel sees it) — see PRIVATE below to hide a command; tokens are never echoed,
 *    keys only in the answer to /genkey, /key.
 * Setup: docs/DISCORD_BOT.md
 * ========================================================================= */

const crypto = require('crypto');
const supabase = require('../config/supabase');
const reseller = require('./reseller'); // addStock, BOOSTS_PER_TOKEN
const { generateKeyCode, parseInviteCode, normalizeKeyCode } = require('../utils/helpers');

const HEAD = { count: 'exact', head: true };
const { COLORS, kitFor, bar } = require('./discordStyle'); // admin = custom-emoji "console" look, others = classic look
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE_MAX_AGE_S = 300;
const SLOW = new Set(['boost', 'restock']);  // answered later (deferred) when the host allows it
// Commands whose answer stays visible only to the caller (ephemeral). Empty = everything is public. Add e.g. 'genkey', 'key' to hide them.
const PRIVATE = new Set([]);
const ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const MAX_ATTACHMENT_BYTES = 1_000_000;

/* ------------------------------ verification ------------------------------ */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifySignature(rawBody, signature, timestamp, publicKeyHex, nowMs = Date.now()) {
  try {
    if (!Buffer.isBuffer(rawBody) || !/^[0-9a-f]{128}$/i.test(String(signature || ''))) return false;
    if (!/^[0-9a-f]{64}$/i.test(String(publicKeyHex || ''))) return false;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SIGNATURE_MAX_AGE_S) return false; // replay guard
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.concat([Buffer.from(String(timestamp)), rawBody]), key, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

const discordUserId = (interaction) => String((interaction.member && interaction.member.user && interaction.member.user.id) || (interaction.user && interaction.user.id) || '');
const adminIds = () => new Set(String(process.env.DISCORD_ADMIN_IDS || '').split(/[\s,]+/).filter((x) => /^\d{5,25}$/.test(x)));

/* -------------------------------- helpers --------------------------------- */
const { fail } = kitFor(null); // classic look: used before we know who is calling
const userError = (message, status = 400) => Object.assign(new Error(message), { status });
const num = (n) => Number(n || 0).toLocaleString('en-US');

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}

async function count(q) {
  const { count: c, error } = await q;
  if (error) throw error;
  return c || 0;
}

// Rows of the caller: a premium account's own pool, or the platform pool (owner NULL) for an admin.
const mine = (q, ctx) => (ctx && ctx.ownerId ? q.eq('owner_id', ctx.ownerId) : q.is('owner_id', null));

const publicUrl = () => String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const salta7 = () => new (require('./salta7'))();
const boostModule = () => require('../routes/boost'); // big module: loaded only when a command needs it

/* -------------------------------- commands -------------------------------- */
async function cmdStock(o, interaction, ctx = {}) {
  const K = kitFor(ctx);
  const { E, embed, field } = K;
  if (ctx.ownerId) {
    const [unused, used] = await Promise.all([
      count(mine(supabase.from('stock_tokens').select('*', HEAD), ctx).eq('status', 'unused')),
      count(mine(supabase.from('stock_tokens').select('*', HEAD), ctx).eq('status', 'used')),
    ]);
    return {
      embeds: [embed('📦 Your token stock', unused === 0 ? COLORS.bad : COLORS.info, [
        field('🟢 Unused tokens', num(unused)),
        field('🚀 Boosts available', num(unused * reseller.BOOSTS_PER_TOKEN)),
        field('Used tokens', num(used)),
        field('All tokens', num(unused + used)),
      ], `Your own stock. One token = ${reseller.BOOSTS_PER_TOKEN} boosts.`)],
    };
  }
  // Same rows, same definition as the admin panel's Overview: the platform stock is every token
  // with no owner; premium (reseller) accounts keep their own stock, shown on its own line.
  const [unused, used, premiumUnused] = await Promise.all([
    count(supabase.from('stock_tokens').select('*', HEAD).is('owner_id', null).eq('status', 'unused')),
    count(supabase.from('stock_tokens').select('*', HEAD).is('owner_id', null).eq('status', 'used')),
    count(supabase.from('stock_tokens').select('*', HEAD).not('owner_id', 'is', null).eq('status', 'unused')),
  ]);
  const total = unused + used;
  const left = total ? unused / total : 0;
  const state = unused === 0 ? `${E.siren} **Out of stock** — use \`/restock\`` : left < 0.2 ? `${E.warn} **Running low**` : `${E.tick} **Healthy**`;
  return {
    embeds: [embed(`${E.stock} Token stock`, unused === 0 ? COLORS.bad : left < 0.2 ? COLORS.warn : COLORS.info, [
      field(`${E.unused} Unused tokens`, num(unused)),
      field(`${E.boost} Boosts available`, num(unused * reseller.BOOSTS_PER_TOKEN)),
      field(`${E.load} Used`, `**${num(used)}**\n-# of ${num(total)} tokens`),
      field(`${E.crown} Premium stock`, `**${num(premiumUnused)}** unused`),
      field(`${E.member} Everyone`, `**${num(unused + premiumUnused)}** unused`),
      field(`${E.rules} Rate`, `**1 token** = ${reseller.BOOSTS_PER_TOKEN} boosts`),
    ], `${state}\n${bar(left)} **${Math.round(left * 100)}%** of the platform stock is still unused\n-# Platform stock, same figures as the admin Overview.`, { thumb: true })],
  };
}

async function readAttachment(att) {
  if (!att || !att.url) throw userError('Could not read the attached file');
  let host = '';
  try { host = new URL(att.url).hostname; } catch { /* below */ }
  if (!ATTACHMENT_HOSTS.has(host)) throw userError('Unexpected attachment address');
  if (Number(att.size) > MAX_ATTACHMENT_BYTES) throw userError('The file is too big (1 MB max, about 5000 tokens)');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(att.url, { signal: ctrl.signal });
    if (!r.ok) throw userError(`Could not download the file (${r.status})`);
    const text = await r.text();
    if (text.length > MAX_ATTACHMENT_BYTES) throw userError('The file is too big (1 MB max, about 5000 tokens)');
    return text;
  } catch (err) {
    if (err.status) throw err;
    throw userError('Could not download the file');
  } finally {
    clearTimeout(t);
  }
}

async function cmdRestock(o, interaction, ctx = {}) {
  const { E, embed, field, ico } = kitFor(ctx);
  let text = String(o.tokens || '');
  if (o.file) {
    const att = interaction.data && interaction.data.resolved && interaction.data.resolved.attachments && interaction.data.resolved.attachments[o.file];
    text += `\n${await readAttachment(att)}`;
  }
  if (!text.trim()) throw userError('Give some tokens in `tokens`, or attach a `.txt` file in `file`.');
  const r = await reseller.addStock(ctx.ownerId || null, text); // the caller's pool (platform = owner NULL); duplicates are skipped
  const unused = await count(mine(supabase.from('stock_tokens').select('*', HEAD), ctx).eq('status', 'unused'));
  return {
    embeds: [embed(`${E.tick} Stock updated`, COLORS.ok, [
      field(`${ico('up')}Added`, num(r.inserted)),
      field(`${ico('copy')}Already in stock`, num(r.duplicates)),
      field(`${ico('stock')}Unused now`, num(unused)),
    ], kitFor(ctx).admin ? `${E.arrow} Duplicates are skipped automatically.` : undefined)],
  };
}

async function cmdGenkey(o, interaction, ctx = {}) {
  const K = kitFor(ctx);
  const { E, embed, field } = K;
  const boosts = Number(o.boosts);
  const n = o.count === undefined ? 1 : Number(o.count);
  if (!Number.isInteger(boosts) || boosts < 1 || boosts > 1000) throw userError('Boosts per key must be between 1 and 1000');
  if (!Number.isInteger(n) || n < 1 || n > 100) throw userError('Number of keys must be between 1 and 100');
  const note = String(o.note || '').trim().slice(0, 120) || null;

  let data = null;
  if (ctx.ownerId) data = (await reseller.generateKeys(ctx.ownerId, { boosts, count: n, note })).map((k) => ({ code: k.code }));
  for (let attempt = 0; attempt < 3 && !data; attempt += 1) {
    const seen = new Set();
    const rows = [];
    while (rows.length < n) {
      const code = generateKeyCode();
      if (!seen.has(code)) { seen.add(code); rows.push({ code, boosts_value: boosts, source: 'admin', note }); }
    }
    const res = await supabase.from('redeem_keys').insert(rows).select('code');
    if (!res.error) data = res.data;
    else if (!/duplicate|unique/i.test(res.error.message || '')) throw res.error;
  }
  if (!data) throw new Error('Could not generate unique keys');
  if (K.admin) {
    return {
      embeds: [embed(`${E.gift} ${data.length} key${data.length === 1 ? '' : 's'} generated`, COLORS.ok, [
        field(`${E.boost} Boosts / key`, `**${num(boosts)}**`),
        field(`${E.key} Keys`, `**${num(data.length)}**`),
        field(`${E.note} Note`, note || '—'),
      ], `${E.copy} Use the copy button on the block below.\n\`\`\`\n${data.map((k) => k.code).join('\n')}\n\`\`\`\n-# Only you can see this message.`)],
    };
  }
  return {
    content: `✅ **${data.length} key${data.length === 1 ? '' : 's'}** · ${num(boosts)} boost${boosts === 1 ? '' : 's'} each${note ? ` · ${note}` : ''}\n\`\`\`\n${data.map((k) => k.code).join('\n')}\n\`\`\`Only you can see this message.`,
  };
}

async function cmdBoost(o, interaction, ctx = {}) {
  const { E, embed, field, ico, sub } = kitFor(ctx);
  const boost = boostModule();
  const invite = parseInviteCode(o.invite);
  if (!/^[A-Za-z0-9-]{2,40}$/.test(invite)) throw userError('That is not a valid Discord invite link or code');
  const { BOOSTS_PER_TOKEN, SPARE_STOCK_TOKENS } = boost.limits;
  const maxBoosts = Math.max(1, 200 - SPARE_STOCK_TOKENS) * BOOSTS_PER_TOKEN; // Salta7: 200 tokens per job
  const boosts = Number(o.boosts);
  if (!Number.isInteger(boosts) || boosts < 1 || boosts > maxBoosts) throw userError(`Boosts must be a whole number between 1 and ${maxBoosts}`);

  const needed = Math.ceil(boosts / BOOSTS_PER_TOKEN);
  const { data: have } = await mine(supabase.from('stock_tokens').select('id'), ctx).eq('status', 'unused').limit(needed);
  if (!have || have.length < needed) {
    throw userError(`Not enough tokens: ${num(boosts)} boosts need ${num(needed)} tokens, the stock has ${num(have ? have.length : 0)}. Use /restock.`, 409);
  }

  if (ctx.ownerId) {
    // A premium account pays per delivered boost from its wallet: same check as the panel.
    const price = Number(ctx.user && ctx.user.boost_price) || 0;
    const { data: me } = await supabase.from('users').select('balance').eq('id', ctx.ownerId).maybeSingle();
    const balance = Number(me && me.balance) || 0;
    if (price > 0 && balance < boosts * price) {
      throw userError(`Insufficient balance: ${num(boosts)} boosts cost up to $${(boosts * price).toFixed(2)} ($${price} each) but your wallet has $${balance.toFixed(2)}.`, 402);
    }
  }

  let keyRow = null;
  for (let i = 0; i < 5 && !keyRow; i += 1) {
    const { data, error } = await supabase.from('redeem_keys')
      .insert({ code: generateKeyCode(), boosts_value: boosts, source: 'direct', note: 'Direct boost (Discord)', ...(ctx.ownerId ? { owner_id: ctx.ownerId } : {}) })
      .select('*').single();
    if (!error) keyRow = data;
    else if (!/duplicate|unique/i.test(error.message || '')) throw error;
  }
  if (!keyRow) throw new Error('Could not prepare the boost');

  const r = await boost.startRedeem(keyRow, invite, '', { direct: true });
  if (r.status !== 201) {
    await supabase.from('redeem_keys').delete().eq('id', keyRow.id); // nothing started -> no leftover key
    throw userError((r.body && r.body.error) || 'Could not start the boost', r.status && r.status < 500 ? r.status : 500);
  }
  const id = r.body && r.body.job && r.body.job.id;
  const base = publicUrl();
  return {
    embeds: [embed(`${E.fire} Boost started`, COLORS.ok, [
      field(`${ico('discord')}Server`, `discord.gg/${invite}`),
      field(`${ico('boost')}Boosts`, num(boosts)),
      field(`${ico('stock')}Tokens`, num(needed)),
      field(`${ico('jobs')}Job`, `\`${id}\``, false),
      ...(base && id ? [field(`${ico('link')}Live status`, `${base}/status/${id}`, false)] : []),
    ], kitFor(ctx).admin ? `${E.arrow} Follow it with \`/job\` or \`/jobs\`.` : 'Follow it with `/job` or `/jobs`.')],
  };
}

function jobEmbed(job, ctx = {}) {
  const K = kitFor(ctx);
  const { E, embed, field, ico, status } = K;
  const base = publicUrl();
  const delivered = Number(job.boosts_delivered) || 0;
  const requested = Number(job.boosts_requested) || 0;
  const pct = requested ? delivered / requested : 0;
  return embed(`${status(job.status, true)} Job · ${job.status}`, job.status === 'completed' ? COLORS.ok : job.status === 'failed' ? COLORS.bad : COLORS.info, [
    field(`${ico('discord')}Server`, job.invite ? `discord.gg/${job.invite}` : '—'),
    field(`${ico('boost')}Boosts`, `${num(delivered)}/${num(requested)}`),
    field(`${ico('rules')}Type`, job.mode === 'byot' ? 'own tokens' : job.mode === 'join' ? 'join' : 'key'),
    field(`${ico('time')}Started`, ago(job.created_at)),
    field(`${ico('load')}Updated`, ago(job.updated_at || job.created_at)),
    field(`${ico('jobs')}Job`, `\`${job.id}\``, false),
    ...(base && job.mode === 'key' ? [field(`${ico('link')}Live status`, `${base}/status/${job.id}`, false)] : []),
  ], K.admin ? `${bar(pct)} **${Math.round(pct * 100)}%** delivered` : undefined);
}

async function cmdJob(o, interaction, ctx = {}) {
  const id = String(o.id || '').trim();
  if (!UUID.test(id)) throw userError('That does not look like a job id');
  const { data: job } = await supabase.from('jobs').select('*').eq('id', id).maybeSingle();
  if (!job || (ctx.ownerId && (job.owner_id !== ctx.ownerId || job.mode === 'join'))) throw userError('Job not found', 404);
  const fresh = job.status === 'running' ? await withTimeout(boostModule().syncJob(job), 2000).catch(() => job) : job;
  return { embeds: [jobEmbed(fresh || job, ctx)] };
}

async function cmdJobs(o, interaction, ctx = {}) {
  const K = kitFor(ctx);
  const { E, embed } = K;
  const n = Math.min(10, Math.max(1, Number(o.count) || 5));
  let jq = supabase.from('jobs')
    .select('id, invite, status, boosts_requested, boosts_delivered, created_at, mode')
    .neq('mode', 'join');
  if (ctx.ownerId) jq = jq.eq('owner_id', ctx.ownerId);
  const { data, error } = await jq.order('created_at', { ascending: false }).limit(n);
  if (error) throw error;
  if (!data || !data.length) return K.admin ? { embeds: [embed(`${E.jobs} No job yet`, COLORS.info, [], `${E.arrow} Start one with \`/boost\`.`)] } : { content: 'No job yet.' };
  const lines = data.map((j) => (K.admin
    ? `${K.status(j.status)} \`${String(j.id).slice(0, 8)}\` ${E.arrow} ${j.invite ? `discord.gg/${j.invite}` : '—'} · ${E.boost} **${num(j.boosts_delivered)}/${num(j.boosts_requested)}** · ${E.time} ${ago(j.created_at)}`
    : `${K.status(j.status)} \`${String(j.id).slice(0, 8)}\` · ${j.invite ? `discord.gg/${j.invite}` : '—'} · **${num(j.boosts_delivered)}/${num(j.boosts_requested)}** · ${ago(j.created_at)}`));
  return { embeds: [embed(`${E.jobs} Latest ${data.length} job${data.length === 1 ? '' : 's'}`, COLORS.info, [], `${lines.join('\n')}\n\n${K.sub('Full id: `/job` + the id shown in the panel.')}`)] };
}

async function cmdKey(o, interaction, ctx = {}) {
  const { E, embed, field, ico, admin } = kitFor(ctx);
  const code = normalizeKeyCode(String(o.code || ''));
  if (!code) throw userError('A key has 16 letters / digits');
  const { data: k } = await supabase.from('redeem_keys').select('*').eq('code', code).maybeSingle();
  if (!k || (ctx.ownerId && k.owner_id !== ctx.ownerId)) throw userError('Key not found', 404);
  let owner = 'Platform';
  if (k.owner_id) {
    const { data: u } = await supabase.from('users').select('username').eq('id', k.owner_id).maybeSingle();
    owner = u && u.username ? `${u.username} (premium)` : 'a premium account';
  }
  const delivered = Number(k.boosts_delivered) || 0;
  return {
    embeds: [embed(`${E.key} ${code}`, k.redeemed_at ? COLORS.warn : COLORS.ok, [
      field(`${ico('boost')}Worth`, `${num(k.boosts_value)} boosts`),
      field(`${ico('up')}Delivered`, `${num(delivered)}/${num(k.boosts_value)}`),
      field(`${admin ? (k.redeemed_at ? E.no : E.ok) + ' ' : ''}State`, k.redeemed_at ? `used ${ago(k.redeemed_at)}` : 'unused'),
      field(`${ico('discord')}Server`, k.redeemed_invite ? `discord.gg/${k.redeemed_invite}` : '—'),
      field(`${ico('owner')}Owner`, owner),
      field(`${ico('rules')}Source`, k.source || '—'),
      field(`${ico('time')}Created`, ago(k.created_at)),
      field(`${ico('note')}Note`, k.note || '—', false),
    ])],
  };
}

async function cmdRevoke(o, interaction, ctx = {}) {
  const { E, embed, field, ico } = kitFor(ctx);
  const code = normalizeKeyCode(String(o.code || ''));
  if (!code) throw userError('A key has 16 letters / digits');
  const { data: k } = await supabase.from('redeem_keys').select('id, owner_id, redeemed_at, boosts_delivered').eq('code', code).maybeSingle();
  if (!k || (ctx.ownerId && k.owner_id !== ctx.ownerId)) throw userError('Key not found', 404);
  if (!ctx.ownerId && k.owner_id) throw userError('This key belongs to a premium account — revoke it from the admin panel.', 403);
  if (k.redeemed_at || (Number(k.boosts_delivered) || 0) > 0) throw userError('This key was already used, it cannot be deleted.', 409);
  const { error } = await supabase.from('redeem_keys').delete().eq('id', k.id);
  if (error) throw error;
  return { embeds: [embed(`${E.trash} Key deleted`, COLORS.ok, [field(`${ico('key')}Key`, code, false)])] };
}

async function cmdBalance(o, interaction, ctx = {}) {
  const { E, embed, field, ico, admin } = kitFor(ctx);
  if (ctx.ownerId) {
    const { data: me } = await supabase.from('users').select('balance, boost_price').eq('id', ctx.ownerId).maybeSingle();
    const balance = Number(me && me.balance) || 0;
    const price = Number(me && me.boost_price) || 0;
    return { embeds: [embed('💳 Your wallet', balance <= 0 && price > 0 ? COLORS.bad : COLORS.info, [
      field('Balance', `$${balance.toFixed(2)}`),
      field('Price per boost', price > 0 ? `$${price}` : 'free'),
      ...(price > 0 ? [field('Boosts covered', num(Math.floor(balance / price)))] : []),
    ])] };
  }
  const balance = await withTimeout(salta7().getBalanceAmount(), 2500).catch(() => null);
  if (balance === null) throw userError('Could not read the Salta7 balance right now', 502);
  return { embeds: [embed(`${E.balance} Salta7 balance`, balance <= 0 ? COLORS.bad : COLORS.info, [field(`${ico('balance')}Balance`, admin ? `## $${balance.toFixed(2)}` : `$${balance.toFixed(2)}`)], admin ? (balance <= 0 ? `${E.siren} **Empty** — top it up to keep boosting.` : `${E.tick} Funds available on the Salta7 account.`) : undefined, { thumb: true })] };
}

// /link and /unlink: usable by anybody (that is how a premium account gets access in the first place).
async function cmdLink(o, interaction, ctx = {}) {
  const { embed, field } = kitFor(null);
  const userId = discordUserId(interaction);
  const r = await require('./discordPremium').redeemLinkCode(o.code, userId);
  return { embeds: [embed('🔗 Linked', COLORS.ok, [field('Premium account', r.username)],
    'This Discord account now controls the stock of that premium account: /stock /restock /genkey /boost /jobs /keys…')] };
}

async function cmdUnlink(o, interaction, ctx = {}) {
  const { embed } = kitFor(null);
  if (!ctx.ownerId) throw userError('No premium account is linked to this Discord account.');
  await require('./discordPremium').unlink(ctx.ownerId);
  return { embeds: [embed('🔓 Unlinked', COLORS.warn, [], 'This Discord account no longer controls your premium account.')] };
}

const HANDLERS = {
  stock: cmdStock, restock: cmdRestock, genkey: cmdGenkey, boost: cmdBoost,
  job: cmdJob, jobs: cmdJobs, key: cmdKey, revoke: cmdRevoke, balance: cmdBalance,
  link: cmdLink, unlink: cmdUnlink,
};

/* ------------------------------- dispatching ------------------------------ */
async function run(name, options, interaction, ctx = {}) {
  try {
    return await HANDLERS[name](options, interaction, ctx);
  } catch (err) {
    const k = kitFor(ctx);
    if (err && err.status && err.status < 500) return k.fail(err.message);
    console.error(`[discord] /${name} failed:`, err && err.message ? err.message : err);
    return k.fail('Something went wrong — check the server logs.');
  }
}

async function followUp(interaction, data) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed_mentions: { parse: [] }, ...data }),
      signal: ctrl.signal,
    });
  } catch (err) {
    console.error('[discord] follow-up failed:', err.message);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Returns { response, after? }. `response` is sent to Discord right away; `after()` (only on hosts that
 * keep running after the response — not serverless) finishes a slow command and edits the message.
 */
const replyOf = (data, name) => ({ type: 4, data: { ...(PRIVATE.has(name) ? { flags: 64 } : {}), allowed_mentions: { parse: [] }, ...data } });
const optionsOf = (interaction) => Object.fromEntries(((interaction.data && interaction.data.options) || []).map((o) => [o.name, o.value]));

/** Runs a command for a known caller, deferring the slow ones when the host allows it. */
async function execute(interaction, name, ctx) {
  const options = optionsOf(interaction);
  if (SLOW.has(name) && !process.env.VERCEL) {
    return {
      response: { type: 5, data: PRIVATE.has(name) ? { flags: 64 } : {} },
      after: async () => followUp(interaction, await run(name, options, interaction, ctx)),
    };
  }
  return { response: replyOf(await run(name, options, interaction, ctx), name) };
}

async function handleInteraction(interaction) {
  if (!interaction || interaction.type === 1) return { response: { type: 1 } }; // PING
  if (interaction.type !== 2) return { response: { type: 4, data: { flags: 64, content: 'Unsupported interaction.' } } };

  const reply = replyOf;
  const userId = discordUserId(interaction);
  const name = interaction.data && interaction.data.name;
  if (!HANDLERS[name]) return { response: reply(fail('Unknown command.')) };

  // Who is calling? An admin works on the platform; a linked, active premium account on its own stock.
  let ctx = null;
  if (adminIds().has(userId)) {
    ctx = { admin: true, ownerId: null };
  } else {
    let premium = null;
    try { premium = await require('./discordPremium').resolve(userId); } catch { premium = null; }
    if (premium) ctx = { admin: false, ownerId: premium.id, user: premium };
  }
  if (!ctx) {
    if (name === 'link') return { response: reply(await run(name, optionsOf(interaction), interaction, {})) };   // how a premium account gets access
    const hint = adminIds().size ? '' : ' (Admins: DISCORD_ADMIN_IDS is not set on the server.)';
    return { response: reply(fail(`Link your premium account first: generate a code in your panel (API tab → Shared bot), then run /link here.${hint}`)) };
  }
  return execute(interaction, name, ctx);
}

/**
 * A premium account's OWN bot (its own Discord application, in its own server).
 * `owner` = { id, username, boost_price, applicationId, allowedIds[] } — loaded by routes/discord.js
 * after the signature was checked with the account's own public key. Every command acts on this
 * account's stock only, and only the Discord users it listed may run them.
 */
async function handleOwnedInteraction(interaction, owner) {
  if (!interaction || interaction.type === 1) return { response: { type: 1 } };
  if (interaction.type !== 2) return { response: { type: 4, data: { flags: 64, content: 'Unsupported interaction.' } } };

  const name = interaction.data && interaction.data.name;
  if (!HANDLERS[name] || name === 'link' || name === 'unlink') return { response: replyOf(fail('Unknown command.')) };
  if (String(interaction.application_id || '') !== String(owner.applicationId || '')) {
    return { response: replyOf(fail('This bot is not set up for this application.')) };
  }
  if (!owner.allowedIds.includes(discordUserId(interaction))) {
    return { response: replyOf(fail('You are not allowed to use this bot. The owner adds Discord user ids in the panel (API tab → Your own bot).')) };
  }
  return execute(interaction, name, { admin: false, ownerId: owner.id, user: owner, own: true });
}

module.exports = { verifySignature, handleInteraction, handleOwnedInteraction, adminIds, kitFor };
