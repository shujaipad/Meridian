/**
 * `window.storage` for the browser.
 *
 * meridian.jsx was written as a Claude artifact, where the host supplies a
 * `window.storage` key/value API. A plain browser has no such thing, so production
 * has to provide one — this was found by driving the built app rather than by
 * reading it: every screen rendered and the console filled with "Cannot read
 * properties of undefined (reading 'get')".
 *
 * Backed by localStorage, which is the honest fit for what still uses it in
 * production: watchlists and alert acknowledgements. Those are per-person
 * conveniences, not shared state — putting them in Supabase would mean new tables
 * and new RLS policies for data no one else ever reads. The cost, stated plainly:
 * they live in one browser and do not follow the user to another device. If that
 * becomes a real complaint it is a `user_watchlists` table away.
 *
 * The bulk CSV paths (chunked price history) never run in production — App skips
 * them when handed a dataset — but they are supported anyway rather than left to
 * throw, because a partial shim fails in ways that are hard to attribute.
 */
const KEY = (k) => `meridian:${k}`;

function guard(fn, fallback) {
  // Private windows, cleared site data and browsers set to block storage all throw
  // on access rather than returning empty. A screening tool must still render.
  try { return fn(); } catch { return fallback; }
}

export function installStorage() {
  if (typeof window === "undefined" || window.storage) return;
  window.storage = {
    async get(key) {
      return guard(() => {
        const value = window.localStorage.getItem(KEY(key));
        return value === null ? null : { value };
      }, null);
    },
    async set(key, value) {
      return guard(() => { window.localStorage.setItem(KEY(key), value); return true; }, false);
    },
    async delete(key) {
      return guard(() => { window.localStorage.removeItem(KEY(key)); return true; }, false);
    },
  };
}
