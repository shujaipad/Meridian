import React, { useState } from "react";
import { supabase } from "./supabase.js";

// Invite-only (§6.6, confirmed 2026-09-08). There is deliberately no sign-up form:
// accounts are created by the owner in the Supabase dashboard, and this screen only
// signs in an existing one. A "create account" link is the whole difference between
// a private tool and a public one, so it simply does not exist here.
//
// The magic-link flow is used rather than passwords: it means no password to store,
// reset or leak, and an invited user needs nothing but their mailbox. Supabase's own
// response is deliberately identical for a known and an unknown address, so this
// screen cannot be used to enumerate who has access — the message below says "if
// you have access" for that reason, not out of vagueness.
const C = {
  bg: "#0F1115", surface: "#161A21", border: "#252B36",
  text: "#E6E9EF", dim: "#8B93A3", gold: "#C9A227", loss: "#D2544A",
};

export default function Auth() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState({ status: "idle" });

  async function submit(e) {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setState({ status: "sending" });
    const { error } = await supabase.auth.signInWithOtp({
      email: address,
      options: {
        emailRedirectTo: window.location.origin,
        // The decisive line: without it Supabase creates an account for any address
        // that asks, which would make an invite-only app open to the world.
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

        {state.status === "sent" ? (
          <div style={{
            background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: 18, fontSize: 13, lineHeight: 1.6,
          }}>
            <div style={{ color: C.gold, fontWeight: 600, marginBottom: 6 }}>Check your email</div>
            <div style={{ color: C.dim }}>
              If <span style={{ color: C.text }}>{email}</span> has access, a sign-in link is on its way.
              It expires in an hour.
            </div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="email" style={{ display: "block", fontSize: 12, color: C.dim, marginBottom: 6 }}>
              Email address
            </label>
            <input
              id="email" type="email" value={email} autoComplete="email" autoFocus
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={{
                width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 14,
                background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
                color: C.text, marginBottom: 12, fontFamily: "inherit",
              }}
            />
            <button
              type="submit" disabled={state.status === "sending" || !email.trim()}
              style={{
                width: "100%", padding: "10px 12px", fontSize: 14, fontWeight: 600,
                background: email.trim() ? C.gold : C.surface,
                color: email.trim() ? "#0F1115" : C.dim,
                border: `1px solid ${email.trim() ? C.gold : C.border}`,
                borderRadius: 6, cursor: email.trim() ? "pointer" : "default",
                fontFamily: "inherit",
              }}
            >
              {state.status === "sending" ? "Sending…" : "Email me a sign-in link"}
            </button>
            {state.status === "error" && (
              <div style={{ color: C.loss, fontSize: 12, marginTop: 10 }}>{state.message}</div>
            )}
            <div style={{ color: C.dim, fontSize: 11.5, marginTop: 16, lineHeight: 1.6 }}>
              Meridian is invite-only. Access is granted by the owner — there is no sign-up.
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
