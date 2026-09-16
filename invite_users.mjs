/**
 * Create accounts for invited users, without sending a single email.
 *
 *   node invite_users.mjs --emails "a@x.com,b@y.com" [--dry-run]
 *   node invite_users.mjs --emails a@x.com --reset          (new password, same account)
 *
 * WHY NOT THE DASHBOARD'S "INVITE USER". Supabase's built-in email service "will
 * refuse to deliver messages to addresses that are not part of the project's team" and
 * is capped at 2 messages an hour. So a dashboard invite to someone outside the
 * project's Supabase organisation is not slow or unreliable — it does not arrive at
 * all. Adding each invitee to the team so it would arrive is not a workaround: that
 * hands them the dashboard, and with it the database.
 *
 * Custom SMTP fixes it properly and needs a verified sending domain (§8, not yet
 * bought). Resend's shared sender cannot substitute — it only delivers to the Resend
 * account holder's own address. Until the domain exists, email is not a channel this
 * project has for reaching anyone but its owner.
 *
 * So: no email. The Admin API creates the account with a password already set and the
 * address already confirmed, and the owner passes the credentials on by whatever
 * channel they were going to send the invitation link through anyway. The user changes
 * it from inside the app on first sign-in, which needs no mail server at all.
 *
 * A GENERATED PASSWORD IS PRINTED, AND THIS REPOSITORY IS PUBLIC. Those two facts do
 * not go together, so they are not allowed to: run inside GitHub Actions without
 * INVITE_PASSWORD set and this refuses outright rather than writing a live credential
 * into a world-readable log. Set INVITE_PASSWORD as a repository secret and Actions
 * masks it everywhere, including here — the owner already knows the value, so nothing
 * needs to be read back out of the run.
 *
 * Run locally, with no INVITE_PASSWORD, it generates one per person and prints it once.
 * That is a password in a terminal rather than on the internet, which is the whole
 * difference.
 */
import { randomBytes } from "node:crypto";

import { connect } from "./meridian-io.js";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const DRY = process.argv.includes("--dry-run");
const RESET = process.argv.includes("--reset");

const emails = (arg("emails") ?? "")
  .split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);

if (!emails.length) {
  console.error("Usage: node invite_users.mjs --emails \"a@x.com,b@y.com\" [--reset] [--dry-run]");
  process.exit(2);
}
// Refused rather than trimmed. §6.6 caps this at 100 invited users, and a typo that
// turns one address into forty is the kind of thing worth stopping at the door.
if (emails.length > 20) {
  console.error(`${emails.length} addresses in one run. That is more than this is for; do it in batches.`);
  process.exit(1);
}
const bad = emails.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
if (bad.length) {
  console.error(`Not an email address: ${bad.join(", ")}`);
  process.exit(1);
}

// Readable aloud and over a phone: no ambiguous characters, grouped in fours.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function password() {
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

// One password for the batch when the owner supplies it; one each when generating.
// Sharing a password across a batch is a real weakness and a deliberate one: the
// alternative on a public repository is publishing distinct live credentials, and the
// app can change it from inside in two clicks with no mail server involved.
const SUPPLIED = process.env.INVITE_PASSWORD || null;
if (SUPPLIED && SUPPLIED.length < 10) {
  console.error("INVITE_PASSWORD is shorter than 10 characters. Pick a longer one.");
  process.exit(1);
}
// The guard that matters. Actions logs on a public repository are readable by anyone.
if (!SUPPLIED && process.env.GITHUB_ACTIONS === "true" && !DRY) {
  console.error("Refusing to generate passwords inside GitHub Actions.");
  console.error("This repository is public, so the run log is too, and a generated");
  console.error("password printed here would be a live credential published to the world.");
  console.error("");
  console.error("Set INVITE_PASSWORD as a repository secret and run this again — Actions");
  console.error("masks secrets in logs, and you already know the value.");
  process.exit(1);
}

const db = await connect();

console.log(`${emails.length} address(es)${DRY ? " (DRY RUN — nothing is created)" : ""}\n`);

const results = [];
for (const email of emails) {
  const pw = SUPPLIED ?? password();
  if (DRY) { results.push({ email, pw, status: "would create" }); continue; }

  const { data, error } = await db.auth.admin.createUser({
    email,
    password: pw,
    // Confirmed here, because the confirmation mail could not be delivered anyway and
    // an unconfirmed account cannot sign in — it would look like a wrong password.
    email_confirm: true,
  });

  if (!error) { results.push({ email, pw, status: "created", id: data.user?.id }); continue; }

  const exists = /already/i.test(error.message);
  if (exists && RESET) {
    // The account is there; the person cannot get into it. Without deliverable mail
    // there is no self-service reset, so this is the way back in.
    const { data: list, error: lErr } = await db.auth.admin.listUsers({ perPage: 1000 });
    const user = list?.users?.find((u) => u.email?.toLowerCase() === email);
    if (lErr || !user) { results.push({ email, status: `exists, but could not be found to reset: ${lErr?.message ?? "no match"}` }); continue; }
    const { error: uErr } = await db.auth.admin.updateUserById(user.id, { password: pw });
    results.push(uErr ? { email, status: `reset failed: ${uErr.message}` }
                      : { email, pw, status: "password reset", id: user.id });
    continue;
  }
  results.push({ email, status: exists ? "already exists (pass --reset to set a new password)" : error.message });
}

const made = results.filter((r) => r.pw && r.status !== "would create");
console.log("---------------------------------------------------------------");
for (const r of results) {
  // A supplied password is never echoed: the owner has it, and this log may be public.
  const shown = r.pw && !SUPPLIED ? `   ${r.pw}` : "";
  console.log(`  ${r.email.padEnd(34)} ${r.status}${shown}`);
}
console.log("---------------------------------------------------------------");

if (made.length || DRY) {
  console.log("\nSend each person their address and password, and tell them:");
  console.log("  1. Sign in at the app with exactly these.");
  console.log("  2. Use \"Change password\" in the header to pick their own.");
  console.log(SUPPLIED
    ? "\nThe password is the one you set as INVITE_PASSWORD; it is not printed here."
    : "\nThis password is printed here and stored nowhere else.");
}

const failed = results.filter((r) => !r.pw).length;
if (failed) console.log(`\n${failed} address(es) did not get an account — see above.`);
process.exit(failed && !DRY ? 1 : 0);
