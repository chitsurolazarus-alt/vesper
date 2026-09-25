(function () {
  "use strict";

  const clockEl = document.getElementById('clock');
  const appEl = document.querySelector('.app');
  const scene = document.getElementById('scene');
  const tilt = document.getElementById('tilt');
  const stateLabel = document.getElementById('stateLabel');
  const sysdot = document.getElementById('sysdot');
  const statusLabel = document.getElementById('statusLabel');
  const transcript = document.getElementById('transcript');
  const form = document.getElementById('inputForm');
  const textInput = document.getElementById('textInput');
  const micBtn = document.getElementById('micBtn');
  const muteBtn = document.getElementById('muteBtn');
  const micNote = document.getElementById('micNote');
  const agentToggle = document.getElementById('agentToggle');
  const handsFreeToggle = document.getElementById('handsFreeToggle');
  const clearBtn = document.getElementById('clearBtn');
  const contactsToggle = document.getElementById('contactsToggle');
  const contactsPanel = document.getElementById('contactsPanel');
  const contactsClose = document.getElementById('contactsClose');
  const contactsList = document.getElementById('contactsList');
  const contactsForm = document.getElementById('contactsForm');
  const contactNameInput = document.getElementById('contactName');
  const contactPhoneInput = document.getElementById('contactPhone');
  const contactEmailInput = document.getElementById('contactEmail');
  const confirmBar = document.getElementById('confirmBar');
  const confirmText = document.getElementById('confirmText');
  const confirmApprove = document.getElementById('confirmApprove');
  const confirmDeny = document.getElementById('confirmDeny');
  const reminderBanner = document.getElementById('reminderBanner');
  const reminderText = document.getElementById('reminderText');
  const reminderDismiss = document.getElementById('reminderDismiss');

  // ---------- clock ----------
  function tick() { clockEl.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false }); }
  tick(); setInterval(tick, 1000);

  // ---------- unlock speech synthesis for iOS Safari ----------
  // Safari (iOS in particular) requires speechSynthesis.speak() to be
  // triggered directly within a user gesture at least once, or it silently
  // does nothing (no error) — which is exactly what breaks it here, since
  // replies are always spoken from inside an async callback after the
  // network response, well after the tap/click that started it. Firing one
  // near-silent utterance on the very first tap/click anywhere "unlocks"
  // it for the rest of the session.
  let speechUnlocked = false;
  function unlockSpeechSynthesis() {
    if (speechUnlocked || !('speechSynthesis' in window)) return;
    speechUnlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch (e) { /* ignore — worst case, first reply on iOS stays text-only */ }
  }
  document.addEventListener('click', unlockSpeechSynthesis, { once: true, capture: true });
  document.addEventListener('touchend', unlockSpeechSynthesis, { once: true, capture: true });

  // ---------- gentle mouse/touch parallax tilt on the 3D core ----------
  scene.addEventListener('pointermove', (e) => {
    const r = scene.getBoundingClientRect();
    const dx = ((e.clientX - r.left) / r.width - 0.5) * 26;
    const dy = ((e.clientY - r.top) / r.height - 0.5) * 26;
    tilt.style.transform = `rotateX(${-dy}deg) rotateY(${dx}deg)`;
  });
  scene.addEventListener('pointerleave', () => { tilt.style.transform = 'rotateX(0deg) rotateY(0deg)'; });

  // ---------- mobile viewport: keep the layout correct as the phone's
  // on-screen keyboard opens/closes, and as browser chrome shows/hides.
  // CSS uses var(--app-height, 100dvh) for .app's height — this keeps that
  // in sync on browsers where dvh alone doesn't track the keyboard well. ----------
  function applyViewportHeight() {
    const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    document.documentElement.style.setProperty('--app-height', h + 'px');
  }
  applyViewportHeight();
  if (window.visualViewport) window.visualViewport.addEventListener('resize', applyViewportHeight);
  window.addEventListener('resize', applyViewportHeight);
  window.addEventListener('orientationchange', applyViewportHeight);

  // Folding away the decorative 3D core while the keyboard is up (narrow
  // screens only, via CSS) keeps the transcript + input bar reachable
  // instead of getting squeezed or pushed off-screen.
  textInput.addEventListener('focus', () => appEl.classList.add('kb-open'));
  textInput.addEventListener('blur', () => appEl.classList.remove('kb-open'));

  // ---------- PWA install support (lightweight app-shell cache only —
  // chat/agent calls all need live network and are left untouched) ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* fine without it */ });
    });
  }

  // ---------- state machine ----------
  const STATES = ['listening', 'thinking', 'speaking'];
  function setState(s) {
    STATES.forEach(x => scene.classList.remove(x));
    if (s !== 'idle') scene.classList.add(s);
    stateLabel.classList.remove('listening', 'thinking', 'speaking');
    if (s !== 'idle') stateLabel.classList.add(s);
    stateLabel.textContent = s.toUpperCase();
    sysdot.classList.toggle('thinking', s === 'thinking');
    statusLabel.textContent = s === 'idle' ? 'NOMINAL' : s.toUpperCase();
  }

  // ---------- transcript helpers ----------
  function ts() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
  function appendMessage(who, text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + who;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = (who === 'user' ? 'YOU · ' : 'VESPER · ') + ts();
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrap.appendChild(meta); wrap.appendChild(bubble);
    transcript.appendChild(wrap);
    transcript.scrollTop = transcript.scrollHeight;
    return bubble;
  }
  function updateMessage(bubble, text) { bubble.textContent = text; transcript.scrollTop = transcript.scrollHeight; }
  function markError(bubble) { bubble.closest('.msg').classList.add('error'); }

  // ---------- conversation memory: persist recent history across reloads ----------
  const HISTORY_KEY = 'vesper.history';
  const HISTORY_LIMIT = 40;

  function loadHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_LIMIT))); } catch (e) { /* storage full/blocked — fine, just not persisted */ }
  }
  function pushHistory(role, content) {
    history.push({ role, content });
    saveHistory();
  }

  let history = loadHistory(); // {role:'user'|'assistant', content}

  function clearConversation() {
    history = [];
    saveHistory();
    transcript.innerHTML = '';
    const greeting = "Conversation cleared. How can I help, Lazarus?";
    appendMessage('vesper', greeting);
    speak(greeting);
  }
  clearBtn.addEventListener('click', clearConversation);
  const CLEAR_PHRASES = /^(clear|reset)\s+(the\s+|our\s+)?(conversation|chat|history)\b/i;

  if (history.length) {
    history.forEach(m => appendMessage(m.role === 'user' ? 'user' : 'vesper', m.content));
  } else {
    appendMessage('vesper', "Vesper online. Systems nominal — how can I help, Lazarus?");
  }

  // ---------- voice output (speech synthesis) ----------
  let muted = false;
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    muteBtn.classList.toggle('muted', muted);
    if (muted && window.speechSynthesis) speechSynthesis.cancel();
  });

  // Pick a real, human-quality male voice when one's available, instead of
  // leaving it to whatever the browser's own default happens to be (which
  // varies by device and isn't reliably male). Falls back gracefully:
  // male+high-quality > any male > any high-quality > browser default.
  // Voice list loads asynchronously in most browsers, hence voiceschanged.
  let cachedVoices = [];
  function refreshVoices() {
    if ('speechSynthesis' in window) cachedVoices = speechSynthesis.getVoices();
  }
  if ('speechSynthesis' in window) {
    refreshVoices();
    speechSynthesis.onvoiceschanged = refreshVoices;
  }
  const QUALITY_PATTERNS = [/natural/i, /neural/i, /premium/i, /enhanced/i, /online/i];
  const MALE_PATTERNS = [/\bguy\b/i, /\bdavid\b/i, /\bmark\b/i, /\bryan\b/i, /\bdaniel\b/i, /\balex\b/i, /\bfred\b/i, /\btom\b/i, /\baaron\b/i, /\bnathan\b/i, /\boliver\b/i, /\bjames\b/i, /\bbrian\b/i, /\beric\b/i, /\bmale\b/i];
  function pickVoice() {
    if (!cachedVoices.length) refreshVoices();
    if (!cachedVoices.length) return null;
    const enVoices = cachedVoices.filter(v => /^en(-|_|$)/i.test(v.lang));
    const pool = enVoices.length ? enVoices : cachedVoices;
    const isMale = (v) => MALE_PATTERNS.some((p) => p.test(v.name));
    const isQuality = (v) => QUALITY_PATTERNS.some((p) => p.test(v.name));
    return pool.find((v) => isMale(v) && isQuality(v))
      || pool.find(isMale)
      || pool.find(isQuality)
      || pool[0] || null;
  }

  // speakChunk queues one utterance without cancelling what's already
  // queued — used to speak a reply sentence-by-sentence as it streams in
  // (see streamSpeakReset/streamSpeakDelta below). speak() is the
  // one-shot version used everywhere else (reminders, quick replies,
  // errors, the agent) — it clears the queue first, same as before.
  function speakChunk(text) {
    if (muted || !('speechSynthesis' in window) || !text || !text.trim()) return;
    rememberSpoken(text);
    try {
      const u = new SpeechSynthesisUtterance(text);
      const voice = pickVoice();
      if (voice) u.voice = voice;
      u.rate = 1.03; u.pitch = 1.0; // natural pitch — let a real human-recorded voice sound like itself instead of distorting it
      u.onstart = () => setState('speaking');
      u.onend = () => { if (!speechSynthesis.speaking) setState('idle'); };
      u.onerror = () => setState('idle');
      speechSynthesis.speak(u);
    } catch (e) { /* ignore — not fatal, text is already on screen */ }
  }

  function speak(text) {
    if (muted || !('speechSynthesis' in window) || !text) { setState('idle'); return; }
    speechSynthesis.cancel();
    speakChunk(text);
  }

  // ---------- streaming speech: start talking mid-reply instead of
  // waiting for the whole response, so it feels like a conversation
  // instead of a request/response bot ----------
  const SENTENCE_RE = /[^.!?]*[.!?]+(\s+|$)/g;
  function streamSpeakReset() {
    if (!muted && 'speechSynthesis' in window) speechSynthesis.cancel();
    return 0; // spokenIndex
  }
  function streamSpeakDelta(fullText, spokenIndex) {
    if (muted) return fullText.length; // nothing queued, so just track the pointer
    const slice = fullText.slice(spokenIndex);
    SENTENCE_RE.lastIndex = 0;
    let m, consumed = 0;
    while ((m = SENTENCE_RE.exec(slice)) !== null) {
      const atEnd = SENTENCE_RE.lastIndex === slice.length;
      if (atEnd && m[1] === '') break; // trailing punctuation with nothing after yet — could still be "3." growing into "3.14"
      const sentence = m[0].trim();
      if (sentence) speakChunk(sentence);
      consumed = SENTENCE_RE.lastIndex;
    }
    return spokenIndex + consumed;
  }
  function streamSpeakFlush(fullText, spokenIndex) {
    const remaining = fullText.slice(spokenIndex).trim();
    if (remaining) speakChunk(remaining);
    else if (muted || (!('speechSynthesis' in window)) || !speechSynthesis.speaking) setState('idle');
  }

  // ---------- voice input (speech recognition) ----------
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  // Quick Actions (tel:/sms:) only make sense where there's an actual phone
  // app to hand off to — a desktop browser has no dialer/SMS app, so those
  // two actions are gated on this rather than silently doing nothing.
  const IS_MOBILE = IS_IOS || /Android/i.test(navigator.userAgent);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null, micReady = false, listening = false, handsFree = false;

  function startRecognitionSafe() {
    if (!recognition || listening) return;
    try { recognition.start(); } catch (e) { /* already starting/started */ }
  }

  // Self-echo guard: in hands-free mode the mic keeps listening while
  // Vesper is talking (that's what makes barge-in possible), which on a
  // laptop without headphones means it can pick up her own voice out of
  // the speakers. Anything the recognizer hears that closely matches what
  // she just said gets treated as an echo, not a real command.
  let recentSpoken = [];
  function rememberSpoken(text) {
    recentSpoken.push(text.trim().toLowerCase());
    if (recentSpoken.length > 6) recentSpoken.shift();
  }
  function looksLikeEcho(said) {
    const s = said.trim().toLowerCase();
    if (s.length < 3) return false;
    return recentSpoken.some(chunk => chunk && (chunk.includes(s) || s.includes(chunk)));
  }

  if (SR) {
    try {
      recognition = new SR();
      recognition.lang = 'en-US';
      recognition.continuous = false;
      recognition.interimResults = false;
      micReady = true;
      // Chrome (and others) still segment "continuous" recognition into
      // short bursts under the hood and stop on any brief pause or even a
      // moment of silence right after starting — that's normal, not a
      // failure. In hands-free mode we restart immediately and skip the
      // idle flash entirely, so it reads as one unbroken "listening"
      // state instead of visibly stopping and starting every second.
      function scheduleHandsFreeRestart() {
        setTimeout(() => { if (handsFree) startRecognitionSafe(); }, 0);
      }
      // Temporary diagnostic logging for the voice pipeline — filter the
      // console on "[Vesper mic]" to see exactly what the recognizer is
      // (or isn't) producing. Safe to leave in; it's just console.log.
      const micLog = (...args) => console.log('[Vesper mic]', ...args);

      recognition.onstart = () => {
        micLog('onstart', { handsFree });
        // Barge-in for click-to-talk: clicking the mic IS the interrupt
        // signal. In hands-free mode this fires on routine re-listen
        // cycles too, so that mode relies on onresult below instead —
        // otherwise Vesper's replies would get cut off for no reason.
        if (!handsFree && window.speechSynthesis) speechSynthesis.cancel();
        listening = true; setState('listening'); micBtn.classList.add('active');
      };
      recognition.onend = () => {
        micLog('onend', { handsFree });
        listening = false; micBtn.classList.remove('active');
        if (handsFree) {
          scheduleHandsFreeRestart();
        } else if (scene.classList.contains('listening')) {
          setState('idle');
        }
      };
      recognition.onerror = (e) => {
        micLog('onerror', e.error);
        listening = false; micBtn.classList.remove('active');
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          setState('idle');
          micBtn.disabled = true;
          micNote.hidden = false;
          micNote.textContent = "Microphone access was blocked — check your browser's site permissions, or just type instead.";
          if (handsFree) setHandsFree(false);
          return;
        }
        if (handsFree && e.error !== 'aborted') {
          scheduleHandsFreeRestart(); // no-speech / network blips are routine in continuous mode
          return;
        }
        setState('idle');
      };
      recognition.onresult = (e) => {
        const res = e.results[e.results.length - 1];
        const said = (res[0].transcript || '').trim();
        micLog('onresult', { said, isFinal: res.isFinal, confidence: res[0].confidence });
        if (!said) return;

        const isEcho = handsFree && looksLikeEcho(said);
        if (isEcho) micLog('treated as echo, ignoring', said);

        // Barge-in: real (non-echo) speech interrupts Vesper mid-sentence.
        // Checked against the echo guard first, or Vesper's own voice
        // picked up by the mic would cancel her every time she started talking.
        if (!isEcho && window.speechSynthesis && speechSynthesis.speaking) {
          speechSynthesis.cancel();
        }

        if (res.isFinal === false) return;
        if (isEcho) return; // likely just heard herself, not a real command

        micLog('dispatching to handleQuery', said);
        handleQuery(said);
      };
    } catch (e) { micReady = false; }
  }
  if (!micReady) {
    micBtn.disabled = true;
    micNote.hidden = false;
    micNote.textContent = IS_IOS
      ? "Voice input isn't supported in this browser — try Chrome on Android, or just type."
      : "Voice input isn't supported in this browser — try Chrome or Edge, or just type.";
    handsFreeToggle.disabled = true;
    handsFreeToggle.title = "Hands-free needs voice input support, which isn't available in this browser.";
  }
  // The mic button itself now toggles continuous hands-free listening —
  // one click and it's a running conversation, not a click-per-utterance
  // control. setHandsFree is defined just below (hoisted, safe to call here).
  micBtn.addEventListener('click', () => { setHandsFree(!handsFree); });

  // ---------- hands-free continuous conversation (opt-in, off by default):
  // once on, no wake word and no clicking — anything you say is treated as
  // a command directly, like talking to a person. Turn it off (or the
  // System Control confirm bar) is still where you press something. ----------
  function setHandsFree(on) {
    if (on && !micReady) return;
    handsFree = on;
    handsFreeToggle.classList.toggle('on', on);
    handsFreeToggle.classList.toggle('cyan-on', on);
    handsFreeToggle.textContent = on ? 'HANDS-FREE: ON' : 'HANDS-FREE: OFF';
    // Persistent indicator, independent of the per-utterance .active class
    // (which onstart/onend toggle during actual speech capture) — without
    // this the mic button would flicker off between utterances instead of
    // staying visibly lit for the whole time hands-free is on.
    micBtn.classList.toggle('hands-free-on', on);
    micBtn.title = on ? 'Hands-free is on — just talk. Click to turn it off.' : 'Click to start talking, hands-free (no more clicking after this).';
    if (on) {
      // Chrome's continuous:true has a long-standing bug where it often
      // never actually promotes a result to final — it just keeps
      // restarting instead, so nothing ever reaches handleQuery. Single-
      // utterance sessions (continuous:false) reliably finalize, same as
      // the old click-to-talk mode always has; restarting one right after
      // another (via onend below) gets the same "always listening" effect
      // without relying on the broken continuous mode to do it natively.
      recognition.continuous = false;
      recognition.interimResults = true; // still want early interim results, for barge-in
      startRecognitionSafe();
    } else {
      recognition.continuous = false;
      recognition.interimResults = false;
      try { recognition.stop(); } catch (e) { /* not running */ }
    }
  }
  handsFreeToggle.addEventListener('click', () => {
    if (!micReady) {
      appendMessage('vesper', "Hands-free needs voice input support, which isn't available in this browser.");
      return;
    }
    setHandsFree(!handsFree);
  });

  // ---------- Chat reasoning (via your Supabase Edge Function, powered by Groq) ----------
  //
  // The frontend never sees your Groq API key. It calls the "vesper-chat"
  // Edge Function in your Supabase project, which holds the key server-side
  // and forwards the request to Groq. See README.md to set it up.
  // (System Control / desktop actions are a separate path — see runAgentCommand
  // above — and still go through Gemini directly via the local agent.)

  const PERSONA = "You are VESPER, a calm, sharp, faintly witty AI assistant with a sci-fi HUD-computer personality (think: a ship's AI, not a chatty chatbot). You are helping Lazarus, a software developer who runs a small digital agency in Cape Town, South Africa. Keep replies conversational and brief — 1 to 4 sentences unless the question genuinely needs more. Never use markdown, asterisks, or headers, since replies may be read aloud.";

  // Low-level: POST to the Edge Function with an arbitrary system prompt +
  // message list, consume the SSE stream, and return the full text. Shared
  // by the main chat path (streamClaude) and the reminder-intent classifier.
  async function groqComplete(system, messages, onDelta) {
    const resp = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/vesper-chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ system, messages })
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => null);
      const detail = errBody?.error || await resp.text().catch(() => '');
      throw new Error(`Edge Function error ${resp.status}: ${detail}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const evt = JSON.parse(data);
          // Groq/OpenAI-style stream shape: choices[0].delta.content
          const delta = evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content;
          if (delta) {
            fullText += delta;
            if (onDelta) onDelta(fullText);
          }
        } catch (e) { /* ignore partial/non-JSON lines */ }
      }
    }
    return fullText;
  }

  async function streamClaude(userText, onDelta) {
    const messages = history.slice(-10).map(t => ({ role: t.role, content: t.content }));
    messages.push({ role: 'user', content: userText });
    return groqComplete(PERSONA, messages, onDelta);
  }

  // ---------- Vesper Agent (local system control) ----------
  const AGENT_URL = 'http://127.0.0.1:7891';
  let agentOn = false;
  let agentReachable = false;

  async function checkAgent() {
    try {
      const resp = await fetch(`${AGENT_URL}/health`, { method: 'GET' });
      agentReachable = resp.ok;
    } catch (e) {
      agentReachable = false;
    }
    renderAgentToggle();
  }
  function renderAgentToggle() {
    agentToggle.classList.toggle('on', agentOn);
    agentToggle.classList.toggle('offline', !agentReachable);
    if (!agentReachable) {
      agentToggle.textContent = 'SYSTEM CONTROL: AGENT OFFLINE';
    } else {
      agentToggle.textContent = agentOn ? 'SYSTEM CONTROL: ON' : 'SYSTEM CONTROL: OFF';
    }
  }
  agentToggle.addEventListener('click', async () => {
    await checkAgent();
    if (!agentReachable) {
      appendMessage('vesper', "I can't reach the local Vesper Agent on port 7891 — start it with \"python vesper_agent.py\" in the agent folder, then try again.");
      return;
    }
    agentOn = !agentOn;
    renderAgentToggle();
    appendMessage('vesper', agentOn
      ? "System Control is on — I can open apps, run commands, and see/use your screen now. I'll ask before anything risky."
      : "System Control is off — back to plain conversation.");
  });
  checkAgent();

  function showConfirm(description, onDecision) {
    confirmText.textContent = description;
    confirmBar.hidden = false;
    const cleanup = () => { confirmBar.hidden = true; confirmApprove.onclick = null; confirmDeny.onclick = null; };
    confirmApprove.onclick = () => { cleanup(); onDecision(true); };
    confirmDeny.onclick = () => { cleanup(); onDecision(false); };
  }

  // Direct toggles (mute / Do Not Disturb / lock) skip the AI loop entirely —
  // the agent does them deterministically and verifies the result. Patterns are
  // deliberately narrow so ordinary requests still go to the normal path.
  const QUICK_TOGGLES = [
    { re: /^\s*(please\s+)?unmute(\s+(the\s+)?(computer|pc|sound|volume|audio|speakers?))?\s*[.!]?\s*$/i, action: 'unmute' },
    { re: /^\s*(please\s+)?mute(\s+(the\s+)?(computer|pc|sound|volume|audio|speakers?))?\s*[.!]?\s*$/i, action: 'mute' },
    { re: /^\s*(please\s+)?(turn on|enable|start)\s+(do not disturb|dnd)\s*[.!]?\s*$/i, action: 'dnd_on' },
    { re: /^\s*(please\s+)?(turn off|disable|stop)\s+(do not disturb|dnd)\s*[.!]?\s*$/i, action: 'dnd_off' },
    { re: /^\s*(please\s+)?toggle\s+(do not disturb|dnd)\s*[.!]?\s*$/i, action: 'toggle_dnd' },
    { re: /^\s*(please\s+)?lock\s+(my|the)\s+(computer|pc|screen|laptop)\s*[.!]?\s*$/i, action: 'lock' },
  ];

  async function runQuickToggle(action, text) {
    setState('thinking');
    const slow = action.includes('dnd');
    const bubble = appendMessage('vesper', slow ? 'On it — Do Not Disturb takes a few seconds (I have to flip it in Settings)…' : 'On it…');
    let msg;
    try {
      const resp = await fetch(`${AGENT_URL}/quick`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const data = await resp.json();
      msg = data.message || (data.ok ? 'Done.' : "That didn't work.");
      if (!data.ok) markError(bubble);
    } catch (e) {
      msg = "Couldn't reach the local Vesper Agent — make sure vesper_agent.py is running.";
      markError(bubble);
    }
    updateMessage(bubble, msg);
    pushHistory('user', text);
    pushHistory('assistant', msg);
    setState('idle');
    speak(msg);
  }

  async function runAgentCommand(text) {
    setState('thinking');
    const bubble = appendMessage('vesper', 'Working on it…');
    let taskId;
    try {
      const resp = await fetch(`${AGENT_URL}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!resp.ok) throw new Error(`Agent error ${resp.status}`);
      ({ task_id: taskId } = await resp.json());
    } catch (e) {
      updateMessage(bubble, "Couldn't reach the local Vesper Agent — make sure vesper_agent.py is running.");
      markError(bubble);
      setState('idle');
      return;
    }

    let seenLogLines = 0;
    while (true) {
      await new Promise(r => setTimeout(r, 900));
      let data;
      try {
        const s = await fetch(`${AGENT_URL}/status/${taskId}`);
        data = await s.json();
      } catch (e) { continue; }

      if (data.log && data.log.length > seenLogLines) {
        const latest = data.log[data.log.length - 1];
        if (latest.role === 'vesper') updateMessage(bubble, latest.text);
        seenLogLines = data.log.length;
      }

      if (data.status === 'waiting_confirmation' && data.pending) {
        setState('idle');
        showConfirm(data.pending.description, async (approved) => {
          setState('thinking');
          await fetch(`${AGENT_URL}/confirm/${taskId}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ approved })
          });
        });
        continue;
      }

      if (data.status === 'done' || data.status === 'error') {
        const finalText = data.result || "Done.";
        updateMessage(bubble, finalText);
        if (data.status === 'error') markError(bubble);
        pushHistory('user', text);
        pushHistory('assistant', finalText);
        speak(finalText);
        return;
      }
    }
  }

  // ---------- reminders: parsed by Groq (no fragile regex date parsing),
  // fired client-side — only while this tab stays open ----------
  const REMINDERS_KEY = 'vesper.reminders';
  const REMINDER_TRIGGER = /\bremind(er|ers|ed|ing)?\b/i;
  let reminders = [];

  function loadReminders() {
    try {
      const parsed = JSON.parse(localStorage.getItem(REMINDERS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }
  function saveReminders() {
    try { localStorage.setItem(REMINDERS_KEY, JSON.stringify(reminders)); } catch (e) { /* fine */ }
  }

  function showReminderBanner(text) {
    reminderText.textContent = text;
    reminderBanner.hidden = false;
  }
  reminderDismiss.addEventListener('click', () => { reminderBanner.hidden = true; });

  function fireAlert(text) {
    appendMessage('vesper', text);
    showReminderBanner(text);
    speak(text);
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Vesper', { body: text, icon: 'icons/icon-192.png' }); } catch (e) { /* fine */ }
    }
  }

  function completeReminder(id) {
    reminders = reminders.filter(x => x.id !== id);
    saveReminders();
  }

  function scheduleReminder(r) {
    const delay = r.fireAt - Date.now();
    if (delay <= 0) {
      fireAlert(`Reminder: ${r.message}`);
      completeReminder(r.id);
      return;
    }
    setTimeout(() => {
      fireAlert(`Reminder: ${r.message}`);
      completeReminder(r.id);
    }, delay);
  }

  function addReminder(message, delaySeconds) {
    const r = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      message,
      fireAt: Date.now() + delaySeconds * 1000,
    };
    reminders.push(r);
    saveReminders();
    scheduleReminder(r);
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => { /* fine, banner+speech still fire */ });
    }
    return r;
  }

  reminders = loadReminders();
  reminders.forEach(scheduleReminder); // reschedules pending ones; fires any that were already due

  async function tryParseReminder(text) {
    if (!REMINDER_TRIGGER.test(text)) return null;
    const sys = `You extract reminder requests from a single user message for a voice assistant.
Respond with ONLY compact JSON, no prose, no markdown code fences, matching this schema exactly:
{"is_reminder": boolean, "delay_seconds": number|null, "message": string|null}
- Set is_reminder true only if the message is genuinely asking to be reminded of something later (e.g. "remind me to call the client in 20 minutes", "remind me at 3pm to send the invoice").
- delay_seconds is the whole number of seconds from now until the reminder should fire. For a relative delay ("in 20 minutes") compute it directly. For a clock time ("at 3pm") assume today's date unless that time has already passed today, in which case use tomorrow.
- message is a short imperative description of what to be reminded of (e.g. "call the client"), never including the word "remind" itself.
- If this is not actually a reminder request, respond exactly {"is_reminder": false, "delay_seconds": null, "message": null}.
The current local date/time is: ${new Date().toString()}`;
    try {
      const full = await groqComplete(sys, [{ role: 'user', content: text }], null);
      const cleaned = full.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && parsed.is_reminder && typeof parsed.delay_seconds === 'number' && parsed.delay_seconds > 0 && parsed.message) {
        return parsed;
      }
    } catch (e) { /* not parseable as a reminder — caller falls back to normal chat */ }
    return null;
  }

  // ---------- quick built-in commands: instant, no network call ----------
  function startTimer(totalSeconds, label) {
    setTimeout(() => {
      fireAlert(label ? `Timer done — ${label}.` : "Timer's up.");
    }, totalSeconds * 1000);
  }

  const TIMER_RE = /\b(?:set (?:a )?)?(?:timer|countdown)(?: for)?\s+(\d+(?:\.\d+)?)\s*(hour|hr|minute|min|second|sec)s?\b/i;

  const UNIT_TABLE = {
    km_mi: v => v * 0.621371, mi_km: v => v / 0.621371,
    kg_lb: v => v * 2.20462, lb_kg: v => v / 2.20462,
    m_ft: v => v * 3.28084, ft_m: v => v / 3.28084,
    c_f: v => v * 9 / 5 + 32, f_c: v => (v - 32) * 5 / 9,
  };
  const UNIT_ALIASES = {
    km: 'km', kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km',
    mi: 'mi', mile: 'mi', miles: 'mi',
    kg: 'kg', kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg',
    lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
    m: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm',
    ft: 'ft', foot: 'ft', feet: 'ft',
    c: 'c', celsius: 'c',
    f: 'f', fahrenheit: 'f',
  };
  const UNIT_LABEL = { km: 'km', mi: 'mi', kg: 'kg', lb: 'lb', m: 'm', ft: 'ft', c: '°C', f: '°F' };
  const CONVERT_RE = /(?:convert\s+)?(-?\d+(?:\.\d+)?)\s*([a-z°]+)\s+(?:to|in)\s+([a-z°]+)\b/i;

  function tryUnitConversion(q) {
    const m = q.match(CONVERT_RE);
    if (!m) return null;
    const value = parseFloat(m[1]);
    const from = UNIT_ALIASES[m[2].toLowerCase()];
    const to = UNIT_ALIASES[m[3].toLowerCase()];
    if (!from || !to || from === to) return null;
    const fn = UNIT_TABLE[`${from}_${to}`];
    if (!fn) return null;
    const result = Math.round(fn(value) * 100) / 100;
    return `${value} ${UNIT_LABEL[from]} is about ${result} ${UNIT_LABEL[to]}.`;
  }

  const CALC_RE = /^(?:what(?:'s| is)\s+)?(-?[\d.]+(?:\s*(?:plus|minus|times|divided by|\+|-|\*|\/)\s*-?[\d.]+)+)\s*\??$/i;

  function tryCalculator(q) {
    const m = q.trim().match(CALC_RE);
    if (!m) return null;
    const expr = m[1]
      .replace(/\btimes\b/gi, '*')
      .replace(/\bdivided by\b/gi, '/')
      .replace(/\bplus\b/gi, '+')
      .replace(/\bminus\b/gi, '-');
    if (!/^[-0-9+*/.\s]+$/.test(expr)) return null; // safety allowlist before evaluating
    try {
      const result = Function(`"use strict"; return (${expr});`)();
      if (typeof result !== 'number' || !isFinite(result)) return null;
      return `That's ${Math.round(result * 1000) / 1000}.`;
    } catch (e) { return null; }
  }

  const CAPABILITIES_TEXT = "I can chat, answer questions, and read replies aloud. I can set reminders and timers, do quick math and unit conversions, and I remember our conversation across reloads — just say \"clear the conversation\" to reset it. I can also trigger real quick actions on this device — call or text a saved contact, email someone, open directions, open WhatsApp, Gmail, Maps or YouTube, or run a web search — say things like \"call Mary\" or \"navigate to the office\". Turn on hands-free mode and just talk to me, no clicking or wake word needed. And if you turn on System Control and start the local agent, I can open apps, run commands, and see and control your screen — asking first before anything risky.";

  function localQuickReply(text) {
    const q = text.trim().toLowerCase();

    if (/^(what('| i)?s the time|what time is it)\b/.test(q)) {
      return "It's " + new Date().toLocaleTimeString('en-GB', { hour12: false }) + ", South Africa Standard Time.";
    }
    if (/^(what('| i)?s the date|what day is it)\b/.test(q)) {
      return "Today is " + new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + ".";
    }
    if (/what can you do|what are you capable of|^help\b/.test(q)) {
      return CAPABILITIES_TEXT;
    }

    const timerMatch = q.match(TIMER_RE);
    if (timerMatch) {
      const amount = parseFloat(timerMatch[1]);
      const unit = timerMatch[2];
      const seconds = unit.startsWith('hour') || unit === 'hr' ? amount * 3600
        : unit.startsWith('min') ? amount * 60
        : amount;
      const niceUnit = unit.startsWith('hour') || unit === 'hr' ? 'hour' : unit.startsWith('min') ? 'minute' : 'second';
      startTimer(seconds, null);
      return `Timer set for ${amount} ${niceUnit}${amount === 1 ? '' : 's'}.`;
    }

    const conv = tryUnitConversion(q);
    if (conv) return conv;

    const calc = tryCalculator(q);
    if (calc) return calc;

    return null;
  }

  // ---------- quick actions: trigger a real action on this device (call,
  // text, email, directions, WhatsApp/Gmail/Maps/YouTube, web search) via
  // standard web deep links (tel:, sms:, mailto:, maps/wa.me URLs). These
  // work identically on iPhone and Android because they're plain URL
  // schemes any web page is allowed to trigger — no native app or special
  // permission needed.
  //
  // The real ceiling: this launches ONE specific app/action per request.
  // It is NOT open-ended control of the phone's screen the way System
  // Control drives the desktop — that would need a real native app
  // (Android Accessibility Service; not possible on iOS at all due to
  // Apple's sandboxing) and is out of scope here.
  //
  // Parsing follows the same shape as tryParseReminder() above: a cheap
  // regex pre-check, then one Groq call for structured JSON, so plain
  // conversation that happens to contain "call" or "search" doesn't pay
  // for a wasted round-trip through the wrong path.
  const CONTACTS_KEY = 'vesper.contacts';

  function loadContacts() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONTACTS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }
  function saveContacts() {
    try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts)); } catch (e) { /* fine */ }
  }
  let contacts = loadContacts();

  function findContact(name) {
    const n = (name || '').trim().toLowerCase();
    if (!n) return null;
    return contacts.find(c => c.name.toLowerCase() === n) || null;
  }
  function upsertContact(name, field, value) {
    const n = name.trim();
    let c = findContact(n);
    if (!c) { c = { name: n }; contacts.push(c); }
    c[field] = value;
    saveContacts();
    renderContactsList();
    return c;
  }

  function renderContactsList() {
    contactsList.innerHTML = '';
    if (!contacts.length) {
      const empty = document.createElement('div');
      empty.className = 'contacts-empty';
      empty.textContent = 'No contacts saved yet.';
      contactsList.appendChild(empty);
      return;
    }
    contacts.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((c) => {
      const row = document.createElement('div');
      row.className = 'contact-row';
      const info = document.createElement('span');
      info.textContent = c.name + (c.phone ? ' · ' + c.phone : '') + (c.email ? ' · ' + c.email : '');
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'contact-del';
      del.textContent = 'Remove';
      del.addEventListener('click', () => {
        contacts = contacts.filter((x) => x !== c);
        saveContacts();
        renderContactsList();
      });
      row.appendChild(info);
      row.appendChild(del);
      contactsList.appendChild(row);
    });
  }

  contactsToggle.addEventListener('click', () => {
    renderContactsList();
    contactsPanel.hidden = false;
  });
  contactsClose.addEventListener('click', () => { contactsPanel.hidden = true; });
  contactsPanel.addEventListener('click', (e) => { if (e.target === contactsPanel) contactsPanel.hidden = true; });
  contactsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = contactNameInput.value.trim();
    const phone = contactPhoneInput.value.trim();
    const email = contactEmailInput.value.trim();
    if (!name || (!phone && !email)) return;
    if (phone) upsertContact(name, 'phone', sanitizePhone(phone));
    if (email) upsertContact(name, 'email', email);
    contactsForm.reset();
  });

  function sanitizePhone(raw) { return (raw || '').replace(/[^\d+]/g, ''); }
  function contactLabel(p) { return p.contact_name || p.number || p.email || 'them'; }

  // sameTab actions (tel:/sms:/mailto:) navigate the current page to a
  // custom URL scheme, which browsers hand off to the relevant app without
  // actually leaving Vesper. New-tab actions (maps/search/WhatsApp/Gmail
  // web/YouTube) use window.open, which is more visible but can get
  // caught by a pop-up blocker since it fires after an async Groq call
  // rather than inside the original click/submit gesture — triggerDeepLink
  // reports whether that happened so the caller can say so.
  function triggerDeepLink(url, sameTab) {
    if (sameTab) { window.location.href = url; return true; }
    const win = window.open(url, '_blank', 'noopener');
    return !!win;
  }

  function buildCallAction(p) {
    if (!IS_MOBILE) return { ok: false, message: "Calling needs a phone — this is a desktop browser, so there's no dialer to hand it to." };
    const num = sanitizePhone(p.number);
    if (!num) return { ok: false, message: "I didn't catch a number to call." };
    return { ok: true, url: `tel:${num}`, sameTab: true, confirm: `Calling ${contactLabel(p)}.` };
  }
  function buildTextAction(p) {
    if (!IS_MOBILE) return { ok: false, message: "Texting needs a phone — this is a desktop browser, so there's no messaging app to hand it to." };
    const num = sanitizePhone(p.number);
    if (!num) return { ok: false, message: "I didn't catch a number to text." };
    const body = p.message ? `?body=${encodeURIComponent(p.message)}` : '';
    return { ok: true, url: `sms:${num}${body}`, sameTab: true, confirm: `Texting ${contactLabel(p)}${p.message ? `: "${p.message}"` : ''}.` };
  }
  function buildEmailAction(p) {
    const addr = (p.email || '').trim();
    if (!addr) return { ok: false, message: "I didn't catch an email address." };
    const params = new URLSearchParams();
    if (p.subject) params.set('subject', p.subject);
    if (p.message) params.set('body', p.message);
    const qs = params.toString();
    return { ok: true, url: `mailto:${encodeURIComponent(addr)}${qs ? '?' + qs : ''}`, sameTab: true, confirm: `Opening an email to ${contactLabel(p)}.` };
  }
  function buildNavigateAction(p) {
    if (!p.destination) return { ok: false, message: "I didn't catch a destination." };
    return { ok: true, url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.destination)}`, sameTab: false, confirm: `Opening directions to ${p.destination}.` };
  }
  function buildWhatsappAction(p) {
    const num = p.number ? sanitizePhone(p.number) : '';
    const text = p.message ? `?text=${encodeURIComponent(p.message)}` : '';
    return { ok: true, url: `https://wa.me/${num}${text}`, sameTab: false, confirm: num ? `Opening WhatsApp to ${contactLabel(p)}.` : 'Opening WhatsApp.' };
  }
  function buildSearchAction(p) {
    if (!p.query) return { ok: false, message: "I didn't catch what to search for." };
    return { ok: true, url: `https://www.google.com/search?q=${encodeURIComponent(p.query)}`, sameTab: false, confirm: `Searching for ${p.query}.` };
  }
  const APP_LABELS = { gmail: 'Gmail', maps: 'Google Maps', youtube: 'YouTube' };
  function buildOpenAppAction(p) {
    if (p.app === 'gmail') {
      const params = new URLSearchParams({ view: 'cm', fs: '1' });
      if (p.email) params.set('to', p.email);
      if (p.subject) params.set('su', p.subject);
      return { ok: true, url: `https://mail.google.com/mail/?${params.toString()}`, sameTab: false, confirm: 'Opening Gmail.' };
    }
    if (p.app === 'maps') {
      const url = p.query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.query)}` : 'https://www.google.com/maps';
      return { ok: true, url, sameTab: false, confirm: p.query ? `Opening Maps for ${p.query}.` : 'Opening Maps.' };
    }
    if (p.app === 'youtube') {
      const url = p.query ? `https://www.youtube.com/results?search_query=${encodeURIComponent(p.query)}` : 'https://www.youtube.com';
      return { ok: true, url, sameTab: false, confirm: p.query ? `Opening YouTube, searching for ${p.query}.` : 'Opening YouTube.' };
    }
    return { ok: false, message: `I don't have a link set up for ${APP_LABELS[p.app] || 'that app'} yet.` };
  }

  const QUICK_ACTION_BUILDERS = {
    call: buildCallAction,
    text: buildTextAction,
    email: buildEmailAction,
    navigate: buildNavigateAction,
    whatsapp: buildWhatsappAction,
    search: buildSearchAction,
    open_app: buildOpenAppAction,
  };

  // If a call/text/whatsapp/email names a contact but has no number/email
  // directly, try the local contacts list; if that also comes up empty,
  // return what's missing so the caller can ask for it once.
  function resolveActionContact(parsed) {
    if ((parsed.type === 'call' || parsed.type === 'text' || parsed.type === 'whatsapp') && !parsed.number && parsed.contact_name) {
      const c = findContact(parsed.contact_name);
      if (c && c.phone) { parsed.number = c.phone; return null; }
      if (parsed.type === 'whatsapp') return null; // WhatsApp can open blank, no number required
      return { name: parsed.contact_name, field: 'phone' };
    }
    if (parsed.type === 'email' && !parsed.email && parsed.contact_name) {
      const c = findContact(parsed.contact_name);
      if (c && c.email) { parsed.email = c.email; return null; }
      return { name: parsed.contact_name, field: 'email' };
    }
    return null;
  }

  function executeQuickAction(parsed) {
    const builder = QUICK_ACTION_BUILDERS[parsed.type];
    if (!builder) return null;
    const missing = resolveActionContact(parsed);
    if (missing) return { pendingContact: { ...missing, action: parsed } };
    return builder(parsed);
  }

  const QUICK_ACTION_TRIGGER = /\b(call|dial|phone|text|sms|message|email|mail|navigate to|directions? to|drive to|take me to|whatsapp|open (gmail|maps|youtube)|search for|look up|google)\b/i;

  async function tryParseQuickAction(text) {
    if (!QUICK_ACTION_TRIGGER.test(text)) return null;
    const sys = `You extract "quick action" requests from a single user message for a voice assistant that can trigger real device actions via web deep links: placing a phone call, sending a text, sending an email, opening turn-by-turn directions, opening WhatsApp, opening Gmail/Google Maps/YouTube, or running a web search.
Respond with ONLY compact JSON, no prose, no markdown code fences, matching this schema exactly:
{"is_action": boolean, "type": "call"|"text"|"email"|"navigate"|"whatsapp"|"open_app"|"search"|null, "contact_name": string|null, "number": string|null, "email": string|null, "message": string|null, "subject": string|null, "destination": string|null, "app": "gmail"|"maps"|"youtube"|null, "query": string|null}
- "call"/"text": set contact_name to a spoken name (e.g. "Mary", "the office") if a name was used, or number if a number was spoken/typed directly. "text" should also fill message with what to send, if given.
- "email": fill contact_name or email, plus subject and/or message (used as the body) if given.
- "navigate": fill destination with just the place/address, stripped of filler words like "directions to" or "take me to".
- "whatsapp": only when WhatsApp is explicitly mentioned. Fill contact_name or number if given, plus message if given.
- "open_app": only for "open Gmail" / "open Maps" / "open YouTube" style requests not already covered by call/text/email/navigate/whatsapp above. Set app accordingly, and query if a search inside that app was also specified (e.g. "open youtube and search for lo-fi beats" -> app "youtube", query "lo-fi beats").
- "search": fill query with just the search terms, stripped of filler words like "search for" or "look up".
- Set is_action false for anything else, including plain conversation, reminders, or a message that merely mentions one of these words without asking for the action. If false, every other field must be null.
- Never invent a name, number, address, or query that wasn't in the message.`;
    try {
      const full = await groqComplete(sys, [{ role: 'user', content: text }], null);
      const cleaned = full.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && parsed.is_action && parsed.type) return parsed;
    } catch (e) { /* not parseable as a quick action — caller falls back to normal chat */ }
    return null;
  }

  // Set when a quick action is missing a contact's number/email — the very
  // next message is treated as the answer instead of going through normal
  // routing, then the action fires and the contact is remembered.
  let pendingContactRequest = null;

  async function handleQuery(rawText) {
    const text = (rawText || '').trim();
    if (!text) return;

    if (CLEAR_PHRASES.test(text)) {
      clearConversation();
      return;
    }

    appendMessage('user', text);

    if (pendingContactRequest) {
      const pending = pendingContactRequest;
      pendingContactRequest = null;
      pushHistory('user', text);
      if (/^(never ?mind|cancel|skip|no thanks?)\b/i.test(text)) {
        const msg = 'No problem, cancelled.';
        appendMessage('vesper', msg);
        pushHistory('assistant', msg);
        speak(msg);
        return;
      }
      const value = pending.field === 'email' ? text.trim() : sanitizePhone(text);
      if (!value) {
        const msg = "I still didn't catch that — let's skip it for now.";
        appendMessage('vesper', msg);
        pushHistory('assistant', msg);
        speak(msg);
        return;
      }
      upsertContact(pending.name, pending.field, value);
      pending.action[pending.field === 'email' ? 'email' : 'number'] = value;
      const result = QUICK_ACTION_BUILDERS[pending.action.type](pending.action);
      let msg;
      if (result.ok) {
        const opened = triggerDeepLink(result.url, result.sameTab);
        msg = `Got it, I'll remember ${pending.name}. ${result.confirm}`;
        if (!result.sameTab && !opened) msg += " (Your browser's pop-up blocker may have stopped that — allow pop-ups for this site and try again.)";
      } else {
        msg = `Saved ${pending.name}, but ${result.message}`;
      }
      appendMessage('vesper', msg);
      pushHistory('assistant', msg);
      speak(msg);
      return;
    }

    if (agentOn && agentReachable) {
      const toggle = QUICK_TOGGLES.find(t => t.re.test(text));
      if (toggle) return runQuickToggle(toggle.action, text);
      return runAgentCommand(text);
    }

    const quick = localQuickReply(text);
    if (quick) {
      pushHistory('user', text);
      appendMessage('vesper', quick);
      pushHistory('assistant', quick);
      speak(quick);
      return;
    }

    pushHistory('user', text);
    setState('thinking');
    const bubble = appendMessage('vesper', 'Thinking…');

    try {
      if (REMINDER_TRIGGER.test(text)) {
        const parsedReminder = await tryParseReminder(text);
        if (parsedReminder) {
          addReminder(parsedReminder.message, parsedReminder.delay_seconds);
          const mins = Math.round(parsedReminder.delay_seconds / 60);
          const when = mins >= 1 ? `in about ${mins} minute${mins === 1 ? '' : 's'}` : 'shortly';
          const confirmMsg = `Got it — I'll remind you to ${parsedReminder.message} ${when}. Keep this tab open, since a reminder only fires while Vesper is running in the browser.`;
          updateMessage(bubble, confirmMsg);
          pushHistory('assistant', confirmMsg);
          speak(confirmMsg);
          setState('idle');
          return;
        }
      }

      if (QUICK_ACTION_TRIGGER.test(text)) {
        const parsedAction = await tryParseQuickAction(text);
        if (parsedAction) {
          const result = executeQuickAction(parsedAction);
          if (result && result.pendingContact) {
            pendingContactRequest = result.pendingContact;
            const askMsg = `I don't have ${result.pendingContact.field === 'email' ? 'an email' : 'a number'} saved for ${result.pendingContact.name} — what is it?`;
            updateMessage(bubble, askMsg);
            pushHistory('assistant', askMsg);
            speak(askMsg);
            setState('idle');
            return;
          }
          if (result) {
            let msg;
            if (result.ok) {
              const opened = triggerDeepLink(result.url, result.sameTab);
              msg = result.confirm;
              if (!result.sameTab && !opened) msg += " (Your browser's pop-up blocker may have stopped that — allow pop-ups for this site and try again.)";
            } else {
              msg = result.message;
            }
            updateMessage(bubble, msg);
            pushHistory('assistant', msg);
            speak(msg);
            setState('idle');
            return;
          }
        }
      }

      let spokenIndex = streamSpeakReset();
      const finalText = await streamClaude(text, (partial) => {
        updateMessage(bubble, partial);
        spokenIndex = streamSpeakDelta(partial, spokenIndex);
      });
      const cleanText = finalText || "I didn't catch a usable answer for that.";
      updateMessage(bubble, cleanText);
      pushHistory('assistant', cleanText);
      streamSpeakFlush(cleanText, spokenIndex);
    } catch (err) {
      console.error(err);
      const hint = /GROQ_API_KEY secret is not set/i.test(String(err))
        ? "My Edge Function is live, but its GROQ_API_KEY secret hasn't been set yet — see README.md."
        : "Something interrupted my reasoning core — check the browser console for details.";
      updateMessage(bubble, hint);
      markError(bubble);
      setState('idle');
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = textInput.value;
    textInput.value = '';
    handleQuery(text);
  });
})();
