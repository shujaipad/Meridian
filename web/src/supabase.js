import { createClient } from "@supabase/supabase-js";

// The ANON key, never service_role. It is public by design — it ships inside the
// JavaScript bundle every visitor downloads — and that is safe only because the
// database is default-deny at both layers: `anon` holds zero table privileges and
// every table's RLS requires a session (§6.6, proven by verify_rls.sql).
//
// EVERYTHING HERE IS DEFENSIVE ON PURPOSE. createClient runs at module scope, so a
// throw takes the whole bundle down before React mounts and the page renders blank —
// no error, no message, nothing to act on. A blank page is the single worst failure
// mode to debug remotely, so every way this can fail is turned into a sentence the
// user can read on screen.
function readEnv(name) {
  const raw = import.meta.env[name];
  if (raw == null) return null;
  // Pasting into a hosting provider's environment-variable box picks up whitespace,
  // newlines, and surrounding quotes remarkably often. All three produce a value that
  // looks right in the dashboard and is wrong at runtime.
  return String(raw).trim().replace(/^['"]|['"]$/g, "") || null;
}

const url = readEnv("VITE_SUPABASE_URL");
const anonKey = readEnv("VITE_SUPABASE_ANON_KEY");

function validate() {
  const missing = [];
  if (!url) missing.push("VITE_SUPABASE_URL");
  if (!anonKey) missing.push("VITE_SUPABASE_ANON_KEY");
  if (missing.length) {
    return `Missing environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(" and ")}. `
         + "Set them in the Vercel project settings, then redeploy — environment variables "
         + "only apply to builds made after they are added.";
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `VITE_SUPABASE_URL is not a valid URL: "${url}". It should look like `
         + "https://yourproject.supabase.co — with no quotes and no trailing slash.";
  }
  if (parsed.protocol !== "https:") {
    return `VITE_SUPABASE_URL must start with https:// — got "${parsed.protocol}//".`;
  }
  if (anonKey.length < 40) {
    return `VITE_SUPABASE_ANON_KEY looks truncated (${anonKey.length} characters). `
         + "The anon key is a few hundred characters long — check it was pasted in full.";
  }
  return null;
}

export const configError = validate();

export let supabase = null;
if (!configError) {
  try {
    supabase = createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  } catch (e) {
    // Reassigning rather than throwing: main.jsx renders clientError as a readable
    // message, where a throw here would blank the page.
    supabase = null;
  }
}

export const clientError = !configError && !supabase
  ? "The Supabase client could not be created, even though both environment variables look valid. "
  + "This usually means the URL points at a project that no longer exists."
  : null;
