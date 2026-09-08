import { createClient } from "@supabase/supabase-js";

// The ANON key, never service_role. It is public by design — it ships inside the
// JavaScript bundle every visitor downloads — and that is safe here only because
// the database is default-deny at both layers: `anon` holds zero table privileges
// and every table's RLS requires an authenticated session (§6.6, proven by
// verify_rls.sql). Without a login this key can read nothing at all.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configError = !url || !anonKey
  ? "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set in the Vercel project's environment variables."
  : null;

export const supabase = configError ? null : createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});
