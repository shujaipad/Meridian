import React, { useState } from "react";
import { supabase } from "./supabase.js";

/**
 * Where a password-recovery link lands.
 *
 * This screen did not exist until 2026-09-11, which was a real hole rather than a
 * missing nicety: the switch from magic-link to password sign-in added
 * signInWithPassword and no way to recover one. Every forgotten password was
 * therefore a manual job for the owner in the Supabase dashboard, forever -- and on a
 * tool whose owner travels, that is an outage for whoever forgot.
 *
 * Supabase signs the user in when they follow a recovery link and fires
 * PASSWORD_RECOVERY; the session is real but provisional, and the only thing that
 * should happen while it is is setting a new password. main.jsx renders this instead
 * of the app until that is done.
 */
const C = {
  bg: "#0F1115", surface: "#161A21", border: "#252B36",
  text: "#E6E9EF", dim: "#8B93A3", gold: "#C9A227", loss: "#D2544A", gain: "#4CAF7D",
};

const inputStyle = {
  width: "100%", boxSizing: "border-box", padding: "10px 12px", fontSize: 14,
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
  color: C.text, fontFamily: "inherit",
};

// Supabase's own default minimum. Stated on screen rather than only enforced, so the
// rule is visible before it is hit.
const MIN_LENGTH = 6;

export default function SetPassword({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState({ status: "idle" });

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = password.length >= MIN_LENGTH && password === confirm;

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setState({ status: "working" });
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { setState({ status: "error", message: error.message }); return; }
    setState({ status: "done" });
    // The session from the recovery link is a normal one, so there is nothing to sign
    // in to afterwards -- clearing the recovery flag drops straight into the app.
    setTimeout(() => onDone?.(), 900);
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
        <div style={{ fontSize: 13, color: C.dim, marginBottom: 28 }}>Choose a new password</div>

        {state.status === "done" ? (
          <div style={{
            background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: 18, fontSize: 13, lineHeight: 1.6,
          }}>
            <div style={{ color: C.gain, fontWeight: 600, marginBottom: 6 }}>Password changed</div>
            <div style={{ color: C.dim }}>You are signed in. Taking you to the screens…</div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="new-password" style={{ display: "block", fontSize: 12, color: C.dim, marginBottom: 6 }}>
              New password
            </label>
            <input
              id="new-password" type="password" value={password} autoFocus
              autoComplete="new-password" onChange={(e) => setPassword(e.target.value)}
              style={{ ...inputStyle, marginBottom: 4 }}
            />
            <div style={{ fontSize: 11.5, color: tooShort ? C.loss : C.dim, marginBottom: 14 }}>
              At least {MIN_LENGTH} characters.
            </div>

            <label htmlFor="confirm-password" style={{ display: "block", fontSize: 12, color: C.dim, marginBottom: 6 }}>
              Confirm it
            </label>
            <input
              id="confirm-password" type="password" value={confirm}
              autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)}
              style={{ ...inputStyle, marginBottom: mismatch ? 4 : 14 }}
            />
            {mismatch && (
              <div style={{ fontSize: 11.5, color: C.loss, marginBottom: 14 }}>
                The two do not match.
              </div>
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
            >{state.status === "working" ? "Saving…" : "Set password"}</button>

            {state.status === "error" && (
              <div style={{ color: C.loss, fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
                {state.message}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
