# Vesper

A voice-and-text AI assistant with a HUD/reactor-core interface — vanilla HTML, CSS and JavaScript on the frontend. Plain conversation runs through Groq (fast, via a Supabase Edge Function so the key never touches the browser); real desktop control (System Control) runs through Google Gemini via a separate local agent, since that's the one with a free-tier computer-use tool. The whole stack is free: no paid API is required anywhere.

## What's in here

- `index.html` — page structure
- `style.css` — the 3D core, glass panels, animations, and the responsive/mobile layout
- `script.js` — voice input/output, chat, reminders/timers/quick commands, hands-free mode, and the call to the local agent (System Control)
- `config.example.js` — template for your Supabase project details
- `config.js` — your actual values, already filled in for your project. Tracked in git (not gitignored) since it only holds a Supabase anon key, which is meant to be public — this is what lets GitHub Pages (or any static host) serve a working copy with no manual setup step
- `supabase/functions/vesper-chat/index.ts` — the Edge Function source, proxies chat to Groq (also live in your Supabase project already — this copy is here so it's in version control with the rest of the app)
- `manifest.json`, `sw.js`, `icons/` — the PWA bits (installable "Add to Home Screen" app, app-shell cache)
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

Optional: you can also set a `GROQ_MODEL` secret to override the default (`openai/gpt-oss-120b`) — check current model names at [console.groq.com/docs/models](https://console.groq.com/docs/models), since Groq's lineup changes over time (it already changed once: `llama-3.3-70b-versatile`, the original default, was retired by Groq).

Note: System Control (the desktop agent) still needs its own separate `GEMINI_API_KEY` in `agent/.env` — see the System Control section below. Groq only covers plain chat.

## Run it locally

Needs to be served over `http://localhost` (not opened as a `file://` path) for the browser to reliably grant microphone access.

1. In VS Code, install the **Live Server** extension (by Ritwick Dey).
2. Right-click `index.html` → **Open with Live Server**.
3. Allow microphone access when your browser prompts.

Or from a terminal in this folder: `npx serve .`

## Deploying (GitHub Pages)

Vesper is also live at **[chitsurolazarus-alt.github.io/vesper](https://chitsurolazarus-alt.github.io/vesper/)** via GitHub Pages, serving directly from this repo's `main` branch. This is a genuinely good way to test the mobile/PWA support on a real phone — Pages gives you real HTTPS, which voice input requires and a plain `http://<LAN-IP>` URL doesn't. `config.js` is tracked in git specifically so this works with no separate setup step; just push to `main` and Pages picks it up (usually within a minute or two). System Control still won't work from there — see "Mobile & installing as an app" below for why.

## Redeploying the Edge Function after changes

If you edit `supabase/functions/vesper-chat/index.ts`, push it back to Supabase with the CLI:

```bash
supabase functions deploy vesper-chat --project-ref trwaupqgctnvcaertmod
```

(Ask me to redeploy it for you instead, if you'd rather not install the Supabase CLI.)

## Browser support

- Voice **output** (text-to-speech) works in all modern browsers, including iOS Safari.
- Voice **input** (speech recognition) currently only works in Chrome, Edge, and other Chromium-based browsers — Firefox and Safari (including iOS Safari, even the installed PWA) don't support the Web Speech API's recognition side. Vesper detects this and falls back to typing automatically, with a message that's specific to iPhone ("try Chrome on Android, or just type") versus other unsupported browsers.

## Mobile & installing as an app

Vesper is a responsive PWA down to ~375px wide (iPhone SE and up), and can be "installed" to a phone's home screen:

- **Android (Chrome)**: open the site, then menu → **Add to Home screen** (or use the install prompt Chrome shows automatically).
- **iOS (Safari)**: open the site, tap **Share** → **Add to Home Screen**.

Installed or not, the layout reflows for narrow screens, touch targets meet the 44px minimum on touch devices, and the on-screen keyboard opening won't cover the input bar (the 3D core hides itself while you're typing on a phone, to give the transcript and input room).

**System Control cannot work from a phone.** The local agent (`agent/vesper_agent.py`) only listens on `127.0.0.1` — your PC's own loopback address, which nothing on another device (including your phone, even on the same Wi-Fi) can reach. This is a deliberate choice, not a bug: opening the agent up to the network means anything else on that network could potentially issue desktop-control commands to your PC. On a phone, Vesper works fully for plain chat, reminders, timers, and the other chat-path features — System Control just stays off, since the agent is unreachable. If you want LAN-reachable System Control from a phone despite the added exposure, ask and it can be added (binding to `0.0.0.0` plus a shared-secret header check) — it isn't set up that way today.

## New JARVIS-style features

All of these are free — no new paid API or service was added.

- **Reminders**: say or type things like *"remind me to call the client in 20 minutes"* or *"remind me at 3pm to send the invoice."* Groq (the same model already used for chat) extracts the delay and message — no hand-rolled date parsing — and Vesper schedules it client-side. Reminders persist in `localStorage` across reloads, but **only fire while this browser tab is open**; there's no background service. When one fires, Vesper speaks it, shows an in-page banner, and (if you've granted permission) also fires a system Notification.
- **Conversation memory**: recent chat history persists in `localStorage`, so refreshing the page doesn't lose the conversation. Say *"clear the conversation"* or click the **CLEAR** pill to reset it.
- **Hands-free mode**: click the mic button (or the **HANDS-FREE: OFF** pill — both do the same thing and stay in sync) to turn on continuous listening — off by default, and both light up cyan while it's active, so it's never ambiguous whether the mic is live. Once it's on, there's no wake word and no clicking per turn — just talk, like a real conversation, and only press something for an actual Approve/Deny confirmation. Since the mic keeps listening while Vesper replies (that's what makes barge-in work), a lightweight guard ignores anything that closely matches what she just said, so she doesn't hear herself through the speakers and respond to it.
- **Quick commands (skip the LLM, instant)**: *"set a timer for 5 minutes"*, basic math (*"what's 24 times 7"*), unit conversions (*"10 km to miles"*, *"75 f to c"*), and *"what can you do"* for a capability summary — all handled locally in `script.js` with no network call.
- **Voice barge-in**: start talking (or, in hands-free mode, just start speaking) and Vesper immediately stops talking, instead of waiting to finish its sentence.

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
- **It's beta technology.** Gemini's computer-use tool (the vision-based screen control) is a newer capability and won't be perfectly reliable — it can misclick, misread small text, or need a couple of tries on fiddly UI. It's genuinely good at things like "open X and type Y" or "check if Y is running"; it's more error-prone on precise, fast, multi-step GUI work. Verified working end-to-end (a plain "take a screenshot and describe what's focused" task ran successfully), but note the free tier caps computer-use specifically at **20 requests/day** — each step of a task uses one request, so a handful of multi-step tasks can exhaust it; the error message will say so plainly if you hit it.
- **The model name and response handling in `vesper_agent.py` may need updating over time** — check [ai.google.dev/gemini-api/docs](https://ai.google.dev/gemini-api/docs) if it stops working after a while; Google occasionally changes model names and API shapes as the tool evolves.
- Close the terminal running `vesper_agent.py` (or Ctrl+C) any time to shut the agent down completely — the web page keeps working for plain conversation either way, it just falls back to the Supabase path.
