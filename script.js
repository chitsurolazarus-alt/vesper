(function () {
  "use strict";

  const clockEl = document.getElementById('clock');
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
  const confirmBar = document.getElementById('confirmBar');
  const confirmText = document.getElementById('confirmText');
  const confirmApprove = document.getElementById('confirmApprove');
  const confirmDeny = document.getElementById('confirmDeny');

  // ---------- clock ----------
  function tick() { clockEl.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false }); }
  tick(); setInterval(tick, 1000);

  // ---------- gentle mouse/touch parallax tilt on the 3D core ----------
  scene.addEventListener('pointermove', (e) => {
    const r = scene.getBoundingClientRect();
    const dx = ((e.clientX - r.left) / r.width - 0.5) * 26;
    const dy = ((e.clientY - r.top) / r.height - 0.5) * 26;
    tilt.style.transform = `rotateX(${-dy}deg) rotateY(${dx}deg)`;
  });
  scene.addEventListener('pointerleave', () => { tilt.style.transform = 'rotateX(0deg) rotateY(0deg)'; });

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

  appendMessage('vesper', "Vesper online. Systems nominal — how can I help, Lazarus?");

  // ---------- voice output (speech synthesis) ----------
  let muted = false;
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    muteBtn.classList.toggle('muted', muted);
    if (muted && window.speechSynthesis) speechSynthesis.cancel();
  });

  function speak(text) {
    if (muted || !('speechSynthesis' in window) || !text) { setState('idle'); return; }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.03; u.pitch = 0.85;
      u.onstart = () => setState('speaking');
      u.onend = () => setState('idle');
      u.onerror = () => setState('idle');
      speechSynthesis.speak(u);
    } catch (e) { setState('idle'); }
  }

  // ---------- voice input (speech recognition) ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null, micReady = false, listening = false;

  if (SR) {
    try {
      recognition = new SR();
      recognition.lang = 'en-US';
      recognition.continuous = false;
      recognition.interimResults = false;
      micReady = true;
      recognition.onstart = () => { listening = true; setState('listening'); micBtn.classList.add('active'); };
      recognition.onend = () => { listening = false; micBtn.classList.remove('active'); if (scene.classList.contains('listening')) setState('idle'); };
      recognition.onerror = (e) => {
        listening = false; micBtn.classList.remove('active'); setState('idle');
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          micBtn.disabled = true;
          micNote.hidden = false;
          micNote.textContent = "Microphone access was blocked — check your browser's site permissions, or just type instead.";
        }
      };
      recognition.onresult = (e) => {
        const said = e.results[0][0].transcript;
        handleQuery(said);
      };
    } catch (e) { micReady = false; }
  }
  if (!micReady) {
    micBtn.disabled = true;
    micNote.hidden = false;
    micNote.textContent = "Voice input isn't supported in this browser — try Chrome or Edge, or just type.";
  }
  micBtn.addEventListener('click', () => {
    if (!recognition || listening) return;
    try { recognition.start(); } catch (e) { /* already started */ }
  });

  // ---------- Chat reasoning (via your Supabase Edge Function, powered by Groq) ----------
  //
  // The frontend never sees your Groq API key. It calls the "vesper-chat"
  // Edge Function in your Supabase project, which holds the key server-side
  // and forwards the request to Groq. See README.md to set it up.
  // (System Control / desktop actions are a separate path — see runAgentCommand
  // above — and still go through Claude directly via the local agent.)

  const PERSONA = "You are VESPER, a calm, sharp, faintly witty AI assistant with a sci-fi HUD-computer personality (think: a ship's AI, not a chatty chatbot). You are helping Lazarus, a software developer who runs a small digital agency in Cape Town, South Africa. Keep replies conversational and brief — 1 to 4 sentences unless the question genuinely needs more. Never use markdown, asterisks, or headers, since replies may be read aloud.";

  let history = []; // {role:'user'|'assistant', content}

  async function streamClaude(userText, onDelta) {
    const messages = history.slice(-10).map(t => ({ role: t.role, content: t.content }));
    messages.push({ role: 'user', content: userText });

    const resp = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/vesper-chat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        'apikey': CONFIG.SUPABASE_ANON_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        system: PERSONA,
        messages
      })
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
            onDelta(fullText);
          }
        } catch (e) { /* ignore partial/non-JSON lines */ }
      }
    }
    return fullText;
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
        history.push({ role: 'user', content: text });
        history.push({ role: 'assistant', content: finalText });
        speak(finalText);
        return;
      }
    }
  }

  function localQuickReply(text) {
    const q = text.trim().toLowerCase();
    if (/^(what('| i)?s the time|what time is it)\b/.test(q)) {
      return "It's " + new Date().toLocaleTimeString('en-GB', { hour12: false }) + ", South Africa Standard Time.";
    }
    if (/^(what('| i)?s the date|what day is it)\b/.test(q)) {
      return "Today is " + new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + ".";
    }
    return null;
  }

  async function handleQuery(rawText) {
    const text = (rawText || '').trim();
    if (!text) return;
    appendMessage('user', text);

    if (agentOn && agentReachable) {
      return runAgentCommand(text);
    }

    const quick = localQuickReply(text);
    if (quick) {
      history.push({ role: 'user', content: text });
      appendMessage('vesper', quick);
      history.push({ role: 'assistant', content: quick });
      speak(quick);
      return;
    }

    history.push({ role: 'user', content: text });
    setState('thinking');
    const bubble = appendMessage('vesper', 'Thinking…');

    try {
      const finalText = await streamClaude(text, (partial) => updateMessage(bubble, partial));
      const cleanText = finalText || "I didn't catch a usable answer for that.";
      updateMessage(bubble, cleanText);
      history.push({ role: 'assistant', content: cleanText });
      speak(cleanText);
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
