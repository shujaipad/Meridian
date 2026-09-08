import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import App from "@meridian/meridian.jsx";
import Auth from "./Auth.jsx";
import { loadScreens } from "./loadScreens.js";
import { installStorage } from "./storage.js";
import { configError, supabase } from "./supabase.js";

// Before anything renders: meridian.jsx reads window.storage during its first effect.
installStorage();

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

function Root() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s ?? null));
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

  if (configError) {
    return <Centered>
      <div style={{ color: C.gold, fontWeight: 600, marginBottom: 8 }}>Not configured</div>
      {configError}
    </Centered>;
  }
  if (session === undefined) return <Centered>Checking your session…</Centered>;
  if (session === null) return <Auth />;

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

createRoot(document.getElementById("root")).render(<React.StrictMode><Root /></React.StrictMode>);
