// Copy this file to "config.js".
// config.js is gitignored so it's safe to keep real values in it locally.
//
// These point at your Supabase Edge Function ("vesper-chat"), which holds
// your Anthropic API key server-side. The anon key below is meant to be
// public — it identifies your Supabase project, it doesn't grant access to
// your Anthropic account. See README.md for how to set the real secret.

const CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "PASTE_YOUR_SUPABASE_ANON_KEY_HERE"
};
