import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import App from "@meridian/meridian.jsx";
import Auth from "./Auth.jsx";
import SetPassword from "./SetPassword.jsx";
import { loadScreens } from "./loadScreens.js";
import { installStorage } from "./storage.js";
import { clientError, configError, supabase } from "./supabase.js";

// Before anything renders: meridian.jsx reads window.storage during its first effect.
installStorage();

// Fixture-mode only: lets the production check drive the recovery path, which real
// Supabase only reaches via an emailed link. Guarded on the stub exporting the hook,
// so it is absent from the real build rather than merely unused in it.
if (supabase?.auth?.__fireRecovery) window.__meridianFireRecovery = supabase.auth.__fireRecovery;

const C = { bg: "#0F1115", text: "#E6E9EF", dim: "#8B93A3", gold: "#C9A227", loss: "#D2544A" };

const Centered = ({ children }) => (
  <div style={{
    minHeight: "100vh", background: C.bg, color: C.dim, display: "flex",
    alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center",
    fontFamily: "'IBM Plex Sans', system-ui, sans-serif", fontSize: 13, lineHeight: 1.7,
  }}>
    <div style={{ maxWidth: 460 }}>{children}</div>
  </div>
);

// The prototype's App renders its own upload controls and a "sign out" has nowhere
// to live inside it, so the shell owns the session and puts the control in a fixed
// corner rather than reaching into App's header.
function SignOut() {
  return (
    <button
      onClick={() => supabase.auth.signOut()}
      style={{
        position: "fixed", top: 18, right: 18, zIndex: 50,
        background: "transparent", border: "1px solid #252B36", borderRadius: 6,
        color: C.dim, fontSize: 11, padding: "5px 10px", cursor: "pointer",
        fontFamily: "'IBM Plex Mono', monospace",
      }}
    >sign out</button>
  );
}

// Supabase returns auth failures in the URL FRAGMENT, not the query string, so the
// server never sees them and nothing surfaces them unless the app looks. An expired
// recovery link would otherwise drop the user on a plain sign-in box with no
// explanation for why the link they just followed did nothing.
function authErrorFromUrl() {
  const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  const code = p.get("error_code");
  if (!code && !p.get("error")) return null;
  // Clear it so a reload does not re-show a stale error.
  history.replaceState(null, "", window.location.pathname + window.location.search);
  const description = p.get("error_description")?.replace(/\+/g, " ");
  if (code === "otp_expired") {
    return "That link has expired or was already used. Recovery links last one hour and "
         + "work once — ask for a new one below.";
  }
  return description || p.get("error") || "The link could not be used.";
}

function Root() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // A recovery link signs the user in, but that session is provisional: the only thing
  // that should happen while it holds is choosing a new password.
  const [recovering, setRecovering] = useState(false);
  const [linkError] = useState(authErrorFromUrl);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      setSession(s ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const fetchScreens = useCallback(() => {
    setError(null);
    loadScreens().then(setData).catch((e) => setError(e.message));
  }, []);

  // Load only once there is a session. Fetching earlier would return empty rather
  // than failing — RLS filters instead of refusing — and an empty screen is a far
  // worse symptom than a login prompt.
  useEffect(() => { if (session) fetchScreens(); }, [session, fetchScreens]);

  const setupProblem = configError || clientError;
  if (setupProblem) {
    return <Centered>
      <div style={{ color: C.gold, fontWeight: 600, marginBottom: 8 }}>Meridian is not configured</div>
      {setupProblem}
    </Centered>;
  }
  if (session === undefined) return <Centered>Checking your session…</Centered>;
  if (recovering) return <SetPassword onDone={() => setRecovering(false)} />;
  if (session === null) return <Auth linkError={linkError} />;

  if (error) {
    return <Centered>
      <div style={{ color: C.loss, fontWeight: 600, marginBottom: 8 }}>Could not load the screens</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>{error}</div>
      <button onClick={fetchScreens} style={{
        marginTop: 16, background: "transparent", border: `1px solid ${C.gold}`, borderRadius: 6,
        color: C.gold, fontSize: 12, padding: "6px 14px", cursor: "pointer", fontFamily: "inherit",
      }}>Try again</button>
      <SignOut />
    </Centered>;
  }
  if (!data) return <Centered>Loading the latest screen…<SignOut /></Centered>;

  return <><SignOut /><App dataset={data} /></>;
}

// Last line of defence. Anything that throws before or during the first render —
// a module-scope failure, a bad environment variable, a broken import — otherwise
// leaves a completely blank page: no message, no clue, and nothing the person
// looking at it can report beyond "it is blank". Painting the actual error into the
// DOM turns that into something diagnosable without opening developer tools.
function fatal(err) {
  const el = document.getElementById("root");
  if (!el) return;
  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.setAttribute("style",
    "min-height:100vh;background:#0F1115;color:#8B93A3;display:flex;align-items:center;"
    + "justify-content:center;padding:24px;font:13px/1.7 system-ui,sans-serif;text-align:center");
  const inner = document.createElement("div");
  inner.setAttribute("style", "max-width:560px");
  const h = document.createElement("div");
  h.setAttribute("style", "color:#D2544A;font-weight:600;margin-bottom:10px;font-size:15px");
  h.textContent = "Meridian could not start";
  const p = document.createElement("div");
  p.setAttribute("style", "font-family:ui-monospace,monospace;font-size:12px;color:#E6E9EF;"
    + "background:#161A21;border:1px solid #252B36;border-radius:6px;padding:12px;text-align:left;"
    + "white-space:pre-wrap;word-break:break-word");
  p.textContent = String(err?.stack || err?.message || err);
  const hint = document.createElement("div");
  hint.setAttribute("style", "margin-top:12px");
  hint.textContent = "Send this message on — it names the cause exactly.";
  inner.append(h, p, hint);
  wrap.append(inner);
  el.append(wrap);
}

window.addEventListener("error", (e) => { if (!document.getElementById("root")?.firstChild) fatal(e.error || e.message); });
window.addEventListener("unhandledrejection", (e) => { if (!document.getElementById("root")?.firstChild) fatal(e.reason); });

try {
  createRoot(document.getElementById("root")).render(<React.StrictMode><Root /></React.StrictMode>);
} catch (e) {
  fatal(e);
}
