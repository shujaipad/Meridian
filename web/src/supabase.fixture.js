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
export const clientError = null;

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
    // Recovery. The real flow mails a link, the link signs the user in, and Supabase
    // fires PASSWORD_RECOVERY -- so the fixture fires it directly, which is what the
    // app actually responds to.
    resetPasswordForEmail: async () => ({ data: {}, error: null }),
    updateUser: async ({ password }) => {
      if (!password || password.length < 6) return { data: {}, error: { message: "Password should be at least 6 characters" } };
      return { data: { user: session.user }, error: null };
    },
    __fireRecovery: () => notify("PASSWORD_RECOVERY", session),
  },
  from(table) {
    const rows = fixture[table] || [];
    return {
      // PostgREST returns ONLY the requested columns, so the fixture must too. It
      // used to ignore the list and hand back whole rows, and that hid a real bug
      // for a full release: `asset_class` was left out of the universe select, so
      // in production every row's asset_class was undefined, every asset-class
      // filter matched nothing, and the app rendered an empty screen -- while every
      // local check passed, because the fixture supplied the column nobody asked
      // for. Projecting here is what makes `npm run check` able to catch it.
      select(columns) {
        this._columns = columns;
        return this;
      },
      async range(from, to) {
        const page = rows.slice(from, to + 1);
        const cols = this._columns;
        if (!cols || cols.trim() === "*") return { data: page, error: null };
        const wanted = cols.split(",").map((c) => c.trim()).filter(Boolean);
        const missing = wanted.filter((c) => page.length > 0 && !(c in page[0]));
        if (missing.length > 0) {
          // Real PostgREST refuses a column that does not exist rather than
          // returning it as undefined. Match that, or a typo reads as empty data.
          return { data: null, error: { message: `column ${table}.${missing[0]} does not exist` } };
        }
        return {
          data: page.map((r) => Object.fromEntries(wanted.map((c) => [c, r[c]]))),
          error: null,
        };
      },
    };
  },
};
