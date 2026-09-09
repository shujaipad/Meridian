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

// Real Supabase notifies subscribers when a sign-in succeeds, and the app relies on
// that to swap the login screen out. A stub that only returns a session leaves the
// success path untested — which is the one path that matters most.
const listeners = new Set();
const notify = (event, s) => listeners.forEach((cb) => cb(event, s));
const loggedOut = import.meta.env.VITE_FIXTURE_LOGGED_OUT === "1";

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: loggedOut ? null : session } }),
    onAuthStateChange: (cb) => {
      listeners.add(cb);
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
    },
    signOut: async () => { notify("SIGNED_OUT", null); return { error: null }; },
    signInWithOtp: async () => ({ error: null }),
    // Mirrors Supabase closely enough to exercise the screen: the right password
    // signs in and fires the state change, anything else returns the same error text.
    signInWithPassword: async ({ password }) => {
      if (password !== "correct-horse") return { data: {}, error: { message: "Invalid login credentials" } };
      notify("SIGNED_IN", session);
      return { data: { session }, error: null };
    },
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
