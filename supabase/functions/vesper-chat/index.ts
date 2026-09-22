import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Vesper chat proxy — holds the Groq API key server-side so the frontend
// never has to embed it. Set the GROQ_API_KEY secret with:
//   supabase secrets set GROQ_API_KEY=gsk_... --project-ref trwaupqgctnvcaertmod
// or via the Supabase Dashboard: Project Settings -> Edge Functions -> Secrets.
//
// This is the plain-conversation path only. The "System Control" desktop
// agent (agent/vesper_agent.py) is a separate local process and still uses
// Claude directly, since it depends on Claude's computer-use tool — Groq
// doesn't have an equivalent for that.

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY");
// llama-3.3-70b-versatile was retired by Groq; openai/gpt-oss-120b is its
// current general-purpose replacement. Check current model names/limits at
// https://console.groq.com/docs/models (or GET api.groq.com/openai/v1/models).
const MODEL = Deno.env.get("GROQ_MODEL") ?? "openai/gpt-oss-120b";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST." }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    if (!GROQ_API_KEY) {
      return new Response(
        JSON.stringify({ error: "GROQ_API_KEY secret is not set on this Edge Function yet." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => null);
    const messages = body?.messages;
    const system = body?.system;

    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "Missing 'messages' array in request body." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Groq's API is OpenAI-compatible: system prompt is just another message
    // at the front of the array, rather than a separate top-level field.
    const groqMessages = system
      ? [{ role: "system", content: system }, ...messages]
      : messages;

    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        // openai/gpt-oss models on Groq reason before answering by default,
        // which adds latency for a voice assistant that wants short replies
        // fast — "low" keeps that reasoning brief without disabling it.
        reasoning_effort: "low",
        messages: groqMessages,
        stream: true,
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: `Groq API error ${upstream.status}: ${errText}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Stream the SSE response straight through to the browser (OpenAI-style
    // "choices[0].delta.content" chunks — script.js parses this shape).
    return new Response(upstream.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
