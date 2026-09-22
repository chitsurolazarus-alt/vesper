# Vesper

A voice-and-text AI assistant with a HUD/reactor-core interface — vanilla HTML, CSS and JavaScript on the frontend. Plain conversation runs through Groq (fast, via a Supabase Edge Function so the key never touches the browser); real desktop control (System Control) runs through Google Gemini via a separate local agent, since that's the one with a free-tier computer-use tool. The whole stack is free: no paid API is required anywhere.

## What's in here

- `index.html` — page structure
- `style.css` — the 3D core, glass panels, animations
- `script.js` — voice input/output, the call to your Edge Function (chat), and the call to the local agent (System Control)
- `config.example.js` — template for your Supabase project details
- `config.js` — your actual values, **gitignored**, already filled in for your project
- `supabase/functions/vesper-chat/index.ts` — the Edge Function source, proxies chat to Groq (also live in your Supabase project already — this copy is here so it's in version control with the rest of the app)
- `agent/` — the local Python System Control agent (see its own section below)

## How it fits together

```
Plain chat:
Browser (script.js)  --https-->  Supabase Edge Function "vesper-chat"  --https-->  Groq API
   (Supabase anon key)              (holds GROQ_API_KEY secret)

System Control (desktop actions):
Browser (script.js)  --http, localhost only-->  agent/vesper_agent.py  --https-->  Gemini API (Google)
                                                  (holds GEMINI_API_KEY in agent/.env)
```

The anon key in `config.js` is meant to be public — it just identifies your Supabase project, the same way it would in any Supabase frontend. Your actual Groq key lives only on the Edge Function, server-side, and your Gemini key lives only in `agent/.env` on this machine.

**The Edge Function is already deployed** to your Supabase project (`chitsuromaxwell@gmail.com`, ref `trwaupqgctnvcaertmod`) under the name `vesper-chat`. `config.js` already points at it.

## One thing left: set the Groq API key secret

The Edge Function needs a Groq API key as a secret — this is the one step I can't do for you, since it needs your own Groq account.

1. Get a key at **[console.groq.com](https://console.groq.com)** → **API Keys** → **Create API Key**. Groq's free tier typically doesn't require a card to get started (worth double-checking current terms on their site, since that can change).
2. Set it as a secret on the Edge Function, either:
   - **Dashboard**: your Supabase project → Edge Functions → `vesper-chat` → Secrets → add `GROQ_API_KEY` with your key.
   - **CLI**: `supabase secrets set GROQ_API_KEY=gsk_your-key --project-ref trwaupqgctnvcaertmod`

That's it — no code changes needed. Once the secret is set, Vesper's replies will start working immediately (no redeploy required).

Optional: you can also set a `GROQ_MODEL` secret to override the default (`llama-3.3-70b-versatile`) — check current model names at [console.groq.com/docs/models](https://console.groq.com/docs/models), since Groq's lineup changes over time.

Note: System Control (the desktop agent) still needs its own separate `GEMINI_API_KEY` in `agent/.env` — see the System Control section below. Groq only covers plain chat.

## Run it locally

Needs to be served over `http://localhost` (not opened as a `file://` path) for the browser to reliably grant microphone access.

1. In VS Code, install the **Live Server** extension (by Ritwick Dey).
2. Right-click `index.html` → **Open with Live Server**.
3. Allow microphone access when your browser prompts.

Or from a terminal in this folder: `npx serve .`

## Redeploying the Edge Function after changes

If you edit `supabase/functions/vesper-chat/index.ts`, push it back to Supabase with the CLI:

```bash
supabase functions deploy vesper-chat --project-ref trwaupqgctnvcaertmod
```

(Ask me to redeploy it for you instead, if you'd rather not install the Supabase CLI.)

## Browser support

- Voice **output** (text-to-speech) works in all modern browsers.
- Voice **input** (speech recognition) currently only works in Chrome, Edge, and other Chromium-based browsers — Firefox and Safari don't support the Web Speech API's recognition side. Vesper detects this and falls back to typing automatically.

## System Control — Vesper Agent (real desktop control)

`agent/vesper_agent.py` is a separate local Python server that gives Vesper real
control over this computer: opening/closing programs, running commands,
reading/writing files, and — using Gemini's vision — actually seeing your
screen and clicking/typing anywhere, the way you would. This has to be a
separate process from the web page, because a browser tab is never allowed
to reach outside itself to control other applications; that's not a
limitation of this app, it's a security boundary every browser enforces.

### Setup

1. Install Python 3.10+ if you don't have it: [python.org/downloads](https://www.python.org/downloads/).
2. In a terminal, from this project folder:
   ```bash
   cd agent
   pip install -r requirements.txt
   ```
3. Get a **free** Gemini API key: go to **[aistudio.google.com](https://aistudio.google.com)** → sign in with a Google account → **Get API key** → **Create API key**. No card is required for the free tier (worth double-checking current terms on Google's site, since that can change).
4. Copy `agent/.env.example` to `agent/.env` and paste in that key as `GEMINI_API_KEY`.
5. Start it:
   ```bash
   python vesper_agent.py
   ```
   It listens on `http://127.0.0.1:7891` and prints your detected screen resolution.
6. With `index.html` open (via Live Server), click the **SYSTEM CONTROL: OFF** pill at the top of the page to switch it on. It'll turn amber and say **ON** once it confirms the agent is reachable.
7. Now try something like *"open Notepad and type a haiku about the ocean"* or *"what processes are running right now?"*

### How the safety model works

- Opening apps, moving/clicking/typing on screen, reading files, and listing processes happen immediately — no prompt, since you asked for full desktop control.
- Closing a program, running a shell command, writing a file, or deleting anything **pauses and shows an Approve/Deny bar** on the page before it happens. Nothing risky runs without you clicking Approve.
- Every action (approved or not) is written to `agent/agent_log.txt`, so there's always a plain record of what Vesper actually did.
- Each request is capped at 25 actions, so a confused task can't loop forever — it'll stop and tell you to ask again.
- `pyautogui`'s built-in failsafe is on: slam your mouse cursor into a screen corner at any time to immediately abort whatever it's doing.

### Important things to know

- **This is powerful.** The agent can see your whole screen and act on anything on it, including things outside this project. Only run it when you intend to use it, and treat the GEMINI_API_KEY in `agent/.env` like a password — it's gitignored, keep it that way.
- **It's beta technology.** Gemini's computer-use tool (the vision-based screen control) is a newer capability and won't be perfectly reliable — it can misclick, misread small text, or need a couple of tries on fiddly UI. It's genuinely good at things like "open X and type Y" or "check if Y is running"; it's more error-prone on precise, fast, multi-step GUI work. This particular integration is also freshly written and hasn't been run end-to-end yet, so expect to do a bit of debugging the first time you use it — if something errors out, the traceback plus `agent/agent_log.txt` should point at what needs adjusting.
- **The model name and response handling in `vesper_agent.py` may need updating over time** — check [ai.google.dev/gemini-api/docs](https://ai.google.dev/gemini-api/docs) if it stops working after a while; Google occasionally changes model names and API shapes as the tool evolves.
- Close the terminal running `vesper_agent.py` (or Ctrl+C) any time to shut the agent down completely — the web page keeps working for plain conversation either way, it just falls back to the Supabase path.
