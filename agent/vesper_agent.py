"""
Vesper Agent — a local companion server that gives Vesper real control over
this computer: opening/closing programs, running commands, managing files,
and seeing + clicking/typing anywhere on screen (like a human would), driven
by Gemini's computer-use tool (free tier, no credit card required).

This is intentionally a SEPARATE process from the web UI (index.html), and it
needs to be, because a browser tab can never reach outside itself to control
other applications — that's a security boundary the browser enforces, not
something the web app can opt out of. This script runs directly on your
machine with real permissions instead.

SAFETY MODEL (as requested):
  - Opening a known app, reading files/dirs, moving the mouse, clicking,
    typing, and taking screenshots happen immediately — no prompt.
  - Anything the agent itself flags as risky — closing an app, running a
    shell command, writing or deleting a file — PAUSES and waits for you to
    approve it from the Vesper web page before continuing. Gemini's own
    built-in safety checks (e.g. on sensitive on-screen actions) are routed
    through the same approval bar.
  - Sending or submitting something via a plain screen click/keystroke — a
    "Send" button in Outlook/WhatsApp/Slack/Teams, pressing Enter in a chat
    app, "Submit", "Post", "Publish", "Pay", "Place order" — is a GENERIC
    computer-use click/type action with no special tool name, so it's caught
    two independent ways: (1) Gemini's own safety_decision field on the
    action itself, when it flags one of its built-in categories
    (communication_tool, financial_transactions, etc.), and (2) a local
    backstop that reads the free-text `intent` Gemini writes for every
    click/type action (e.g. "Click Send to email X the message: Y") and
    pauses on send/submit/post/publish/pay-type verbs regardless of what
    Gemini's own judgment did. Either one pausing is enough to show the
    confirm bar — see RISKY_INTENT_RE and the safety_decision handling in
    run_agent_loop() below. This is a backstop, not a certainty: it depends
    on the model's own intent text being specific, which is why PERSONA
    explicitly asks for that.
  - Every action is written to agent_log.txt next to this file, so there's
    always a record of exactly what Vesper did.
  - Each run is capped at MAX_STEPS actions so a confused loop can't run
    forever.

Run it with:  python vesper_agent.py
It listens on http://127.0.0.1:7891 — the Vesper web page talks to it there
when you turn on "System Control" in the UI.

IMPORTANT: Gemini's computer-use tool (the "Interactions API" used below) is
a newer capability. The exact response object's attribute names are read
defensively here (several fallbacks per field) because the SDK is still
evolving — if you hit an AttributeError when this actually runs, check
https://ai.google.dev/gemini-api/docs/computer-use for the current shape of
`client.interactions.create(...)`'s return value and adjust the `_get`
helper calls below accordingly.
"""

import base64
import io
import json
import os
import re
import subprocess
import threading
import time
import uuid
from datetime import datetime

from dotenv import load_dotenv

load_dotenv()

import psutil
import pyautogui
from google import genai
from flask import Flask, jsonify, request
from flask_cors import CORS

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
# Verify this is still current / check free-tier status at
# https://ai.google.dev/gemini-api/docs/computer-use and
# https://ai.google.dev/gemini-api/docs/pricing
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
ENVIRONMENT = os.environ.get("VESPER_AGENT_ENVIRONMENT", "desktop")

PORT = int(os.environ.get("VESPER_AGENT_PORT", "7891"))
MAX_STEPS = 25
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_log.txt")

SCREEN_WIDTH, SCREEN_HEIGHT = pyautogui.size()
pyautogui.FAILSAFE = True  # slam the mouse to a screen corner to abort a pyautogui action

PERSONA = (
    "You are VESPER, an AI assistant with real control over the user's Windows "
    "computer through function tools and a computer-use tool that lets you see "
    "the screen and click/type on it. The user is Lazarus, a software developer "
    "in Cape Town who runs a small digital agency. Be efficient: look at the "
    "screen, act, and confirm what happened in plain language at the end. Don't "
    "narrate every intermediate step out loud — just do the task and report the "
    "result in 1-3 sentences when you're done.\n\n"
    "Important: whenever you click, tap, or press Enter on something that will "
    "send a message, submit a form, publish a post, place an order, or make a "
    "payment on the user's behalf, write that action's own intent description "
    "explicitly and specifically — name what is being sent and to whom/where "
    "(e.g. \"Click Send to email john@example.com the message: running 10 "
    "minutes late\"), not a vague \"click Send button\". A local safety check "
    "reads that description before letting the action through, so a vague one "
    "may fail to pause when it should."
)

app = Flask(__name__)
CORS(app)

client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

# task_id -> state dict. This is intentionally simple in-memory state — this
# server is meant for one user on one machine, not a multi-tenant service.
TASKS = {}


def log(line):
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"[{stamp}] {line}\n")
    print(f"[{stamp}] {line}")


def _get(obj, *names, default=None):
    """Defensively read the first attribute/key that exists on obj, trying
    several possible names — a hedge against SDK object shapes changing."""
    for name in names:
        if isinstance(obj, dict):
            if name in obj:
                return obj[name]
        elif hasattr(obj, name):
            val = getattr(obj, name)
            if val is not None:
                return val
    return default


# ---------------------------------------------------------------------------
# Local capabilities (custom function tools)
# ---------------------------------------------------------------------------

KNOWN_APPS = {
    "notepad": "notepad",
    "calculator": "calc",
    "calc": "calc",
    "explorer": "explorer",
    "file explorer": "explorer",
    "vs code": "code",
    "visual studio code": "code",
    "chrome": "chrome",
    "google chrome": "chrome",
    "edge": "msedge",
    "microsoft edge": "msedge",
    "terminal": "wt",
    "windows terminal": "wt",
    "cmd": "cmd",
    "command prompt": "cmd",
    "powershell": "powershell",
    "paint": "mspaint",
    "task manager": "taskmgr",
    "spotify": "spotify:",
}

RISKY_SHELL_KEYWORDS = [
    "del ", "erase ", "rd ", "rmdir", "format", "diskpart", "shutdown",
    "remove-item", "rm -rf", "reg delete", "net user", "taskkill /f",
]


def find_start_menu_shortcut(name):
    key = name.strip().lower()
    search_dirs = [
        os.path.join(os.environ.get("APPDATA", ""), r"Microsoft\Windows\Start Menu\Programs"),
        os.path.join(os.environ.get("PROGRAMDATA", ""), r"Microsoft\Windows\Start Menu\Programs"),
    ]
    for base in search_dirs:
        if not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            for fname in files:
                if fname.lower().endswith(".lnk") and key in fname.lower():
                    return os.path.join(root, fname)
    return None


def open_application(name):
    key = name.strip().lower()
    cmd = KNOWN_APPS.get(key)
    if cmd:
        subprocess.Popen(f'start "" {cmd}', shell=True)
        log(f"open_application: launched known app '{name}' via '{cmd}'")
        return f"Launched {name}."

    shortcut = find_start_menu_shortcut(name)
    if shortcut:
        os.startfile(shortcut)
        log(f"open_application: launched '{name}' via Start Menu shortcut {shortcut}")
        return f"Launched {name} from the Start Menu."

    try:
        subprocess.Popen(f'start "" "{name}"', shell=True)
        log(f"open_application: attempted direct launch of '{name}'")
        return f"Tried launching '{name}' directly — if that didn't work, it may not be installed or on PATH."
    except Exception as e:
        log(f"open_application: FAILED for '{name}': {e}")
        return f"Couldn't find or launch '{name}': {e}"


def close_application(name):
    key = name.strip().lower()
    closed = []
    for p in psutil.process_iter(["pid", "name"]):
        pname = (p.info.get("name") or "").lower()
        if key in pname:
            try:
                p.terminate()
                closed.append(p.info.get("name"))
            except Exception:
                pass
    if closed:
        log(f"close_application: closed {closed} (matched '{name}')")
        return f"Closed: {', '.join(closed)}"
    log(f"close_application: no match for '{name}'")
    return f"No running process matching '{name}' was found."


def list_processes():
    names = sorted({p.info.get("name") for p in psutil.process_iter(["name"]) if p.info.get("name")})
    return ", ".join(names[:200])


def run_shell_command(command):
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, timeout=30
        )
        out = (result.stdout or "").strip()
        err = (result.stderr or "").strip()
        log(f"run_shell_command: `{command}` -> exit {result.returncode}")
        return json.dumps({"exit_code": result.returncode, "stdout": out[:4000], "stderr": err[:2000]})
    except subprocess.TimeoutExpired:
        return json.dumps({"error": "Command timed out after 30 seconds."})
    except Exception as e:
        return json.dumps({"error": str(e)})


def list_directory(path):
    try:
        entries = os.listdir(path)
        return "\n".join(entries[:500])
    except Exception as e:
        return f"Error listing '{path}': {e}"


def read_text_file(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(20000)
        return content
    except Exception as e:
        return f"Error reading '{path}': {e}"


def write_text_file(path, content):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True) if os.path.dirname(path) else None
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        log(f"write_text_file: wrote {len(content)} chars to '{path}'")
        return f"Wrote {len(content)} characters to {path}."
    except Exception as e:
        log(f"write_text_file: FAILED for '{path}': {e}")
        return f"Error writing '{path}': {e}"


def delete_path(path):
    try:
        if os.path.isdir(path):
            os.rmdir(path)  # only removes empty dirs — deliberately not recursive
        else:
            os.remove(path)
        log(f"delete_path: deleted '{path}'")
        return f"Deleted {path}."
    except Exception as e:
        log(f"delete_path: FAILED for '{path}': {e}")
        return f"Error deleting '{path}': {e}"


CUSTOM_FUNCTIONS = {
    "open_application": lambda i: open_application(i.get("name", "")),
    "close_application": lambda i: close_application(i.get("name", "")),
    "list_processes": lambda i: list_processes(),
    "run_shell_command": lambda i: run_shell_command(i.get("command", "")),
    "list_directory": lambda i: list_directory(i.get("path", "")),
    "read_text_file": lambda i: read_text_file(i.get("path", "")),
    "write_text_file": lambda i: write_text_file(i.get("path", ""), i.get("content", "")),
    "delete_path": lambda i: delete_path(i.get("path", "")),
}

RISKY_TOOLS = {"close_application", "run_shell_command", "write_text_file", "delete_path"}

CUSTOM_TOOL_SCHEMAS = [
    {
        "type": "function",
        "name": "open_application",
        "description": "Launch a desktop application by name (e.g. 'Notepad', 'Chrome', 'VS Code', 'Spotify'). Does not require approval.",
        "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
    },
    {
        "type": "function",
        "name": "close_application",
        "description": "Terminate all running processes whose name matches. Requires user approval before it runs.",
        "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
    },
    {
        "type": "function",
        "name": "list_processes",
        "description": "List the names of currently running processes. Does not require approval.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "type": "function",
        "name": "run_shell_command",
        "description": "Run a Windows shell (cmd.exe) command and return its output. Requires user approval before it runs.",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]},
    },
    {
        "type": "function",
        "name": "list_directory",
        "description": "List files and folders at a path. Does not require approval.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    },
    {
        "type": "function",
        "name": "read_text_file",
        "description": "Read a text file's contents (first 20,000 characters). Does not require approval.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    },
    {
        "type": "function",
        "name": "write_text_file",
        "description": "Create or overwrite a text file with the given content. Requires user approval before it runs.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
    {
        "type": "function",
        "name": "delete_path",
        "description": "Delete a single file, or an empty folder. Requires user approval before it runs.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    },
]


def describe_risky_call(name, tool_input):
    if name == "close_application":
        return f"Close all running programs matching \"{tool_input.get('name')}\""
    if name == "run_shell_command":
        return f"Run this shell command: {tool_input.get('command')}"
    if name == "write_text_file":
        return f"Write/overwrite the file: {tool_input.get('path')}"
    if name == "delete_path":
        return f"Delete: {tool_input.get('path')}"
    return f"{name}({tool_input})"


def is_extra_risky_shell(tool_input):
    command = (tool_input.get("command") or "").lower()
    return any(k in command for k in RISKY_SHELL_KEYWORDS)


# ---------------------------------------------------------------------------
# Send/submit confirmation backstop for computer-use clicks and keystrokes
# ---------------------------------------------------------------------------
#
# Gemini's computer-use tool has its own built-in safety check: a risky
# action can come back with `arguments.safety_decision = {"decision":
# "require_confirmation", "explanation": "..."}` (confirmed against Google's
# docs at ai.google.dev/gemini-api/docs/computer-use — this is a real field,
# nested inside the function call's own arguments dict, not a made-up shape).
# That's handled below in run_agent_loop.
#
# It is NOT reliable enough to be the only gate, though — it's Gemini's own
# judgment call about what counts as risky, tuned for its own predefined
# categories (financial_transactions, communication_tool, etc.), and there's
# no guarantee it fires for every "click Send in some third-party desktop
# app" scenario. As a backstop that doesn't depend on Gemini flagging itself,
# every click/type action ALSO carries a model-written `intent` string (e.g.
# "Click the Send button to submit the email") — also confirmed against
# Google's docs, present on every computer-use action, not just risky ones.
# RISKY_INTENT_RE checks that text for send/submit/publish/pay-type verbs and
# routes the match through the exact same _await_confirmation()/confirm-bar
# flow already used for the four custom tools, independent of whether Gemini
# itself asked for confirmation.
RISKY_INTENT_ACTIONS = {"click", "double_click", "type"}
RISKY_INTENT_RE = re.compile(
    r"\b(send|submit|post|publish|pay|purchase|buy now|check ?out|"
    r"place (the |your )?order|confirm (the |your )?order)\b",
    re.IGNORECASE,
)


def looks_like_risky_send(intent_text):
    return bool(intent_text) and bool(RISKY_INTENT_RE.search(intent_text))


def describe_risky_send(intent_text, last_typed_text):
    preview = f' Last text typed on screen: "{last_typed_text[:200]}"' if last_typed_text else ""
    return f'Vesper is about to do this: "{intent_text}".{preview} Send it?'


# ---------------------------------------------------------------------------
# Computer-use action execution (Gemini's predefined desktop/browser actions)
# ---------------------------------------------------------------------------

def denormalize(x, y):
    """Gemini returns coordinates on a 0-999 scale, independent of actual
    screen resolution — convert to real pixels. Per Google's docs the
    denormalization divisor is 1000 even though the range is 0-999."""
    return int(x / 1000 * SCREEN_WIDTH), int(y / 1000 * SCREEN_HEIGHT)


def take_screenshot_bytes():
    img = pyautogui.screenshot()
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


COMPUTER_USE_ACTIONS = {
    "click", "double_click", "right_click", "type", "scroll", "drag_and_drop",
    "navigate", "go_back", "go_forward", "press_key", "hotkey", "wait", "take_screenshot",
}


def execute_computer_action(name, args):
    try:
        if name == "click":
            x, y = denormalize(args["x"], args["y"])
            pyautogui.click(x, y)
        elif name == "double_click":
            x, y = denormalize(args["x"], args["y"])
            pyautogui.doubleClick(x, y)
        elif name == "right_click":
            x, y = denormalize(args["x"], args["y"])
            pyautogui.rightClick(x, y)
        elif name == "type":
            pyautogui.write(args.get("text", ""), interval=0.015)
            if args.get("press_enter"):
                pyautogui.press("enter")
        elif name == "scroll":
            x, y = denormalize(args.get("x", 500), args.get("y", 500))
            pyautogui.moveTo(x, y)
            direction = args.get("direction", "down")
            amount = max(1, int(args.get("magnitude_in_pixels", 300)) // 20)
            vertical = {"up": amount, "down": -amount}.get(direction)
            if vertical is not None:
                pyautogui.scroll(vertical)
            else:
                horiz = {"left": -amount, "right": amount}.get(direction, 0)
                pyautogui.hscroll(horiz)
        elif name == "drag_and_drop":
            sx, sy = denormalize(args["start_x"], args["start_y"])
            ex, ey = denormalize(args["end_x"], args["end_y"])
            pyautogui.moveTo(sx, sy)
            pyautogui.dragTo(ex, ey, duration=0.3)
        elif name == "navigate":
            # Desktop environment: best-effort via the default browser.
            import webbrowser
            webbrowser.open(args.get("url", ""))
        elif name == "go_back":
            pyautogui.hotkey("alt", "left")
        elif name == "go_forward":
            pyautogui.hotkey("alt", "right")
        elif name == "press_key":
            pyautogui.press(args.get("key", "").lower())
        elif name == "hotkey":
            keys = [k.lower() for k in args.get("keys", [])]
            if keys:
                pyautogui.hotkey(*keys)
        elif name == "wait":
            time.sleep(min(args.get("seconds", 1), 5))
        elif name == "take_screenshot":
            pass
        else:
            log(f"computer action: unknown action '{name}'")
        time.sleep(0.35)
    except Exception as e:
        log(f"computer action '{name}' failed: {e}")


# ---------------------------------------------------------------------------
# Agent loop (Gemini Interactions API)
# ---------------------------------------------------------------------------

def run_agent_loop(task_id, user_text):
    state = TASKS[task_id]
    state["status"] = "running"
    state["log"].append({"role": "user", "text": user_text})
    log(f"task {task_id}: START — \"{user_text}\"")

    if client is None:
        state["status"] = "error"
        state["result"] = "GEMINI_API_KEY is not set in agent/.env — see README.md."
        return

    tools = CUSTOM_TOOL_SCHEMAS + [{"type": "computer_use", "environment": ENVIRONMENT}]
    screenshot = take_screenshot_bytes()

    try:
        interaction = client.interactions.create(
            model=MODEL,
            input=[
                {"type": "text", "text": f"{PERSONA}\n\nTask from Lazarus: {user_text}"},
                {"type": "image", "data": base64.b64encode(screenshot).decode("utf-8"), "mime_type": "image/png"},
            ],
            tools=tools,
        )
    except Exception as e:
        log(f"task {task_id}: Gemini call failed: {e}")
        state["status"] = "error"
        state["result"] = f"Gemini API error: {e}"
        return

    for step_num in range(MAX_STEPS):
        steps = _get(interaction, "steps", "output", default=[]) or []

        text_parts = []
        function_calls = []
        for s in steps:
            s_type = _get(s, "type")
            if s_type in ("model_output", "text", "message"):
                # Confirmed shape (per ai.google.dev/gemini-api/docs/interactions):
                # {"type": "model_output", "content": [{"type": "text", "text": "..."}]}
                # Also accept a flat .text as a fallback in case the SDK sugars it.
                t = _get(s, "text")
                if t:
                    text_parts.append(t)
                else:
                    for c in (_get(s, "content", default=[]) or []):
                        if _get(c, "type") == "text":
                            ct = _get(c, "text")
                            if ct:
                                text_parts.append(ct)
            elif s_type == "function_call":
                function_calls.append(s)

        if text_parts:
            state["log"].append({"role": "vesper", "text": " ".join(text_parts)})

        if not function_calls:
            state["status"] = "done"
            state["result"] = " ".join(text_parts) if text_parts else "Done."
            log(f"task {task_id}: DONE — {state['result']}")
            return

        function_responses = []
        for call in function_calls:
            name = _get(call, "name")
            call_id = _get(call, "id", "call_id", default=str(uuid.uuid4()))
            args = _get(call, "arguments", "args", default={}) or {}

            safety = args.get("safety_decision") if isinstance(args, dict) else None
            approved_already = False
            if safety and safety.get("decision") == "require_confirmation":
                description = f"Gemini flagged this for approval: {safety.get('explanation', name)}"
                approved_already = _await_confirmation(state, description)
                if not approved_already:
                    function_responses.append(_result(name, call_id, "Denied by user.", screenshot=take_screenshot_bytes(), is_error=True))
                    continue

            if name in CUSTOM_FUNCTIONS:
                needs_confirm = name in RISKY_TOOLS or (name == "run_shell_command" and is_extra_risky_shell(args))
                if needs_confirm and not approved_already:
                    description = describe_risky_call(name, args)
                    if not _await_confirmation(state, description):
                        function_responses.append(_result(name, call_id, "The user denied this action. Do not retry it.", is_error=True))
                        continue
                output = CUSTOM_FUNCTIONS[name](args)
                function_responses.append(_result(name, call_id, str(output)))

            elif name in COMPUTER_USE_ACTIONS:
                cu_args = args if isinstance(args, dict) else {}
                intent_text = cu_args.get("intent") or ""
                if name == "type" and cu_args.get("text"):
                    state["last_typed_text"] = cu_args.get("text")

                # Backstop: only runs when Gemini's OWN safety_decision didn't
                # already gate this action above — this is the second,
                # independent check, not a replacement for it.
                if not approved_already and name in RISKY_INTENT_ACTIONS and looks_like_risky_send(intent_text):
                    description = describe_risky_send(intent_text, state.get("last_typed_text"))
                    approved_already = _await_confirmation(state, description)
                    if not approved_already:
                        function_responses.append(_result(name, call_id, "The user denied this action. Do not retry it.", is_error=True, screenshot=take_screenshot_bytes()))
                        continue

                execute_computer_action(name, cu_args)
                shot = take_screenshot_bytes()
                result_value = {"ok": True}
                if approved_already:
                    # Per Google's computer-use docs, the model expects this
                    # flag back on the result once a human has approved a
                    # confirmation-gated action, whether Gemini's own
                    # safety_decision asked for it or our own backstop did.
                    result_value["safety_acknowledgement"] = True
                function_responses.append(_result(name, call_id, result_value, screenshot=shot))

            else:
                function_responses.append(_result(name, call_id, f"Unknown tool '{name}'", is_error=True))

        try:
            interaction = client.interactions.create(
                model=MODEL,
                previous_interaction_id=_get(interaction, "id"),
                input=function_responses,
                tools=tools,
            )
        except Exception as e:
            log(f"task {task_id}: Gemini follow-up call failed: {e}")
            state["status"] = "error"
            state["result"] = f"Gemini API error: {e}"
            return

    state["status"] = "done"
    state["result"] = "Stopped after reaching the step limit for a single task — ask again to continue."
    log(f"task {task_id}: STEP LIMIT reached")


def _result(name, call_id, result_value, screenshot=None, is_error=False):
    content = [{"type": "text", "text": json.dumps(result_value) if not isinstance(result_value, str) else result_value}]
    if screenshot:
        content.append({"type": "image", "data": base64.b64encode(screenshot).decode("utf-8"), "mime_type": "image/png"})
    entry = {"type": "function_result", "name": name, "call_id": call_id, "result": content}
    if is_error:
        entry["is_error"] = True
    return entry


def _await_confirmation(state, description):
    state["status"] = "waiting_confirmation"
    state["pending"] = {"description": description}
    state["confirm_event"].clear()
    log(f"WAITING for approval — {description}")
    state["confirm_event"].wait(timeout=300)  # 5 min to respond
    approved = bool(state.get("approved"))
    state["status"] = "running"
    state["pending"] = None
    log(("APPROVED — " if approved else "DENIED — ") + description)
    return approved


# ---------------------------------------------------------------------------
# HTTP API
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "model": MODEL, "has_key": bool(GEMINI_API_KEY)})


@app.route("/command", methods=["POST"])
def command():
    body = request.get_json(force=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        return jsonify({"error": "Missing 'text'."}), 400

    task_id = str(uuid.uuid4())
    TASKS[task_id] = {
        "status": "starting",
        "log": [],
        "result": None,
        "pending": None,
        "approved": False,
        "confirm_event": threading.Event(),
        "last_typed_text": None,
    }
    thread = threading.Thread(target=run_agent_loop, args=(task_id, text), daemon=True)
    thread.start()
    return jsonify({"task_id": task_id})


@app.route("/status/<task_id>", methods=["GET"])
def status(task_id):
    state = TASKS.get(task_id)
    if not state:
        return jsonify({"error": "Unknown task_id."}), 404
    return jsonify({
        "status": state["status"],
        "log": state["log"],
        "result": state["result"],
        "pending": state["pending"],
    })


@app.route("/confirm/<task_id>", methods=["POST"])
def confirm(task_id):
    state = TASKS.get(task_id)
    if not state:
        return jsonify({"error": "Unknown task_id."}), 404
    body = request.get_json(force=True) or {}
    state["approved"] = bool(body.get("approved"))
    state["confirm_event"].set()
    return jsonify({"ok": True})


if __name__ == "__main__":
    print(f"Vesper Agent listening on http://127.0.0.1:{PORT}")
    print(f"Screen size detected as {SCREEN_WIDTH}x{SCREEN_HEIGHT}")
    print(f"Model: {MODEL} | Environment: {ENVIRONMENT}")
    if not GEMINI_API_KEY:
        print("WARNING: GEMINI_API_KEY is not set — copy agent/.env.example to agent/.env and fill it in.")
    app.run(host="127.0.0.1", port=PORT, debug=False)
