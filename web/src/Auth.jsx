import React, { useState } from "react";
import { supabase } from "./supabase.js";

// Invite-only (§6.6). There is deliberately no sign-up: accounts exist only because
// the owner created them in the Supabase dashboard, and this screen only signs an
// existing one in. A "create account" link is the whole difference between a private
// tool and a public one, so it does not exist here.
//
// Password first, magic link as a fallback. The link-only flow was the original
// default and was the wrong call for a tool used daily by a handful of invited
// people: every sign-in meant an inbox round-trip, which is friction the security
// does not pay for at this size. The link stays available for a device where typing
// a password is awkward.
//
// signInWithPassword is the ONLY authentication call here; there is no signUp
// anywhere in the app. Supabase's own errors are shown verbatim rather than
// interpreted, because guessing at "wrong password" vs "no such user" would leak
// which addresses have accounts.
const C = {
  bg: "#0F1115", surface: "#161A21", border: "#252B36",
  text: "#E6E9EF", dim: "#8B93A3", gold: "#C9A227", loss: "#D2544A",
};

const inputStyle = {
  width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 14,
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
  color: C.text, fontFamily: "inherit",
};

const linkButton = {
  background: "transparent", border: "none", padding: 0,
  color: C.gold, fontSize: 12.5, cursor: "pointer", fontFamily: "inherit",
  textAlign: "left",
};

export default function Auth({ linkError = null }) {
  const [mode, setMode] = useState("password");   // "password" | "link" | "reset"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState({ status: "idle" });

  const canSubmit = email.trim() && (mode === "password" ? Boolean(password) : true);

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setState({ status: "working" });

    if (mode === "password") {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(), password,
      });
      // On success onAuthStateChange swaps this screen out; nothing to do here.
      setState(error ? { status: "error", message: error.message } : { status: "idle" });
      return;
    }

    if (mode === "reset") {
      // redirectTo is passed explicitly and is NOT optional here. Without it Supabase
      // falls back to the project's Site URL, which ships as http://localhost:3000 --
      // and a recovery mail pointing at localhost is a link nobody can follow. That is
      // exactly what happened on 2026-09-11. Passing window.location.origin means the
      // link comes back to whatever host the request was made from.
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: window.location.origin,
      });
      setState(error ? { status: "error", message: error.message } : { status: "sent" });
      return;
    }

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: window.location.origin,
        // The decisive line: without it Supabase creates an account for any address
        // that asks, which would make an invite-only app open to anyone.
        shouldCreateUser: false,
      },
    });
    setState(error ? { status: "error", message: error.message } : { status: "sent" });
  }

  return (
    <div style={{
      minHeight: "100vh", background: C.bg, color: C.text, display: "flex",
      alignItems: "center", justifyContent: "center", padding: 24,
      fontFamily: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{
          fontFamily: "'IBM Plex Serif', Georgia, serif", fontSize: 30, fontWeight: 600,
          letterSpacing: "-0.01em", color: C.gold, marginBottom: 4,
        }}>Meridian</div>
        <div style={{ fontSize: 13, color: C.dim, marginBottom: 28 }}>
          Fundamental + technical signal ledger
        </div>

        {linkError && state.status === "idle" && (
          <div style={{
            background: C.surface, border: `1px solid ${C.loss}`, borderRadius: 8,
            padding: 14, fontSize: 12.5, lineHeight: 1.6, color: C.dim, marginBottom: 18,
          }}>
            <div style={{ color: C.loss, fontWeight: 600, marginBottom: 4 }}>That link did not work</div>
            {linkError}
          </div>
        )}

        {state.status === "sent" ? (
          <div style={{
            background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: 18, fontSize: 13, lineHeight: 1.6,
          }}>
            <div style={{ color: C.gold, fontWeight: 600, marginBottom: 6 }}>Check your email</div>
            <div style={{ color: C.dim }}>
              If <span style={{ color: C.text }}>{email}</span> has access, a{" "}
              {mode === "reset" ? "password-reset" : "sign-in"} link is on its way. It expires in
              an hour, and works once.
            </div>
            <button
              onClick={() => { setMode("password"); setState({ status: "idle" }); }}
              style={{
                marginTop: 14, background: "transparent", border: "none", padding: 0,
                color: C.gold, fontSize: 12.5, cursor: "pointer", fontFamily: "inherit",
              }}
            >Use a password instead</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="email" style={{ display: "block", fontSize: 12, color: C.dim, marginBottom: 6 }}>
              Email address
            </label>
            <input
              id="email" type="email" value={email} autoComplete="username" autoFocus
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
              style={{ ...inputStyle, marginBottom: mode === "password" ? 14 : 12 }}
            />

            {mode === "password" && (
              <>
                <label htmlFor="password" style={{ display: "block", fontSize: 12, color: C.dim, marginBottom: 6 }}>
                  Password
                </label>
                <input
                  id="password" type="password" value={password} autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                  style={{ ...inputStyle, marginBottom: 12 }}
                />
              </>
            )}

            <button
              type="submit" disabled={state.status === "working" || !canSubmit}
              style={{
                width: "100%", padding: "10px 12px", fontSize: 14, fontWeight: 600,
                background: canSubmit ? C.gold : C.surface,
                color: canSubmit ? "#0F1115" : C.dim,
                border: `1px solid ${canSubmit ? C.gold : C.border}`,
                borderRadius: 6, cursor: canSubmit ? "pointer" : "default", fontFamily: "inherit",
              }}
            >
              {state.status === "working" ? "Working…"
                : mode === "password" ? "Sign in"
                : mode === "reset" ? "Email me a reset link"
                : "Email me a sign-in link"}
            </button>

            {state.status === "error" && (
              <div style={{ color: C.loss, fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
                {state.message}
              </div>
            )}

            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
              <button
                type="button"
                onClick={() => { setMode(mode === "password" ? "link" : "password"); setState({ status: "idle" }); }}
                style={linkButton}
              >
                {mode === "password" ? "Email me a sign-in link instead" : "Use a password instead"}
              </button>
              {mode !== "reset" && (
                <button
                  type="button"
                  onClick={() => { setMode("reset"); setState({ status: "idle" }); }}
                  style={linkButton}
                >Forgot your password?</button>
              )}
            </div>

            <div style={{ color: C.dim, fontSize: 11.5, marginTop: 16, lineHeight: 1.6 }}>
              Meridian is invite-only. Access is granted by the owner — there is no sign-up.
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
