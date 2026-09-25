"""
Quick app toggles — direct, deterministic Windows actions with NO LLM in the
loop (faster and more reliable than routing a one-shot toggle through the
open-ended System Control reasoning loop).

  mute / unmute / toggle mute   pycaw (Windows Core Audio endpoint volume).
                                Sets the state explicitly and reads it back,
                                so "mute" twice never un-mutes.
  Do Not Disturb                Windows has no supported API for this (verified
                                on Windows 11 25H2: the
                                NOC_GLOBAL_SETTING_TOASTS_ENABLED registry value
                                is the master "Notifications" switch, NOT Do Not
                                Disturb — the DND state isn't held there). So
                                this drives the real Settings > System >
                                Notifications switch through cua-driver's UI
                                Automation and verifies by reading it back.
                                Consequences: takes a few seconds, briefly
                                opens the Settings window, and matches the
                                English label "Do not disturb".
  lock                          user32.LockWorkStation() — same as Win+L.
                                Deliberately no confirmation: locking is safe
                                and the user can undo it by unlocking.
"""

import ctypes
import os
import time


# ---------------------------------------------------------------------------
# Volume mute
# ---------------------------------------------------------------------------

def _endpoint_volume():
    from pycaw.pycaw import AudioUtilities
    return AudioUtilities.GetSpeakers().EndpointVolume


def set_mute(want):
    """want: True (mute) | False (unmute) | None (toggle). Returns result dict."""
    try:
        import comtypes
        comtypes.CoInitialize()
    except Exception:
        pass
    try:
        ev = _endpoint_volume()
        current = bool(ev.GetMute())
        target = (not current) if want is None else bool(want)
        if target != current:
            ev.SetMute(1 if target else 0, None)
        actual = bool(ev.GetMute())
        if actual != target:
            return {"ok": False, "message": "I asked Windows to change the mute state but it didn't take.", "state": actual}
        if target == current:
            return {"ok": True, "message": "Already muted." if target else "Already unmuted.", "state": actual}
        return {"ok": True, "message": "Muted." if actual else "Unmuted.", "state": actual}
    except Exception as e:
        return {"ok": False, "message": f"Couldn't change the volume mute state: {e}", "state": None}


# ---------------------------------------------------------------------------
# Do Not Disturb (via Settings UI Automation)
# ---------------------------------------------------------------------------

def _settings_window(bridge, wait=12):
    deadline = time.time() + wait
    while time.time() < deadline:
        r = bridge.call("list_windows", {})
        for w in ((r.get("data") or {}).get("windows") or []):
            if w.get("title") == "Settings":
                return w
        time.sleep(0.4)
    return None


def _dnd_element(bridge, w, wait=8):
    deadline = time.time() + wait
    while time.time() < deadline:
        r = bridge.call("get_window_state", {"pid": w["pid"], "window_id": w["window_id"], "include_screenshot": False})
        for e in ((r.get("data") or {}).get("elements") or []):
            if e.get("role") == "Button" and (e.get("label") or "") == "Do not disturb" and "toggle" in (e.get("actions") or []):
                return e
        time.sleep(0.5)
    return None


def set_dnd(bridge, want):
    """want: True (on) | False (off) | None (toggle)."""
    existing = _settings_window(bridge, wait=0.1)
    opened_by_us = existing is None
    try:
        os.startfile("ms-settings:notifications")
    except Exception as e:
        return {"ok": False, "message": f"Couldn't open the Notifications settings page: {e}", "state": None}
    time.sleep(1.0)
    w = _settings_window(bridge)
    if not w:
        return {"ok": False, "message": "The Settings window didn't appear, so I couldn't change Do Not Disturb.", "state": None}
    try:
        el = _dnd_element(bridge, w)
        if not el:
            return {"ok": False, "message": "I couldn't find the Do Not Disturb switch in Settings (it's matched by its English label, so a non-English Windows or a redesigned page would break this).", "state": None}
        current = bool(el.get("selected"))
        target = (not current) if want is None else bool(want)
        if target == current:
            return {"ok": True, "message": "Do Not Disturb is already on." if current else "Do Not Disturb is already off.", "state": current}
        r = bridge.call("click", {"pid": w["pid"], "window_id": w["window_id"], "element_token": el["element_token"]})
        if not r["ok"]:
            return {"ok": False, "message": f"Clicking the Do Not Disturb switch failed: {r['text'][:200]}", "state": current}
        time.sleep(1.0)
        after = _dnd_element(bridge, w)
        actual = bool(after.get("selected")) if after else None
        if actual != target:
            return {"ok": False, "message": "I clicked the Do Not Disturb switch but it didn't change (read-back disagrees).", "state": actual}
        return {"ok": True, "message": "Do Not Disturb is on." if actual else "Do Not Disturb is off.", "state": actual}
    finally:
        if opened_by_us:
            _close_window(bridge, w)


def _close_window(bridge, w):
    try:
        r = bridge.call("get_window_state", {"pid": w["pid"], "window_id": w["window_id"], "include_screenshot": False})
        for e in ((r.get("data") or {}).get("elements") or []):
            if e.get("role") == "Button" and e.get("label") == "Close" and "invoke" in (e.get("actions") or []):
                bridge.call("click", {"pid": w["pid"], "window_id": w["window_id"], "element_token": e["element_token"]})
                return
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Lock screen
# ---------------------------------------------------------------------------

def lock_screen():
    try:
        ok = ctypes.windll.user32.LockWorkStation()
    except Exception as e:
        return {"ok": False, "message": f"Couldn't lock the screen: {e}", "state": None}
    if not ok:
        return {"ok": False, "message": "Windows refused the lock request.", "state": None}
    return {"ok": True, "message": "Locking your screen.", "state": True}
