'use strict';

/* =========================================================================
 * Look of the Discord bot answers.
 *
 *  - ADMIN (ctx.admin)  -> "console" style: custom server emojis, animated
 *                          accents, author line + logo, progress bars.
 *  - everybody else     -> the classic embeds with unicode emojis (unchanged),
 *                          so premium accounts / their own bots keep what they had.
 *
 * Usage:  const K = kitFor(ctx);  const { E, embed, field, fail, ico, status } = K;
 *
 * Custom emojis only render if the bot application can use them: the bot must
 * be a member of the server that owns them (or the emojis must be uploaded as
 * Application Emojis in the Developer Portal).
 * ========================================================================= */

const COLORS = { ok: 0x22c55e, bad: 0xef4444, info: 0xff2d3f, warn: 0xf59e0b };

/* ----------------------------- admin emojis ------------------------------ */
const EMOJI = {
  // identity / status
  owner: '<:Red_Neon_Owner_Crown:1558134653884436592>',
  crown: '<:crown:1557705907029413919>',
  adminCrown: '<a:red_crown:1558134665443938414>',
  rainyCrown: '<:Rainy_red_crown:1558134688802013325>',
  siren: '<a:Red_siren:1558134658213085287>',
  fire: '<a:redfire:1558134685853552721>',
  dot: '<a:red_dot:1558134661526331482>',
  // feedback
  tick: '<a:verify_red_tick:1558134678626640023>',   // animated: titles
  cross: '<a:verify_red_cross:1558134675598344306>', // animated: titles
  done: '<a:done1:1558843167648780308>',
  ok: '<:yes:1524788199094747306>',                  // static: lists
  no: '<:ban:1557705909692792962>',                  // static: lists
  ban: '<:ban:1557705909692792962>',
  warn: '<a:Red_siren:1558134658213085287>',
  load: '<:load:1524787224116461638>',
  loading: '<a:loading:1557705901408915466>',
  // arrows
  arrow: '<:arrow:1524785794873819248>',
  arrowAnim: '<a:Animated_Arrow_Red:1552734844130431057>',
  up: '<:up:1524787902742007818>',
  // objects
  boost: '<:boost:1524785591722573834>',
  stock: '<:stock:1524785537406210179>',
  unused: '<:yes:1524788199094747306>',
  jobs: '<:dossier:1524786055578914916>',
  key: '<:ticket:1524787555479064706>',
  gift: '<:gift:1524786147660660940>',
  balance: '<:shop:1524785684823539786>',
  member: '<:member:1524787495500517499>',
  time: '<:chrono:1524787782420271226>',
  link: '<:link:1524786346152038451>',
  copy: '<:copy:1524788042605265006>',
  note: '<:letter:1524786411906273310>',
  setting: '<:setting:1524787288788304034>',
  discord: '<:discord:1524786477668503744>',
  world: '<:world:1524786207274438866>',
  bell: '<:bell:1524787714610954261>',
  ping: '<:ping:1524786621675999343>',
  rules: '<:red_rules:1558134668446933094>',
  question: '<:question:1524787974913527930>',
  trash: '<:ban:1557705909692792962>',
  unlink: '<:ban:1557705909692792962>',
};

/* ---------------------- classic (unicode) look, unchanged ---------------------- */
const PLAIN = {
  owner: '👑', crown: '👑', adminCrown: '👑', rainyCrown: '👑', siren: '🚨', fire: '🚀', dot: '•',
  tick: '✅', cross: '❌', done: '✅', ok: '✅', no: '❌', ban: '🚫', warn: '⚠️', load: '⏳', loading: '⏳',
  arrow: '➜', arrowAnim: '➜', up: '📈',
  boost: '🚀', stock: '📦', unused: '🟢', jobs: '🧾', key: '🔑', gift: '🎁', balance: '💳', member: '👤',
  time: '🕒', link: '🔗', copy: '📋', note: '📝', setting: '⚙️', discord: '💬', world: '🌐', bell: '🔔',
  ping: '📡', rules: '📜', question: '❓', trash: '🗑️', unlink: '🔓',
};

/* --------------------------------- helpers -------------------------------- */
const publicUrl = () => String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const logoUrl = () => (publicUrl() ? `${publicUrl()}/logo.png` : '');

// ▰▰▰▰▰▱▱▱▱▱  (ratio 0..1)
const bar = (ratio, size = 10) => {
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  const filled = Math.round(r * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
};

const cut = (v, max) => String(v === undefined || v === null || v === '' ? '—' : v).slice(0, max);
const plainField = (name, value, inline = true) => ({ name, value: cut(value, 1024), inline });
const styledField = (name, value, inline = true) => ({ name: String(name).slice(0, 256), value: cut(value, 1024), inline });

const plainEmbed = (title, color, fields, description) => ({
  title,
  color,
  ...(description ? { description: String(description).slice(0, 2000) } : {}),
  ...(fields && fields.length ? { fields } : {}),
  footer: { text: 'Ninja Boost' },
  timestamp: new Date().toISOString(),
});

// opts: { thumb: true } adds the logo as thumbnail (needs PUBLIC_URL)
function styledEmbed(title, color, fields, description, opts = {}) {
  const logo = logoUrl();
  return {
    author: { name: 'NINJA BOOST  •  ADMIN', ...(logo ? { icon_url: logo } : {}) },
    title: String(title).slice(0, 256),
    color,
    ...(description ? { description: String(description).slice(0, 4000) } : {}),
    ...(fields && fields.length ? { fields } : {}),
    ...(opts.thumb && logo ? { thumbnail: { url: logo } } : {}),
    footer: { text: 'Ninja Boost  ·  Admin console' },
    timestamp: new Date().toISOString(),
  };
}

function kitFor(ctx) {
  const admin = !!(ctx && ctx.admin);
  const E = admin ? EMOJI : PLAIN;
  const embed = admin ? styledEmbed : plainEmbed;
  const field = admin ? styledField : plainField;
  // emoji + space for admins, nothing for the classic look (keeps premium field names as they were)
  const ico = (name) => (admin ? `${E[name]} ` : '');
  // small grey line (admins) or plain text (classic)
  const sub = (text) => (admin ? `-# ${text}` : text);
  const status = (s, big = false) => {
    if (!admin) return { running: '🟡', completed: '🟢', failed: '🔴' }[s] || '⚪';
    if (s === 'running') return big ? E.loading : E.load;
    if (s === 'completed') return big ? E.tick : E.ok;
    if (s === 'failed') return big ? E.cross : E.no;
    return E.dot;
  };
  const fail = (message) => ({
    embeds: [admin
      ? styledEmbed(`${E.cross} Something went wrong`, COLORS.bad, [], `${E.arrow} ${String(message).slice(0, 1500)}`)
      : plainEmbed(`❌ ${message}`, COLORS.bad)],
  });
  return { admin, E, embed, field, ico, sub, status, fail, bar, COLORS };
}

module.exports = { COLORS, EMOJI, PLAIN, kitFor, bar };
