# Vesper

A voice-and-text AI assistant with a HUD/reactor-core interface — vanilla HTML, CSS and JavaScript on the frontend. Plain conversation runs through Groq (fast, via a Supabase Edge Function so the key never touches the browser); real desktop control (System Control) runs through a separate local agent (Gemini by default, Groq optional) that reads apps through Windows UI Automation. The whole stack is free: no paid API is required anywhere.

## What's in here

- `index.html` — page structure
- `style.css` — the 3D core, glass panels, animations, and the responsive/mobile layout
- `script.js` — voice input/output, chat, reminders/timers/quick commands, Quick Actions (call/text/email/navigate/WhatsApp/etc.), hands-free mode, and the call to the local agent (System Control)
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
- **Quick Actions (real device actions, phone or desktop)**: say things like *"call Mary"*, *"text John I'm running late"*, *"email Sarah about the invoice"*, *"navigate to the airport"*, *"open WhatsApp"*, *"open YouTube and search for lo-fi beats"*, or *"search for the nearest pharmacy"*. Groq extracts the action and its parameters (same pattern as reminders), then Vesper triggers it via a standard web deep link — `tel:`, `sms:`, `mailto:`, a Google Maps directions/search URL, `wa.me` for WhatsApp, or a Gmail/YouTube/Google search URL. These are plain URLs any web page is allowed to open; nothing OS-level or native is involved, which is exactly why this works identically on iPhone and Android with no extra permission.
  - **The real ceiling — read this before expecting more**: this launches *one specific app or action per request*. It is **not** open-ended control of the phone's screen the way System Control drives the desktop — Vesper can't see or operate your phone's UI, chain steps together, or act inside an app once it's open. Real screen-level control on mobile would need a dedicated native app (a real Android build using Accessibility Service; not achievable on iOS at all, due to Apple's sandboxing) — that's a separate, much bigger project, not something a web page can do.
  - **Saved contacts**: click the **CONTACTS** pill to add a name plus a phone number and/or email, once. Voice commands like *"call Mary"* or *"text the office"* then resolve against that list. It's stored in this browser's `localStorage` only — not in git, not synced anywhere, and never sent anywhere except inside the deep link an action itself triggers. If a name isn't found, Vesper asks for the number/email once and offers to remember it.
  - **Calling and texting need an actual phone**: `tel:`/`sms:` links only do something useful on a phone browser. On desktop, Vesper says so plainly instead of silently doing nothing. Directions, email, search, WhatsApp, Gmail, Maps and YouTube all work fine on desktop too (they just open a browser tab or your mail client).
  - **Known rough edge**: the maps/search/WhatsApp/Gmail/YouTube actions open in a new tab via `window.open`, which fires *after* the round-trip to Groq rather than inside the original click — some browsers' pop-up blockers can catch that. Vesper detects when this happens and tells you to allow pop-ups for the site rather than staying silent. Calling, texting and email don't have this issue (they hand off via same-tab navigation to a custom URL scheme instead).
  - This was built and reasoned through carefully but only exercised in a desktop browser and mobile-width emulation in this environment — it has **not** been verified on a real phone. Confirm call/text/navigate/search actually behave as expected on your own iPhone/Android before relying on it, and let me know if any deep link scheme doesn't behave as expected on a real device.

## System Control — Vesper Agent (real desktop control)

`agent/vesper_agent.py` is a separate local Python server that gives Vesper real
control over this computer: opening/closing programs, running commands,
reading/writing files, and operating other Windows apps' UI (click, type, press
keys, read what's on screen). This has to be a separate process from the web
page, because a browser tab is never allowed to reach outside itself to control
other applications; that's not a limitation of this app, it's a security
boundary every browser enforces.

### How it sees and controls the screen (changed from the earlier version)

It no longer takes screenshots and guesses pixel coordinates. It uses
[cua-driver](https://pypi.org/project/cua-driver/) (MIT), which reads apps through
**Windows UI Automation** and gives the model the screen as a **text tree of
UI elements** (`[12] Button "Send"`). The model acts by element, not by pixel.
Because the model only ever reads text and calls ordinary tools, the reasoning
model is swappable: `VESPER_REASONER=gemini` (default) or `groq` (see `llm.py`).

**The real ceiling of this approach:**
- It only works on apps that expose a usable UI Automation tree. Standard Windows/Win32/WPF/UWP apps and browsers generally do; games, canvas-rendered UIs, remote-desktop windows and some Electron apps expose little or nothing, and there is **no vision fallback** — if an element isn't in the tree, Vesper can't act on it and should say so.
- Element indices go stale when a window changes, so it re-reads the tree after acting. Multi-step GUI work can still misstep.
- `type_text` into a text element writes through UI Automation's ValuePattern. In one test that **appended the text to the end of an already-open Notepad document** rather than typing at the cursor — so "typing" is not always identical to keystrokes at the caret.
- It acts on whichever matching window it finds, including one you already have open with unsaved work. During testing a scripted "type into Notepad" landed in an existing unsaved Notepad tab. Don't run System Control tasks against windows holding work you can't afford to touch.

### Setup

1. Install Python 3.10+ if you don't have it: [python.org/downloads](https://www.python.org/downloads/).
2. In a terminal, from this project folder:
   ```bash
   cd agent
   pip install -r requirements.txt
   ```
3. Get a **free** Gemini API key: go to **[aistudio.google.com](https://aistudio.google.com)** → sign in with a Google account → **Get API key** → **Create API key**. No card is required for the free tier (worth double-checking current terms on Google's site, since that can change).
4. Copy `agent/.env.example` to `agent/.env` and paste in that key as `GEMINI_API_KEY`. To use Groq instead, set `GROQ_API_KEY` and `VESPER_REASONER=groq` (see the untested note below).
5. Start it:
   ```bash
   python vesper_agent.py
   ```
   It listens on `http://127.0.0.1:7891`.
6. With `index.html` open (via Live Server), click the **SYSTEM CONTROL: OFF** pill at the top of the page to switch it on. It'll turn amber and say **ON** once it confirms the agent is reachable.
7. Now try something like *"open Notepad and type a haiku about the ocean"* or *"what processes are running right now?"*

### Quick toggles (no AI in the loop)

With System Control on, these exact phrases skip the model and run deterministically:
*"mute"* / *"unmute"*, *"turn on/off do not disturb"* (or *"toggle dnd"*), and *"lock my computer/pc/screen"*. Endpoint: `POST /quick`.

- **Mute** uses Windows Core Audio (pycaw) and reads the state back. Muting twice never un-mutes. This is the **system** volume mute, not Vesper's own voice-mute button.
- **Do Not Disturb** has **no supported Windows API** (on Windows 11 the registry value that looks like it is actually the master "Notifications" switch). So Vesper drives the real Settings → Notifications switch through UI Automation. It takes roughly 5–7 seconds, briefly opens the Settings window, and matches the English label "Do not disturb" — a non-English Windows or a redesigned Settings page will break it (it reports failure rather than claiming success). Its read-back checks the Settings switch it just clicked; it doesn't independently confirm what the OS notification engine is doing.
- **Lock** calls `LockWorkStation()` (same as Win+L) with no confirmation, deliberately: it's harmless and you can undo it by unlocking.

### How the safety model works

- Opening apps, clicking/typing in apps, reading files, and listing processes happen immediately — no prompt, since you asked for full desktop control.
- Closing a program, running a shell command, writing a file, or deleting anything **pauses and shows an Approve/Deny bar** on the page before it happens.
- **Sending or submitting something on your behalf — via a plain click or keystroke — also pauses for approval.** A "Send" button in Outlook/WhatsApp/Slack/Teams, "Submit", "Post", "Publish", "Pay", "Place order" are ordinary clicks with no dedicated tool name to key off, so they're caught two independent ways:
  1. **The real label of the element being clicked.** The agent resolves each click's `element_index` to the actual element in the UI tree and matches its label against send/submit/post/publish/pay/purchase/checkout/place-order. This doesn't depend on the model saying anything honest.
  2. **The model's own `intent` text.** Every action must carry a plain-language description (*"Click Send to email john@example.com the message: running late"*). The same verbs are matched there too.

  Either one pausing shows the confirm bar. **Ctrl+Enter / Alt+Enter is always gated** (the Send shortcut in many mail/chat apps).
- **Known gap:** a bare **Enter** keypress with no element and a vague intent (e.g. sending a chat message by pressing Enter with intent *"confirm"*) is **not caught** by either check. This was confirmed in a unit test, not just reasoned about.
- The model can only name the screen tools listed in `EXPOSED_CUA_TOOLS` in `vesper_agent.py`. `kill_app`, `clipboard_read`/`clipboard_write`, `set_config`, and the browser `page` tool are never offered to it, and a made-up tool name is rejected.
- cua-driver has its own permission layer underneath (`VESPER_CUA_MODE`): `standard` (default) or `bounded` (deny-by-default, needs a reviewed manifest in `VESPER_CUA_MANIFEST`). `unrestricted` is deliberately not exposed. Anything cua-driver asks the host to authorize is denied and logged.
- Every action (approved or not) is written to `agent/agent_log.txt`.
- Each request is capped at 25 actions, so a confused task can't loop forever.

### What has and hasn't been verified

Verified by real runs on this machine (Windows 11):
- The full agent loop against the real cua-driver, using a scripted stand-in for the model: open → list windows → read UI tree → type → read back confirmed the text landed. Element-index-to-token resolution worked.
- The send gate's logic (unit tests, 9 cases pass; one documented gap above), and that a **denied** gated click never reaches the driver.
- Real Gemini accepts all tool schemas and completes a multi-turn read-only task correctly (list windows → answer, checked against the actual window list).
- Mute and Do Not Disturb toggles round-trip and restore correctly; `/quick` and `/health` respond correctly.

**Not verified — treat as unproven:**
- **The send gate against a real "Send" button in Outlook, WhatsApp Desktop, Slack or Teams.** The label check was exercised with a fabricated element labelled "Send", not a live mail client. Whether real apps expose their Send button with a label the regex matches is unconfirmed.
- **Groq as the reasoner.** No Groq key was available locally, so `GroqReasoner` has never made a real call. Its request/response handling follows Groq's OpenAI-compatible format but is untested.
- **`lock`** was not run (it would lock the session). **`bounded` mode** was not run.
- **Reliability on hard apps.** Only simple tasks were tried. Expect misses on complex, multi-window or fast-changing UIs.

### Important things to know

- **This is powerful.** The agent can read and act on anything on your screen, including things outside this project. Only run it when you intend to use it, and treat the API keys in `agent/.env` like passwords — it's gitignored, keep it that way.
- **Free-tier limits are tight and real.** Gemini's free tier has been observed returning `429` (a 20-requests/day cap on this model) and `503` ("high demand") on this account. Each step of a task is one request. The agent retries transient 503s and short rate limits a few times, but does **not** retry a per-day cap (it won't clear in a minute) and will say so plainly.
- **Model names and SDK shapes change.** Check [ai.google.dev/gemini-api/docs](https://ai.google.dev/gemini-api/docs) and [console.groq.com/docs/models](https://console.groq.com/docs/models) if it stops working after a while.
- Close the terminal running `vesper_agent.py` (or Ctrl+C) any time to shut the agent down completely — the web page keeps working for plain conversation either way. `pyautogui`'s corner-slam failsafe no longer applies, since the agent no longer uses `pyautogui`.
