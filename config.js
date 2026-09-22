// Points at your Supabase Edge Function ("vesper-chat"), which holds the
// Groq API key server-side. This anon key is safe to have in frontend
// code — it identifies your Supabase project, it does not grant access to
// your Groq account or bypass the Edge Function's own auth check.
//
// You still need to set the GROQ_API_KEY secret on the Edge Function
// itself — see README.md for the exact steps.

const CONFIG = {
  SUPABASE_URL: "https://trwaupqgctnvcaertmod.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRyd2F1cHFnY3RudmNhZXJ0bW9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwNzg5NDUsImV4cCI6MjEwNTY1NDk0NX0.d5PzpL9VgykrjkIuOcpfXPBaB6Qb7OGhSgsqC8_90Ls"
};
