'use strict';

/**
 * Content of the "Premium" tab shown to accounts that do not have premium yet.
 * Stored as text in app_config (no migration needed):
 *   premium_video_url · premium_title · premium_text
 *
 * The admin pastes a normal link (YouTube, Vimeo or a direct .mp4/.webm file);
 * it is turned here into a safe embed source, so the browser only ever receives
 * a URL on a host the Content-Security-Policy allows.
 */
const { getConfig } = require('./config');

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const FILE_EXT = /\.(mp4|webm|mov|m4v)$/i;

function fail(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** Returns { kind: 'youtube'|'vimeo'|'file', src } or null when the link is not supported. */
function parseVideo(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 500) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\.|^m\./, '').toLowerCase();

  if (host === 'youtu.be') {
    const id = u.pathname.split('/')[1] || '';
    return YT_ID.test(id) ? { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${id}` } : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = u.pathname.split('/').filter(Boolean);
    let id = '';
    if (parts[0] === 'watch') id = u.searchParams.get('v') || '';
    else if (['embed', 'shorts', 'live', 'v'].includes(parts[0])) id = parts[1] || '';
    return YT_ID.test(id) ? { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${id}` } : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/(\d{6,12})/);
    return m ? { kind: 'vimeo', src: `https://player.vimeo.com/video/${m[1]}` } : null;
  }
  if (FILE_EXT.test(u.pathname)) return { kind: 'file', src: u.toString() };
  return null;
}

/** Validates the admin input; returns the cleaned values to store. */
function cleanInput({ videoUrl, title, text }) {
  const out = {};
  if (videoUrl !== undefined) {
    const v = String(videoUrl || '').trim();
    if (v && !parseVideo(v)) {
      throw fail('Unsupported video link. Use a YouTube or Vimeo link, or a direct https link to an .mp4 / .webm file.');
    }
    out.premium_video_url = v;
  }
  if (title !== undefined) {
    const t = String(title || '').trim();
    if (t.length > 80) throw fail('Title is too long (80 characters max)');
    out.premium_title = t;
  }
  if (text !== undefined) {
    const t = String(text || '').trim();
    if (t.length > 800) throw fail('Description is too long (800 characters max)');
    out.premium_text = t;
  }
  return out;
}

/** Raw values (admin editor). */
async function getRaw() {
  const [videoUrl, title, text] = await Promise.all([
    getConfig('premium_video_url'), getConfig('premium_title'), getConfig('premium_text'),
  ]);
  return { videoUrl: videoUrl || '', title: title || '', text: text || '' };
}

/** What the customer dashboard receives. */
async function getPublic() {
  const raw = await getRaw();
  const supportUrl = (await getConfig('support_server_url')) || process.env.SUPPORT_URL || 'https://discord.gg/ninjasupp';
  return {
    title: raw.title,
    text: raw.text,
    video: parseVideo(raw.videoUrl),
    supportUrl: /^https?:\/\//i.test(supportUrl) ? supportUrl : '',
  };
}

module.exports = { parseVideo, cleanInput, getRaw, getPublic };
