'use strict';

/**
 * Reads EVERY row of a query, page by page. Supabase/PostgREST caps a single
 * request (1000 rows by default), so a plain `.limit(20000)` would silently
 * return only the first 1000 tokens. `makeQuery` must return a fresh query
 * with a stable order (created_at, then id) each time it is called.
 */
async function fetchAll(makeQuery, { page = 1000, max = 50000 } = {}) {
  const rows = [];
  for (let from = 0; from < max; from += page) {
    const { data, error } = await makeQuery().range(from, from + page - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return rows;
}

const PAGE_SIZE = 100;

/** ?q=<start of a token>&status=unused|used|all&page=1 — for the stock lists. */
function listParams(query = {}) {
  const q = String(query.q || '').trim().slice(0, 80).replace(/[^A-Za-z0-9._\-:]/g, '');
  const status = ['unused', 'used'].includes(query.status) ? query.status : 'all';
  const page = Math.max(1, Math.min(100000, parseInt(query.page, 10) || 1));
  return { q, status, page, from: (page - 1) * PAGE_SIZE, to: page * PAGE_SIZE - 1 };
}

/** Applies the search + status filter to a stock_tokens query. */
function applyListFilters(query, { q, status }) {
  let out = query;
  if (status !== 'all') out = out.eq('status', status);
  if (q) out = out.ilike('token', `%${q.replace(/[\\%_]/g, '\\$&')}%`);
  return out;
}

module.exports = { fetchAll, listParams, applyListFilters, PAGE_SIZE };
