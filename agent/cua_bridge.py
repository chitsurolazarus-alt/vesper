"""
Synchronous facade over cua-driver's async Python SDK (`pip install cua-driver`,
MIT). vesper_agent.py is a threaded Flask app, while the SDK is asyncio-only
and loads a Rust runtime in-process, so this module owns one background event
loop + one driver instance and lets any thread call `bridge.call(tool, args)`.

Permission layering (cua-driver's own system, UNDERNEATH Vesper's confirm bar):
  standard  — promptless routine automation (default)
  bounded   — deny-by-default; only tools/resources named in a reviewed
              capability manifest (agent/cua_manifest.yaml) are admitted
  unrestricted is deliberately NOT exposed here: it needs cua-driver's explicit
  "dangerously bypass approvals" acknowledgment and Vesper has no use for it.

Vesper also applies its own allowlist (EXPOSED_TOOLS in vesper_agent.py) so the
model can never even name tools like kill_app / set_config / clipboard_read.
"""

import asyncio
import json
import threading

from cua_driver import (
    ConfiguredDriverOptions,
    CuaDriver,
    DriverAuthorizationAction,
    DriverAuthorizationDecision,
    DriverAuthorizationHost,
    RuntimeAuthorizationOptions,
    SessionPermissionMode,
)

MODES = {
    "standard": SessionPermissionMode.STANDARD,
    "bounded": SessionPermissionMode.BOUNDED,
}


class _HostAuthorizer(DriverAuthorizationHost):
    """cua-driver calls this only for a 'residual boundary' its active mode
    says needs a trusted-host decision (routine standard-mode clicking/typing
    never reaches it). Vesper's answer is always deny + log — anything that
    needs a host grant should surface through Vesper's own confirm bar first,
    not be silently granted from inside the driver."""

    def __init__(self, log):
        self._log = log
        self.requests = []

    async def authorize(self, request):
        self.requests.append(request)
        self._log(
            f"cua-driver asked the host to authorize a boundary "
            f"(risk_class={request.risk_class}, mode={request.permission_mode}): "
            f"{request.human_summary} — DENIED"
        )
        return DriverAuthorizationDecision(
            action=DriverAuthorizationAction.DENY,
            request_digest=request.request_digest,
        )


class CuaBridge:
    def __init__(self, mode="standard", manifest_path=None, log=print):
        if mode not in MODES:
            raise ValueError(f"Unsupported cua-driver permission mode '{mode}'. Use one of: {', '.join(MODES)}.")
        self.mode = mode
        self.manifest_path = manifest_path
        self._log = log
        self._loop = None
        self._thread = None
        self._driver = None
        self._ready = threading.Event()
        self._start_error = None
        self.authorizer = _HostAuthorizer(log)

    # -- lifecycle ---------------------------------------------------------

    def start(self, timeout=30):
        self._thread = threading.Thread(target=self._run_loop, name="cua-bridge", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout):
            raise RuntimeError("cua-driver did not initialise in time.")
        if self._start_error:
            raise self._start_error

    def _run_loop(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            manifest = self.manifest_path if self.mode == "bounded" else None
            if self.mode == "bounded" and not manifest:
                raise RuntimeError("bounded mode needs a capability manifest (VESPER_CUA_MANIFEST).")
            opts = ConfiguredDriverOptions(
                claude_code_compatibility=False,
                authorization=RuntimeAuthorizationOptions(
                    allowed_modes=[MODES[self.mode]],
                    compatibility_mode=MODES[self.mode],
                    compatibility_capability_manifest_path=manifest,
                    compatibility_bounded_manifest_path=manifest,
                    unrestricted_acknowledged=False,
                    max_session_ttl_seconds=8 * 3600,
                    max_idle_ttl_seconds=3600,
                ),
            )
            self._driver = CuaDriver.create_configured_with_authorization_host(opts, self.authorizer)
        except Exception as e:  # surfaced to start()
            self._start_error = e
        finally:
            self._ready.set()
        if not self._start_error:
            self._loop.run_forever()

    def shutdown(self):
        if self._loop and self._driver:
            fut = asyncio.run_coroutine_threadsafe(self._driver.shutdown(), self._loop)
            try:
                fut.result(10)
            except Exception:
                pass
            self._loop.call_soon_threadsafe(self._loop.stop)

    # -- calling tools -----------------------------------------------------

    def call(self, name, args=None, timeout=60):
        """Run one cua-driver tool. Never raises — returns a dict:
        {ok, text, data, images:[{mime_type, data_base64}], error_code}"""
        if not self._driver:
            return {"ok": False, "text": "cua-driver is not running.", "data": None, "images": [], "error_code": "not_started"}
        fut = asyncio.run_coroutine_threadsafe(
            self._driver.call_tool(name, json.dumps(args or {})), self._loop
        )
        try:
            r = fut.result(timeout)
        except Exception as e:
            return {"ok": False, "text": f"cua-driver call failed: {e}", "data": None, "images": [], "error_code": "exception"}
        data = None
        if r.structured_json:
            try:
                data = json.loads(r.structured_json)
            except Exception:
                data = None
        return {
            "ok": not r.is_error,
            "text": r.text or "",
            "data": data,
            "images": [{"mime_type": i.mime_type, "data_base64": i.data_base64} for i in (r.images or [])],
            "error_code": r.error_code,
        }
