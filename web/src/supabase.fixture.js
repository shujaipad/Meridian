/**
 * Stand-in for supabase.js used only by `npm run check` (VITE_FIXTURE=1).
 *
 * It serves the exact rows compute_and_publish.mjs sends to Supabase, through the
 * same client surface loadScreens.js calls — including PostgREST's 1,000-row page
 * cap, which is the single most dangerous behaviour to get wrong here: an unpaged
 * read of technicals_daily returns 1,000 of 2,089 rows and reports no error at all.
 * A fixture that returned everything in one call would let that bug through.
 */
import fixture from "../fixture/screens.json";

export const configError = null;

const session = { user: { id: "fixture-user", email: "fixture@meridian.local" } };

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
    signInWithOtp: async () => ({ error: null }),
  },
  from(table) {
    const rows = fixture[table] || [];
    return {
      select() { return this; },
      async range(from, to) {
        return { data: rows.slice(from, to + 1), error: null };
      },
    };
  },
};
