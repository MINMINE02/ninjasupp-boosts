'use strict';
// A tiny in-memory stand-in for the Supabase query builder (select / filters / count / single).
class Q {
  constructor(rows) { this.rows = rows; this.f = []; this.head = false; this.lim = null; }
  select(_cols, opts) { if (opts && opts.head) this.head = true; return this; }
  eq(c, v) { this.f.push((r) => r[c] === v); return this; }
  neq(c, v) { this.f.push((r) => r[c] !== v); return this; }
  is(c, v) { this.f.push((r) => (r[c] ?? null) === v); return this; }
  not(c, _op, v) { this.f.push((r) => (r[c] ?? null) !== v); return this; }
  in(c, a) { this.f.push((r) => a.includes(r[c])); return this; }
  order() { return this; }
  limit(n) { this.lim = n; return this; }
  run() { let r = this.rows.filter((x) => this.f.every((f) => f(x))); if (this.lim != null) r = r.slice(0, this.lim); return r; }
  maybeSingle() { return Promise.resolve({ data: this.run()[0] || null, error: null }); }
  single() { return this.maybeSingle(); }
  then(res, rej) {
    const r = this.run();
    return Promise.resolve(this.head ? { count: r.length, error: null } : { data: r, error: null }).then(res, rej);
  }
}
module.exports = (tables) => ({ from: (name) => new Q(tables[name] || []) });
