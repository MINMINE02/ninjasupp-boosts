'use strict';

/* Extra admin commands of the Ninja Boost Discord bot: accounts, premium (reseller) access, wallet funds,
 * premium keys, deposits, stats, settings, SellAuth and the platform key list.
 * Plugged into services/discordBot.js (handlers are keyed "group sub", e.g. "premium add").
 * Same rules as the admin panel routes: admin accounts are protected, passwords are hashed,
 * and every change is written to the activity log (admin_audit). */

const crypto = require('crypto');
const supabase = require('../config/supabase');
const { generateKeyCode } = require('../utils/helpers');
const { getConfig, setConfig } = require('./config');
const { getSettings, updateSettings } = require('./settings');

const HEAD = { count: 'exact', head: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const n = (v) => Number(v || 0);

module.exports = function build({ embed, field, E, COLORS, num, ago, bar, userError, count }) {
  const money = (v) => `$${n(v).toFixed(2)}`;

  /* ----------------------------- shared helpers ---------------------------- */
  async function findUser(name) {
    const username = String(name || '').trim();
    if (!username) throw userError('Give a username');
    let { data: u } = await supabase.from('users').select('*').eq('username', username).maybeSingle();
    if (!u) {
      const safe = username.replace(/[\\%_]/g, (c) => `\\${c}`);
      ({ data: u } = await supabase.from('users').select('*').ilike('username', safe).limit(1).maybeSingle());
    }
    if (!u) throw userError(`No account named **${username.slice(0, 40)}**`, 404);
    return u;
  }

  const notAdmin = (u, what) => {
    if (u.role === 'admin') throw userError(`The admin account cannot be ${what}.`, 400);
  };

  async function audit(interaction, path, summary) {
    try {
      const uid = String((interaction.member && interaction.member.user && interaction.member.user.id) || (interaction.user && interaction.user.id) || '');
      await supabase.from('admin_audit').insert({
        admin_id: null,
        admin_name: `discord:${uid}`.slice(0, 60),
        method: 'DISCORD',
        path: String(path).slice(0, 200),
        status: 200,
        summary: summary ? String(summary).slice(0, 240) : null,
      });
    } catch { /* the log is optional */ }
  }

  const userLine = (u) => `**${u.username}**`;

  /* --------------------------------- user ---------------------------------- */
  async function userInfo(o) {
    const u = await findUser(o.username);
    const id = u.id;
    const [jobs, deps, keys, stockUnused, stockUsed] = await Promise.all([
      supabase.from('jobs').select('boosts_delivered, mode, status').or(`user_id.eq.${id},owner_id.eq.${id}`).limit(20000),
      supabase.from('deposits').select('usd_amount, status').eq('user_id', id).limit(5000),
      u.reseller ? supabase.from('redeem_keys').select('redeemed_at').eq('owner_id', id).limit(100000) : Promise.resolve({ data: [] }),
      u.reseller ? count(supabase.from('stock_tokens').select('*', HEAD).eq('owner_id', id).eq('status', 'unused')) : Promise.resolve(0),
      u.reseller ? count(supabase.from('stock_tokens').select('*', HEAD).eq('owner_id', id).eq('status', 'used')) : Promise.resolve(0),
    ]);
    const J = (jobs.data || []).filter((j) => j.mode !== 'join');
    const boosts = J.reduce((t, j) => t + n(j.boosts_delivered), 0);
    const failed = J.filter((j) => j.status === 'failed').length;
    const paid = (deps.data || []).filter((d) => d.status === 'completed').reduce((t, d) => t + n(d.usd_amount), 0);
    const K = keys.data || [];
    const fields = [
      field(`${E.owner} Role`, u.role === 'admin' ? 'Admin' : u.reseller ? 'Premium' : 'Member'),
      field(`${E.balance} Wallet`, `**${money(u.balance)}**`),
      field(`${u.disabled ? E.no : E.ok} Status`, u.disabled ? 'Suspended' : 'Active'),
      field(`${E.boost} Boosts delivered`, `**${num(boosts)}**`),
      field(`${E.jobs} Jobs`, `**${num(J.length)}**${failed ? `\n-# ${num(failed)} failed` : ''}`),
      field(`${E.up} Deposited`, `**${money(paid)}**`),
      field(`${E.time} Joined`, ago(u.created_at)),
    ];
    if (u.reseller) {
      fields.push(
        field(`${E.crown} Price / boost`, n(u.boost_price) ? `**${money(u.boost_price)}**` : 'free'),
        field(`${E.key} Keys`, `**${num(K.length)}** (${num(K.filter((k) => !k.redeemed_at).length)} unused)`),
        field(`${E.stock} Own stock`, `**${num(stockUnused)}** unused · ${num(stockUsed)} used`),
        field(`${E.link} Redeem page`, u.redeem_slug ? `/r/${u.redeem_slug}` : '—'),
        field(`${E.setting} API key`, u.api_key_prefix ? `\`${u.api_key_prefix}…\`` : '—'),
      );
    }
    if (u.admin_note) fields.push(field(`${E.note} Note`, u.admin_note, false));
    return { embeds: [embed(`${E.member} ${u.username}`, u.disabled ? COLORS.bad : COLORS.info, fields, null, { thumb: true })] };
  }

  async function userList(o) {
    const filter = o.filter || 'all';
    let q = supabase.from('users').select('username, role, balance, reseller, disabled, created_at').order('created_at', { ascending: false }).limit(15);
    if (filter === 'premium') q = q.eq('reseller', true);
    if (filter === 'suspended') q = q.eq('disabled', true);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || !data.length) return { embeds: [embed(`${E.member} No account`, COLORS.info, [], `${E.dot} Nothing matches this filter.`)] };
    const lines = data.map((u) => `${u.disabled ? E.no : u.reseller ? E.crown : E.dot} **${u.username}** ${E.arrow} ${money(u.balance)} · ${E.time} ${ago(u.created_at)}`);
    return { embeds: [embed(`${E.member} Accounts · ${filter}`, COLORS.info, [], `${lines.join('\n')}\n\n-# Latest ${data.length}. Details: \`/user info\`.`)] };
  }

  async function userSuspend(o, interaction, disabled = true) {
    const u = await findUser(o.username);
    notAdmin(u, 'suspended');
    const { error } = await supabase.from('users').update({ disabled }).eq('id', u.id);
    if (error) throw error;
    await audit(interaction, `/users/${u.username}/disabled`, `disabled=${disabled}`);
    return { embeds: [embed(`${disabled ? E.ban : E.ok} ${disabled ? 'Account suspended' : 'Account reactivated'}`, disabled ? COLORS.warn : COLORS.ok,
      [field(`${E.member} Account`, userLine(u))], disabled ? `${E.arrow} They can no longer sign in.` : `${E.arrow} They can sign in again.`)] };
  }

  async function userPassword(o, interaction) {
    const u = await findUser(o.username);
    notAdmin(u, 'changed here (use the panel)');
    const generated = !o.password;
    const password = generated ? crypto.randomBytes(9).toString('base64url') : String(o.password);
    if (password.length < 8 || password.length > 128) throw userError('The password must be 8 to 128 characters.');
    const bcrypt = require('bcryptjs');
    const password_hash = await bcrypt.hash(password, 10);
    const { error } = await supabase.from('users').update({ password_hash }).eq('id', u.id);
    if (error) throw error;
    await audit(interaction, `/users/${u.username}/password`, 'password reset');
    return { embeds: [embed(`${E.ok} Password changed`, COLORS.ok, [
      field(`${E.member} Account`, userLine(u)),
      field(`${E.key} New password`, `\`${password}\``),
    ], `${E.arrow} ${generated ? 'A random password was generated. ' : ''}Send it to the user privately.`)] };
  }

  async function userNote(o, interaction) {
    const u = await findUser(o.username);
    const note = String(o.text || '').trim().slice(0, 1000) || null;
    const { error } = await supabase.from('users').update({ admin_note: note }).eq('id', u.id);
    if (error) throw error;
    await audit(interaction, `/users/${u.username}/note`, note ? 'note saved' : 'note cleared');
    return { embeds: [embed(`${E.note} ${note ? 'Note saved' : 'Note cleared'}`, COLORS.ok, [field(`${E.member} Account`, userLine(u))], note || null)] };
  }

  async function userDelete(o, interaction) {
    const u = await findUser(o.username);
    notAdmin(u, 'deleted');
    if (String(o.confirm || '').trim() !== u.username) throw userError(`Type the exact username in \`confirm\` to delete **${u.username}**.`, 400);
    const { error } = await supabase.from('users').delete().eq('id', u.id);
    if (error) throw error;
    await audit(interaction, `/users/${u.username}`, 'account deleted');
    return { embeds: [embed(`${E.ban} Account deleted`, COLORS.ok, [field(`${E.member} Account`, userLine(u))], `${E.ok} The account and its data links are removed.`)] };
  }

  /* -------------------------------- premium -------------------------------- */
  const priceOf = (v) => {
    const p = Number(v);
    if (!Number.isFinite(p) || p < 0 || p > 100) throw userError('The price per boost must be between 0 and 100.');
    return Number(p.toFixed(4));
  };

  async function premiumAdd(o, interaction) {
    const u = await findUser(o.username);
    notAdmin(u, 'a premium account');
    const patch = { reseller: true };
    if (o.price !== undefined) patch.boost_price = priceOf(o.price);
    const { error } = await supabase.from('users').update(patch).eq('id', u.id);
    if (error) throw error;
    await audit(interaction, `/users/${u.username}/reseller`, `enabled=true${patch.boost_price !== undefined ? ` boostPrice=${patch.boost_price}` : ''}`);
    const price = patch.boost_price !== undefined ? patch.boost_price : n(u.boost_price);
    return { embeds: [embed(`${E.crown} Premium added`, COLORS.ok, [
      field(`${E.member} Account`, userLine(u)),
      field(`${E.balance} Price / boost`, price ? `**${money(price)}**` : 'free'),
    ], `${E.ok} They now have their own stock, keys, redeem page and API.`, { thumb: true })] };
  }

  async function premiumRemove(o, interaction) {
    const u = await findUser(o.username);
    notAdmin(u, 'changed here');
    if (!u.reseller) throw userError(`**${u.username}** is not premium.`, 409);
    const { error } = await supabase.from('users').update({ reseller: false }).eq('id', u.id);
    if (error) throw error;
    await audit(interaction, `/users/${u.username}/reseller`, 'enabled=false');
    return { embeds: [embed(`${E.ban} Premium removed`, COLORS.warn, [field(`${E.member} Account`, userLine(u))], `${E.arrow} Their keys and stock are kept, but the premium tools are off.`)] };
  }

  async function premiumPrice(o, interaction) {
    const u = await findUser(o.username);
    notAdmin(u, 'changed here');
    const price = priceOf(o.price);
    const { error } = await supabase.from('users').update({ boost_price: price }).eq('id', u.id);
    if (error) throw error;
    await audit(interaction, `/users/${u.username}/reseller`, `boostPrice=${price}`);
    return { embeds: [embed(`${E.balance} Price saved`, COLORS.ok, [
      field(`${E.member} Account`, userLine(u)),
      field(`${E.crown} Price / boost`, price ? `**${money(price)}**` : 'free'),
    ])] };
  }

  async function premiumList() {
    const { data, error } = await supabase.from('users').select('username, balance, boost_price, disabled').eq('reseller', true).order('created_at', { ascending: true }).limit(25);
    if (error) throw error;
    if (!data || !data.length) return { embeds: [embed(`${E.crown} No premium account`, COLORS.info, [], `${E.dot} Use \`/premium add\`.`)] };
    const lines = data.map((u) => `${u.disabled ? E.no : E.crown} **${u.username}** ${E.arrow} ${money(u.balance)} · ${n(u.boost_price) ? `${money(u.boost_price)}/boost` : 'free'}`);
    return { embeds: [embed(`${E.crown} Premium accounts · ${data.length}`, COLORS.info, [], lines.join('\n'))] };
  }

  /* --------------------------------- funds --------------------------------- */
  async function funds(o, interaction, sign) {
    const u = await findUser(o.username);
    const amount = Number(o.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw userError('The amount must be a positive number (max 100000).');
    const before = n(u.balance);
    const after = Math.max(0, Number((before + sign * amount).toFixed(4)));
    const { error } = await supabase.from('users').update({ balance: after }).eq('id', u.id);
    if (error) throw error;
    await audit(interaction, `/users/${u.username}/balance`, `amount=${sign * amount}`);
    return { embeds: [embed(`${E.balance} ${sign > 0 ? 'Funds added' : 'Funds removed'}`, sign > 0 ? COLORS.ok : COLORS.warn, [
      field(`${E.member} Account`, userLine(u)),
      field(`${sign > 0 ? E.up : E.ban} Amount`, `**${money(amount)}**`),
      field(`${E.crown} Wallet`, `${money(before)} ${E.arrow} **${money(after)}**`),
    ])] };
  }

  /* ------------------------------ premium keys ----------------------------- */
  async function pkeysGive(o, interaction) {
    const u = await findUser(o.username);
    if (!u.reseller) throw userError(`**${u.username}** is not premium. Use \`/premium add\` first.`, 409);
    const boosts = Number(o.boosts);
    const cnt = o.count === undefined ? 1 : Number(o.count);
    if (!Number.isInteger(boosts) || boosts < 1 || boosts > 1000) throw userError('Boosts per key must be between 1 and 1000.');
    if (!Number.isInteger(cnt) || cnt < 1 || cnt > 100) throw userError('Number of keys must be between 1 and 100.');
    const note = String(o.note || '').trim().slice(0, 120) || 'created by admin';
    const seen = new Set();
    const rows = [];
    while (rows.length < cnt) {
      const code = generateKeyCode();
      if (!seen.has(code)) { seen.add(code); rows.push({ code, boosts_value: boosts, source: 'admin', note, owner_id: u.id }); }
    }
    const { data, error } = await supabase.from('redeem_keys').insert(rows).select('code');
    if (error) throw error;
    await audit(interaction, `/users/${u.username}/keys`, `count=${cnt} boostsPerKey=${boosts}`);
    return { embeds: [embed(`${E.gift} ${data.length} key${data.length === 1 ? '' : 's'} added`, COLORS.ok, [
      field(`${E.member} For`, userLine(u)),
      field(`${E.boost} Boosts / key`, `**${num(boosts)}**`),
      field(`${E.key} Keys`, `**${num(data.length)}**`),
    ], `${E.copy} Use the copy button on the block below.\n\`\`\`\n${data.map((k) => k.code).join('\n')}\n\`\`\``)] };
  }

  async function pkeysClear(o, interaction) {
    const u = await findUser(o.username);
    const scope = o.scope === 'all' ? 'all' : 'unused';
    let q = supabase.from('redeem_keys').delete({ count: 'exact' }).eq('owner_id', u.id);
    if (scope === 'unused') q = q.is('redeemed_at', null);
    const { error, count: c } = await q;
    if (error) throw error;
    await audit(interaction, `/users/${u.username}/keys`, `scope=${scope}`);
    return { embeds: [embed(`${E.ban} Keys deleted`, COLORS.ok, [
      field(`${E.member} Account`, userLine(u)),
      field(`${E.key} Deleted`, `**${num(c || 0)}** (${scope})`),
    ])] };
  }

  /* ---------------------------- deposits and stats --------------------------- */
  async function deposits(o) {
    const lim = Math.min(15, Math.max(1, Number(o.count) || 8));
    const { data, error } = await supabase.from('deposits').select('user_id, currency, usd_amount, status, created_at').order('created_at', { ascending: false }).limit(lim);
    if (error) throw error;
    if (!data || !data.length) return { embeds: [embed(`${E.balance} No deposit yet`, COLORS.info, [], `${E.dot} Nothing was topped up so far.`)] };
    const ids = [...new Set(data.map((d) => d.user_id).filter(Boolean))];
    const names = {};
    if (ids.length) {
      const { data: us } = await supabase.from('users').select('id, username').in('id', ids);
      (us || []).forEach((x) => { names[x.id] = x.username; });
    }
    const icon = { completed: E.ok, pending: E.load, failed: E.no };
    const lines = data.map((d) => `${icon[d.status] || E.dot} **${money(d.usd_amount)}** ${E.arrow} ${names[d.user_id] || '—'} · ${String(d.currency || '').toUpperCase()} · ${E.time} ${ago(d.created_at)}`);
    return { embeds: [embed(`${E.balance} Latest ${data.length} deposit${data.length === 1 ? '' : 's'}`, COLORS.info, [], lines.join('\n'))] };
  }

  async function stats() {
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
    const since1 = new Date(Date.now() - 86400000).toISOString();
    const [users, premium, suspended, keys, keysUnused, stock, jobs24, jobs30, deps, bal] = await Promise.all([
      count(supabase.from('users').select('*', HEAD)),
      count(supabase.from('users').select('*', HEAD).eq('reseller', true)),
      count(supabase.from('users').select('*', HEAD).eq('disabled', true)).catch(() => 0),
      count(supabase.from('redeem_keys').select('*', HEAD)),
      count(supabase.from('redeem_keys').select('*', HEAD).is('redeemed_at', null)),
      count(supabase.from('stock_tokens').select('*', HEAD).is('owner_id', null).eq('status', 'unused')),
      supabase.from('jobs').select('boosts_delivered, mode').gte('created_at', since1).limit(20000),
      supabase.from('jobs').select('status, mode').gte('created_at', since30).limit(20000),
      supabase.from('deposits').select('usd_amount, status').limit(50000),
      supabase.from('users').select('balance').limit(50000),
    ]);
    const day = (jobs24.data || []).filter((j) => j.mode !== 'join');
    const month = (jobs30.data || []).filter((j) => j.mode !== 'join' && (j.status === 'completed' || j.status === 'failed'));
    const ok = month.filter((j) => j.status === 'completed').length;
    const rate = month.length ? ok / month.length : null;
    const revenue = (deps.data || []).filter((d) => d.status === 'completed').reduce((t, d) => t + n(d.usd_amount), 0);
    const wallets = (bal.data || []).reduce((t, u) => t + n(u.balance), 0);
    return { embeds: [embed(`${E.crown} Stats`, COLORS.info, [
      field(`${E.member} Accounts`, `**${num(users)}**\n-# ${num(premium)} premium · ${num(suspended)} suspended`),
      field(`${E.key} Keys`, `**${num(keys)}**\n-# ${num(keysUnused)} unused`),
      field(`${E.stock} Platform stock`, `**${num(stock)}** unused`),
      field(`${E.boost} Last 24 h`, `**${num(day.reduce((t, j) => t + n(j.boosts_delivered), 0))}** boosts\n-# ${num(day.length)} job${day.length === 1 ? '' : 's'}`),
      field(`${E.up} Deposits`, `**${money(revenue)}** in total`),
      field(`${E.balance} Wallets`, `**${money(wallets)}** held`),
      field(rate !== null && rate < 0.8 ? `${E.warn} Success rate (30 d)` : `${E.ok} Success rate (30 d)`, rate === null ? '—' : `${bar(rate)} **${Math.round(rate * 100)}%**\n-# ${num(ok)} done · ${num(month.length - ok)} failed`, false),
    ], `${E.dot} Platform overview`, { thumb: true })] };
  }

  /* ------------------------------ platform keys ------------------------------ */
  async function keysList(o) {
    const filter = o.filter || 'unused';
    const lim = Math.min(20, Math.max(1, Number(o.count) || 10));
    let q = supabase.from('redeem_keys').select('code, boosts_value, boosts_delivered, redeemed_at, note, created_at').is('owner_id', null).order('created_at', { ascending: false }).limit(lim);
    if (filter === 'unused') q = q.is('redeemed_at', null);
    if (filter === 'used') q = q.not('redeemed_at', 'is', null);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || !data.length) return { embeds: [embed(`${E.key} No ${filter === 'all' ? '' : filter + ' '}key`, COLORS.info, [], `${E.dot} Use \`/genkey\` to create some.`)] };
    const lines = data.map((k) => `${k.redeemed_at ? E.no : E.ok} \`${k.code}\` ${E.arrow} **${num(k.boosts_value)}** boosts${k.note ? ` · ${String(k.note).slice(0, 30)}` : ''} · ${E.time} ${ago(k.created_at)}`);
    return { embeds: [embed(`${E.key} Platform keys · ${filter}`, COLORS.info, [], `${lines.join('\n')}\n\n-# Latest ${data.length}. Details: \`/key\`.`)] };
  }

  /* -------------------------------- settings --------------------------------- */
  async function settingCaptcha(o, interaction) {
    const v = Number(o.price);
    if (!Number.isFinite(v) || v < 0 || v > 10) throw userError('The price must be between 0 and 10.');
    const s = await updateSettings({ captcha_cost: v });
    await audit(interaction, '/settings', 'captcha cost changed');
    return { embeds: [embed(`${E.setting} Setting saved`, COLORS.ok, [field(`${E.balance} Captcha price`, `**$${n(s.captcha_cost)}**`)])] };
  }

  async function settingSupport(o, interaction) {
    const url = String(o.url || '').trim();
    if (url && !/^https?:\/\//i.test(url)) throw userError('The support link must start with http(s)://');
    await setConfig('support_server_url', url);
    await audit(interaction, '/settings', 'support link changed');
    return { embeds: [embed(`${E.setting} Setting saved`, COLORS.ok, [field(`${E.link} Support link`, url || '— (cleared)')])] };
  }

  /* -------------------------------- SellAuth --------------------------------- */
  async function sellauthMode(o, interaction) {
    const mode = o.mode === 'key' ? 'key' : 'direct';
    await setConfig('sellauth_delivery_mode', mode);
    await audit(interaction, '/sellauth', `deliveryMode=${mode}`);
    return { embeds: [embed(`${E.setting} SellAuth delivery`, COLORS.ok, [field(`${E.boost} On each order`, mode === 'direct' ? 'Boost the buyer\'s server directly' : 'Send a key')])] };
  }

  async function sellauthList() {
    const [{ data: products }, mode, def] = await Promise.all([
      supabase.from('sellauth_products').select('sellauth_id, label, boosts_value').is('owner_id', null).order('created_at', { ascending: false }).limit(25),
      getConfig('sellauth_delivery_mode'),
      getConfig('sellauth_default_boosts'),
    ]);
    const lines = (products || []).map((p) => `${E.link} \`${p.sellauth_id}\` ${E.arrow} **${num(p.boosts_value)}** boosts${p.label ? ` · ${String(p.label).slice(0, 30)}` : ''}`);
    return { embeds: [embed(`${E.balance} SellAuth`, COLORS.info, [
      field(`${E.setting} Delivery`, mode === 'key' ? 'key' : 'direct boost'),
      field(`${E.boost} Default boosts`, n(def) ? `**${num(def)}**` : '—'),
    ], lines.length ? lines.join('\n') : `${E.dot} No product linked. Use \`/sellauth link\`.`)] };
  }

  async function sellauthLink(o, interaction) {
    const sid = String(o.product || '').trim();
    const boosts = Number(o.boosts);
    const label = String(o.label || '').trim().slice(0, 80);
    if (!sid) throw userError('SellAuth product or variant ID is required.');
    if (!Number.isInteger(boosts) || boosts < 1 || boosts > 1000) throw userError('Boosts must be a whole number between 1 and 1000.');
    const { data: found } = await supabase.from('sellauth_products').select('id').is('owner_id', null).eq('sellauth_id', sid).maybeSingle();
    const { error } = found
      ? await supabase.from('sellauth_products').update({ label, boosts_value: boosts }).eq('id', found.id)
      : await supabase.from('sellauth_products').insert({ sellauth_id: sid, label, boosts_value: boosts });
    if (error) throw error;
    await audit(interaction, '/sellauth/products', `boosts=${boosts}`);
    return { embeds: [embed(`${E.link} Product linked`, COLORS.ok, [
      field(`${E.key} Product ID`, `\`${sid}\``),
      field(`${E.boost} Boosts`, `**${num(boosts)}**`),
      field(`${E.note} Label`, label || '—'),
    ])] };
  }

  async function sellauthUnlink(o, interaction) {
    const sid = String(o.product || '').trim();
    if (!sid) throw userError('SellAuth product or variant ID is required.');
    const { data, error } = await supabase.from('sellauth_products').delete().is('owner_id', null).eq('sellauth_id', sid).select('id');
    if (error) throw error;
    if (!data || !data.length) throw userError('No linked product with this ID.', 404);
    await audit(interaction, '/sellauth/products', 'link removed');
    return { embeds: [embed(`${E.ban} Link removed`, COLORS.ok, [field(`${E.key} Product ID`, `\`${sid}\``)])] };
  }

  const handlers = {
    'user info': userInfo,
    'user list': userList,
    'user suspend': (o, i) => userSuspend(o, i, true),
    'user unsuspend': (o, i) => userSuspend(o, i, false),
    'user password': userPassword,
    'user note': userNote,
    'user delete': userDelete,
    'premium add': premiumAdd,
    'premium remove': premiumRemove,
    'premium price': premiumPrice,
    'premium list': premiumList,
    'funds add': (o, i) => funds(o, i, 1),
    'funds remove': (o, i) => funds(o, i, -1),
    'premiumkeys give': pkeysGive,
    'premiumkeys clear': pkeysClear,
    keys: keysList,
    deposits,
    stats,
    'setting captcha': settingCaptcha,
    'setting support': settingSupport,
    'sellauth mode': sellauthMode,
    'sellauth list': sellauthList,
    'sellauth link': sellauthLink,
    'sellauth unlink': sellauthUnlink,
  };

  // Answers that contain a secret stay private (the command line itself is hidden too).
  const privateCommands = new Set(['user password']);

  return { handlers, privateCommands };
};
