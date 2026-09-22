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

  // Prefer higher-quality system voices (e.g. Edge/Windows "Online (Natural)"
  // voices, Chrome's neural Google voices) over the default legacy ones,
  // which is most of what made replies sound flatly robotic. The voice list
  // loads asynchronously in most browsers, hence the voiceschanged listener.
  let cachedVoices = [];
  function refreshVoices() {
    if ('speechSynthesis' in window) cachedVoices = speechSynthesis.getVoices();
  }
  if ('speechSynthesis' in window) {
    refreshVoices();
    speechSynthesis.onvoiceschanged = refreshVoices;
  }
  const VOICE_PREFERENCE = [/natural/i, /neural/i, /premium/i, /enhanced/i, /online/i, /google us english/i];
  function pickVoice() {
    if (!cachedVoices.length) refreshVoices();
    if (!cachedVoices.length) return null;
    const enVoices = cachedVoices.filter(v => /^en(-|_|$)/i.test(v.lang));
    const pool = enVoices.length ? enVoices : cachedVoices;
    for (const pattern of VOICE_PREFERENCE) {
      const match = pool.find(v => pattern.test(v.name));
      if (match) return match;
    }
    return pool[0] || null;
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
      u.rate = 1.1; u.pitch = 1.0; // natural pitch — algorithmic pitch-shifting was making default voices sound worse
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

  const CAPABILITIES_TEXT = "I can chat, answer questions, and read replies aloud. I can set reminders and timers, do quick math and unit conversions, and I remember our conversation across reloads — just say \"clear the conversation\" to reset it. Turn on hands-free mode and just talk to me, no clicking or wake word needed. And if you turn on System Control and start the local agent, I can open apps, run commands, and see and control your screen — asking first before anything risky.";

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

  async function handleQuery(rawText) {
    const text = (rawText || '').trim();
    if (!text) return;

    if (CLEAR_PHRASES.test(text)) {
      clearConversation();
      return;
    }

    appendMessage('user', text);

    if (agentOn && agentReachable) {
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
