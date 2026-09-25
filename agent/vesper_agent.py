"""
Vesper Agent — a local companion server that gives Vesper real control over
this computer: opening/closing programs, running commands, managing files,
and operating any Windows app's UI (click, type, press keys, read what's on
screen) the way a person would.

Screen control goes through cua-driver, which reads apps through Windows UI
Automation and hands the model the screen as TEXT (an element tree), so the
reasoning model only needs ordinary tool calling. That makes the model
swappable (Gemini or Groq — see llm.py and VESPER_REASONER). Quick toggles
(mute, Do Not Disturb, lock) skip the model entirely — see toggles.py.

This is intentionally a SEPARATE process from the web UI (index.html), and it
needs to be, because a browser tab can never reach outside itself to control
other applications — that's a security boundary the browser enforces, not
something the web app can opt out of. This script runs directly on your
machine with real permissions instead.

SAFETY MODEL:
  - Opening a known app, reading files/dirs, reading the screen, clicking and
    typing happen immediately — no prompt.
  - Closing an app, running a shell command, writing or deleting a file PAUSE
    and wait for you to approve from the Vesper web page.
  - Sending or submitting something through the UI (a "Send" button, Ctrl+Enter,
    "Submit", "Post", "Publish", "Pay", "Place order") is a plain click or
    keypress with no special tool name, so it's caught two independent ways
    (see RISKY_INTENT_RE and check_ui_action_risk below): (1) the real label of
    the element being clicked, resolved by this server from the UI tree — it
    doesn't depend on the model being honest — and (2) the free-text `intent`
    the model must attach to every action. Either one pausing shows the confirm
    bar. Known gap: a bare Enter keypress with no element and a vague intent
    can slip past both; Ctrl/Alt+Enter is always gated.
  - The model can only name tools in EXPOSED_CUA_TOOLS. kill_app,
    clipboard_read/write, set_config, browser `page` and the like are never
    offered to it.
  - Every action is written to agent_log.txt next to this file.
  - Each run is capped at MAX_STEPS actions so a confused loop can't run
    forever.

Run it with:  python vesper_agent.py
It listens on http://127.0.0.1:7891 — the Vesper web page talks to it there
when you turn on "System Control" in the UI.
"""

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
from flask import Flask, jsonify, request
from flask_cors import CORS

import toggles
from llm import ReasonerError, make_reasoner

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PORT = int(os.environ.get("VESPER_AGENT_PORT", "7891"))
MAX_STEPS = 25
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_log.txt")

# cua-driver's own permission layer, underneath Vesper's confirm bar:
#   standard (default) — promptless routine automation
#   bounded            — deny-by-default; needs VESPER_CUA_MANIFEST pointing at a
#                        reviewed capability manifest
CUA_MODE = os.environ.get("VESPER_CUA_MODE", "standard").lower()
CUA_MANIFEST = os.environ.get("VESPER_CUA_MANIFEST")

PERSONA = (
    "You are VESPER, an AI assistant with real control over the user's Windows "
    "computer. The user is Lazarus, a software developer in Cape Town who runs "
    "a small digital agency. Be efficient: do the task, then report the result "
    "in 1-3 sentences. Don't narrate every intermediate step.\n\n"
    "You cannot see pixels. You see apps as a text tree of UI elements. The "
    "workflow is: (1) open_application or list_windows to find the app's pid and "
    "window_id; (2) get_window_state to read its elements — each line is "
    "`[index] Role \"label\"`; (3) act with click / type_text / press_key / "
    "hotkey / set_value using element_index from THAT most recent "
    "get_window_state; (4) call get_window_state again to confirm the action "
    "worked before you claim it did. Indices go stale after the window changes, "
    "so re-read the state after every action that changes the UI. If an element "
    "you need isn't in the tree, say so plainly instead of guessing.\n\n"
    "Every action tool takes an `intent`. Whenever an action will send a "
    "message, submit a form, publish a post, place an order, or make a payment, "
    "write the intent explicitly — name what is being sent and to whom/where "
    "(e.g. \"Click Send to email john@example.com the message: running 10 "
    "minutes late\"), not a vague \"click button\". A local safety check "
    "reads it before the action runs. If the user denies an action, do not "
    "retry it."
)

app = Flask(__name__)
CORS(app)

# task_id -> state dict. This is intentionally simple in-memory state — this
# server is meant for one user on one machine, not a multi-tenant service.
TASKS = {}

# Lazily started so /health and the plain-file tools work even when
# cua-driver isn't installed or fails to initialise.
_bridge = None
_bridge_error = None
_bridge_lock = threading.Lock()


def get_bridge():
    """Returns (bridge, error_message). Starts cua-driver on first use."""
    global _bridge, _bridge_error
    with _bridge_lock:
        if _bridge is not None:
            return _bridge, None
        if _bridge_error:
            return None, _bridge_error
        try:
            from cua_bridge import CuaBridge
            b = CuaBridge(mode=CUA_MODE, manifest_path=CUA_MANIFEST, log=lambda m: log(m))
            b.start()
            _bridge = b
            log(f"cua-driver started (mode={CUA_MODE})")
            return _bridge, None
        except Exception as e:
            _bridge_error = f"cua-driver couldn't start: {e}"
            log(_bridge_error)
            return None, _bridge_error


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
        "name": "open_application",
        "description": "Launch a desktop application by name (e.g. 'Notepad', 'Chrome', 'VS Code', 'Spotify'). Does not require approval.",
        "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
    },
    {
        "name": "close_application",
        "description": "Terminate all running processes whose name matches. Requires user approval before it runs.",
        "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
    },
    {
        "name": "list_processes",
        "description": "List the names of currently running processes. Does not require approval.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "run_shell_command",
        "description": "Run a Windows shell (cmd.exe) command and return its output. Requires user approval before it runs.",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]},
    },
    {
        "name": "list_directory",
        "description": "List files and folders at a path. Does not require approval.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    },
    {
        "name": "read_text_file",
        "description": "Read a text file's contents (first 20,000 characters). Does not require approval.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    },
    {
        "name": "write_text_file",
        "description": "Create or overwrite a text file with the given content. Requires user approval before it runs.",
        "parameters": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
    {
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
# Screen control tools (cua-driver) — what the model is allowed to name
# ---------------------------------------------------------------------------
#
# Hand-written schemas rather than cua-driver's own: they're smaller (fewer
# tokens per step), portable across Gemini and Groq, and they let this server
# require an `intent` on every action and resolve `element_index` itself. The
# model never gets raw pixel coordinates — it has no screenshot to pick them
# from — so every click is tied to a real element whose label we can check.

_INTENT = {"type": "string", "description": "Plain-language description of exactly what this action does and why. For anything that sends/submits/posts/pays, name what and to whom."}
_PID = {"type": "integer", "description": "Process id from list_windows."}
_WID = {"type": "integer", "description": "window_id from list_windows."}
_EL = {"type": "integer", "description": "element_index from the most recent get_window_state of this same window."}


def _t(name, description, props, required):
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": props, "required": required}}


CUA_TOOL_SCHEMAS = [
    _t("list_windows", "List top-level windows (pid, window_id, title, app_name).", {}, []),
    _t("get_window_state",
       "Read one window's UI as a text tree: each line is `[index] Role \"label\"`. Call this before acting and again after to verify. Use `query` (substring) to narrow a big window.",
       {"pid": _PID, "window_id": _WID, "query": {"type": "string"}}, ["pid", "window_id"]),
    _t("click", "Click an element (or double-click with count=2).",
       {"pid": _PID, "window_id": _WID, "element_index": _EL, "count": {"type": "integer", "description": "1 (default) or 2."}, "intent": _INTENT},
       ["pid", "window_id", "element_index", "intent"]),
    _t("type_text", "Type text into an element (by element_index) or into whatever has focus in the window.",
       {"pid": _PID, "window_id": _WID, "text": {"type": "string"}, "element_index": _EL, "intent": _INTENT},
       ["pid", "window_id", "text", "intent"]),
    _t("set_value", "Set an edit field's value directly (faster and more reliable than typing for plain text fields).",
       {"pid": _PID, "window_id": _WID, "element_index": _EL, "value": {"type": "string"}, "intent": _INTENT},
       ["pid", "window_id", "element_index", "value", "intent"]),
    _t("press_key", "Press one key (return, tab, escape, up, down, delete, f1-f12, a letter...), optionally with modifiers.",
       {"pid": _PID, "window_id": _WID, "key": {"type": "string"}, "modifiers": {"type": "array", "items": {"type": "string"}, "description": "ctrl / shift / alt / win"}, "element_index": _EL, "intent": _INTENT},
       ["pid", "window_id", "key", "intent"]),
    _t("hotkey", "Press a key combination, e.g. [\"ctrl\", \"s\"].",
       {"pid": _PID, "window_id": _WID, "keys": {"type": "array", "items": {"type": "string"}}, "intent": _INTENT},
       ["pid", "window_id", "keys", "intent"]),
    _t("scroll", "Scroll a window.",
       {"pid": _PID, "window_id": _WID, "direction": {"type": "string", "enum": ["up", "down", "left", "right"]}, "amount": {"type": "integer"}, "intent": _INTENT},
       ["pid", "window_id", "direction", "intent"]),
    _t("invoke_menu", "Invoke an application-menu item by path, e.g. [\"File\", \"Save As...\"].",
       {"pid": _PID, "window_id": _WID, "path": {"type": "array", "items": {"type": "string"}}, "intent": _INTENT},
       ["pid", "window_id", "path", "intent"]),
    _t("bring_to_front", "Bring a window to the foreground.", {"pid": _PID, "window_id": _WID}, ["pid"]),
]

# The allowlist is derived from the schemas above, so a tool not defined here
# (kill_app, clipboard_read, set_config, page...) can't be reached even if a
# model invents its name.
EXPOSED_CUA_TOOLS = {t["name"] for t in CUA_TOOL_SCHEMAS}
_ELEMENT_TOOLS = {"click", "type_text", "set_value", "press_key"}
MAX_TOOL_TEXT = 14000


# ---------------------------------------------------------------------------
# Send/submit confirmation backstop for UI clicks and keystrokes
# ---------------------------------------------------------------------------
#
# Sending or submitting is an ordinary click or keypress with no special tool
# name, so it can't be gated by tool. Two independent checks, either of which
# pauses on the confirm bar:
#   1. LABEL — this server resolves element_index to the real element from the
#      UI tree and matches its label ("Send", "Submit", "Place order"...).
#      Doesn't depend on the model saying anything honest.
#   2. INTENT — the model-written description of the action. Depends on the
#      model being specific, which is why PERSONA asks for that.
# Ctrl/Alt+Enter is gated unconditionally: it's the Send shortcut in mail and
# chat apps. KNOWN GAP: a bare Enter with no element_index and a vague intent
# in a chat box is not caught by either check.
RISKY_INTENT_ACTIONS = {"click", "type_text", "set_value", "press_key", "hotkey", "invoke_menu"}
RISKY_INTENT_RE = re.compile(
    r"\b(send|submit|post|publish|pay|purchase|buy now|check ?out|"
    r"place (the |your )?order|confirm (the |your )?order)\b",
    re.IGNORECASE,
)
_ENTER_KEYS = {"return", "enter"}
_MOD_KEYS = {"ctrl", "control", "alt"}


def looks_like_risky_send(text):
    return bool(text) and bool(RISKY_INTENT_RE.search(text))


def check_ui_action_risk(name, args, element, window_title):
    """Returns a human-readable description if this action must be confirmed, else None."""
    if name not in RISKY_INTENT_ACTIONS:
        return None
    intent = args.get("intent") or ""
    where = f' in "{window_title}"' if window_title else ""
    if element and name == "click" and looks_like_risky_send(element.get("label")):
        return f'Vesper is about to click "{element.get("label")}" ({element.get("role")}){where}. Its stated intent: "{intent}". Go ahead?'
    keys = [str(k).lower() for k in ([args.get("key")] if name == "press_key" else (args.get("keys") or [])) if k]
    mods = {str(m).lower() for m in (args.get("modifiers") or [])} | {k for k in keys if k in _MOD_KEYS}
    mods &= _MOD_KEYS
    if mods and any(k in _ENTER_KEYS for k in keys):
        return f'Vesper is about to press {"+".join(sorted(mods))}+Enter{where} — usually "Send" in mail and chat apps. Its stated intent: "{intent}". Go ahead?'
    if looks_like_risky_send(intent):
        return f'Vesper is about to do this{where}: "{intent}". Go ahead?'
    return None


# ---------------------------------------------------------------------------
# Screen control execution
# ---------------------------------------------------------------------------

def _remember_snapshot(state, data):
    """Keep the latest element list per window so element_index can be resolved
    to a real element (token + label) when the model acts."""
    if not data or not data.get("window_id"):
        return
    key = (data.get("pid"), data["window_id"])
    snap = state["snapshots"].get(key)
    if not snap or snap["snapshot_id"] != data.get("snapshot_id"):
        snap = {"snapshot_id": data.get("snapshot_id"), "title": data.get("window_title"), "elements": {}}
        state["snapshots"][key] = snap
    for e in data.get("elements") or []:
        snap["elements"][e.get("element_index")] = e


def _fmt_result(r):
    text = r.get("text") or ""
    if len(text) > MAX_TOOL_TEXT:
        text = text[:MAX_TOOL_TEXT] + f"\n...[truncated {len(text) - MAX_TOOL_TEXT} chars - call get_window_state with a `query` to narrow]"
    return text if r.get("ok") else f"ERROR: {text or r.get('error_code')}"


def run_cua_tool(state, name, args):
    """Executes one exposed screen tool. Returns the result text for the model."""
    bridge, err = get_bridge()
    if not bridge:
        return f"ERROR: screen control is unavailable: {err}"

    args = dict(args)
    intent = args.pop("intent", "") or ""
    call_args = {k: v for k, v in args.items() if v is not None}
    element, title = None, None

    pid, wid = args.get("pid"), args.get("window_id")
    snap = state["snapshots"].get((pid, wid))
    if snap:
        title = snap["title"]

    if name == "get_window_state":
        call_args.update({"include_screenshot": False, "max_elements": 600, "timeout_ms": 4000})
    elif name in _ELEMENT_TOOLS:
        idx = args.get("element_index")
        if idx is not None:
            element = snap["elements"].get(idx) if snap else None
            if not element:
                return f"ERROR: no element [{idx}] is known for that window. Call get_window_state first and use an index from its output."
            call_args.pop("element_index")
            call_args["element_token"] = element["element_token"]
        elif name in {"click", "set_value"}:
            return f"ERROR: {name} needs an element_index from get_window_state."

    driver_name = name
    if name == "click" and call_args.get("count") == 2:
        driver_name = "double_click"
        call_args.pop("count")

    risk = check_ui_action_risk(name, {**args, "intent": intent}, element, title)
    if risk and not _await_confirmation(state, risk):
        return "ERROR: the user denied this action. Do not retry it."

    log(f"screen: {driver_name} {json.dumps({k: v for k, v in call_args.items() if k != 'text'})[:200]}"
        + (f" - {intent[:140]}" if intent else ""))
    r = bridge.call(driver_name, call_args)
    if name == "get_window_state" and r["ok"]:
        _remember_snapshot(state, r["data"])
    return _fmt_result(r)


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

def _reason(reasoner, messages, tools):
    """One model step with bounded retry on rate limits / overload / malformed calls."""
    attempt = 0
    while True:
        try:
            return reasoner.step(PERSONA, messages, tools)
        except ReasonerError as e:
            attempt += 1
            daily = "per day" in str(e).lower()  # a daily quota won't clear in a minute
            retryable = (e.kind in ("rate_limit", "transient") and not daily and attempt <= 3) or \
                        (e.kind == "bad_tool_call" and attempt <= 2)
            if not retryable:
                raise
            wait = 1 if e.kind == "bad_tool_call" else min(e.retry_after or 15 * attempt, 65)
            log(f"{reasoner.provider} {e.kind}, retry {attempt} in {wait:.0f}s: {e}")
            time.sleep(wait)


def _run_custom_tool(state, name, args):
    needs_confirm = name in RISKY_TOOLS or (name == "run_shell_command" and is_extra_risky_shell(args))
    if needs_confirm and not _await_confirmation(state, describe_risky_call(name, args)):
        return "The user denied this action. Do not retry it."
    return str(CUSTOM_FUNCTIONS[name](args))


def run_agent_loop(task_id, user_text):
    state = TASKS[task_id]
    state["status"] = "running"
    state["log"].append({"role": "user", "text": user_text})
    log(f"task {task_id}: START — \"{user_text}\"")

    try:
        reasoner = make_reasoner()
    except ReasonerError as e:
        state["status"], state["result"] = "error", str(e)
        return
    log(f"task {task_id}: reasoner {reasoner.provider}/{reasoner.model}")

    tools = CUSTOM_TOOL_SCHEMAS + CUA_TOOL_SCHEMAS
    messages = [{"role": "user", "text": user_text}]

    for _ in range(MAX_STEPS):
        try:
            out = _reason(reasoner, messages, tools)
        except ReasonerError as e:
            log(f"task {task_id}: {reasoner.provider} call failed ({e.kind}): {e}")
            state["status"], state["result"] = "error", f"{reasoner.provider} error: {e}"
            return

        if out["text"]:
            state["log"].append({"role": "vesper", "text": out["text"]})
        if not out["tool_calls"]:
            state["status"] = "done"
            state["result"] = out["text"] or "Done."
            log(f"task {task_id}: DONE — {state['result']}")
            return
        messages.append({"role": "assistant", "text": out["text"], "tool_calls": out["tool_calls"], "raw": out["raw"]})

        for call in out["tool_calls"]:
            name, args = call["name"], call["args"] or {}
            if name in CUSTOM_FUNCTIONS:
                content = _run_custom_tool(state, name, args)
            elif name in EXPOSED_CUA_TOOLS:
                content = run_cua_tool(state, name, args)
            else:
                content = f"ERROR: unknown tool '{name}'."
            messages.append({"role": "tool", "id": call["id"], "name": name, "content": content})

    state["status"] = "done"
    state["result"] = "Stopped after reaching the step limit for a single task — ask again to continue."
    log(f"task {task_id}: STEP LIMIT reached")


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
    provider = (os.environ.get("VESPER_REASONER") or "gemini").lower()
    key_var = {"groq": "GROQ_API_KEY", "gemini": "GEMINI_API_KEY"}.get(provider)
    return jsonify({
        "ok": True,
        "reasoner": provider,
        "has_key": bool(key_var and os.environ.get(key_var)),
        "cua_mode": CUA_MODE,
    })


QUICK_ACTIONS = {
    "mute": lambda: toggles.set_mute(True),
    "unmute": lambda: toggles.set_mute(False),
    "toggle_mute": lambda: toggles.set_mute(None),
    "dnd_on": lambda: _with_bridge(lambda b: toggles.set_dnd(b, True)),
    "dnd_off": lambda: _with_bridge(lambda b: toggles.set_dnd(b, False)),
    "toggle_dnd": lambda: _with_bridge(lambda b: toggles.set_dnd(b, None)),
    "lock": toggles.lock_screen,
}


def _with_bridge(fn):
    bridge, err = get_bridge()
    if not bridge:
        return {"ok": False, "message": f"Screen control is unavailable: {err}", "state": None}
    return fn(bridge)


@app.route("/quick", methods=["POST"])
def quick():
    """Direct toggles with no model in the loop — see toggles.py."""
    action = ((request.get_json(force=True) or {}).get("action") or "").strip()
    fn = QUICK_ACTIONS.get(action)
    if not fn:
        return jsonify({"ok": False, "message": f"Unknown quick action '{action}'.", "actions": sorted(QUICK_ACTIONS)}), 400
    result = fn()
    log(f"quick action {action}: {result.get('message')}")
    return jsonify(result)


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
        "snapshots": {},
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
    print(f"Reasoner: {os.environ.get('VESPER_REASONER') or 'gemini'} | cua-driver mode: {CUA_MODE}")
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
