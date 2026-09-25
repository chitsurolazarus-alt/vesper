"""
Reasoning-model adapters for Vesper's System Control loop.

cua-driver hands the model the screen as TEXT (a UI Automation element tree),
so the model only has to do plain function/tool calling — no vision tool, no
provider-specific computer-use API. That makes the reasoner swappable, and
this module is the seam: one small `Reasoner.step()` interface, two adapters.

  GroqReasoner    — Groq's OpenAI-compatible /chat/completions with tools
  GeminiReasoner  — google-genai generate_content with function declarations

The conversation is kept in a provider-neutral shape and converted per call:
  {"role": "user",      "text": "..."}
  {"role": "assistant", "text": "...", "tool_calls": [{"id", "name", "args"}], "raw": <provider object>}
  {"role": "tool",      "id": "...", "name": "...", "content": "..."}
Tool schemas are neutral too: {"name", "description", "parameters": <JSON schema>}.
"""

import json
import os
import time

import requests


class ReasonerError(Exception):
    """kind: 'rate_limit' | 'transient' | 'bad_tool_call' | 'fatal'."""

    def __init__(self, message, kind="fatal", retry_after=None):
        super().__init__(message)
        self.kind = kind
        self.retry_after = retry_after


class Reasoner:
    provider = "?"
    model = "?"

    def step(self, system, messages, tools):
        """Returns {"text": str, "tool_calls": [{"id","name","args"}], "raw": obj}."""
        raise NotImplementedError


# ---------------------------------------------------------------------------
# Groq
# ---------------------------------------------------------------------------

class GroqReasoner(Reasoner):
    provider = "groq"

    def __init__(self, api_key, model=None):
        self.api_key = api_key
        # Same default the chat Edge Function uses. Check console.groq.com/docs/models
        # and console.groq.com/docs/tool-use — Groq's lineup changes.
        self.model = model or "openai/gpt-oss-120b"

    @staticmethod
    def _convert(system, messages):
        out = [{"role": "system", "content": system}]
        for m in messages:
            if m["role"] == "user":
                out.append({"role": "user", "content": m["text"]})
            elif m["role"] == "assistant":
                entry = {"role": "assistant", "content": m.get("text") or None}
                if m.get("tool_calls"):
                    entry["tool_calls"] = [
                        {"id": c["id"], "type": "function",
                         "function": {"name": c["name"], "arguments": json.dumps(c["args"])}}
                        for c in m["tool_calls"]
                    ]
                out.append(entry)
            elif m["role"] == "tool":
                out.append({"role": "tool", "tool_call_id": m["id"], "content": m["content"]})
        return out

    def step(self, system, messages, tools):
        body = {
            "model": self.model,
            "messages": self._convert(system, messages),
            "tools": [{"type": "function", "function": t} for t in tools],
            "tool_choice": "auto",
            "parallel_tool_calls": False,
            "temperature": 0.2,
            "max_completion_tokens": 1500,
        }
        if "gpt-oss" in self.model:
            body["reasoning_effort"] = "low"
        try:
            resp = requests.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}", "content-type": "application/json"},
                json=body,
                timeout=60,
            )
        except requests.RequestException as e:
            raise ReasonerError(f"Groq request failed: {e}", kind="transient")

        if resp.status_code == 429:
            retry = resp.headers.get("retry-after")
            raise ReasonerError(f"Groq rate limit: {resp.text[:300]}", kind="rate_limit",
                                retry_after=float(retry) if retry and retry.replace('.', '', 1).isdigit() else None)
        if resp.status_code >= 500:
            raise ReasonerError(f"Groq server error {resp.status_code}: {resp.text[:300]}", kind="transient")
        if resp.status_code == 400 and "tool_use_failed" in resp.text:
            raise ReasonerError(f"Groq: model produced a malformed tool call: {resp.text[:300]}", kind="bad_tool_call")
        if resp.status_code != 200:
            raise ReasonerError(f"Groq error {resp.status_code}: {resp.text[:300]}", kind="fatal")

        msg = resp.json()["choices"][0]["message"]
        calls = []
        for tc in msg.get("tool_calls") or []:
            try:
                args = json.loads(tc["function"].get("arguments") or "{}")
            except json.JSONDecodeError:
                raise ReasonerError(f"Groq: unparseable tool arguments for {tc['function'].get('name')}", kind="bad_tool_call")
            calls.append({"id": tc["id"], "name": tc["function"]["name"], "args": args})
        return {"text": (msg.get("content") or "").strip(), "tool_calls": calls, "raw": None}


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------

class GeminiReasoner(Reasoner):
    provider = "gemini"

    def __init__(self, api_key, model=None):
        from google import genai
        from google.genai import types
        self._types = types
        self.client = genai.Client(api_key=api_key)
        self.model = model or "gemini-3.8-flash"

    def _contents(self, messages):
        t = self._types
        contents = []
        pending_responses = []

        def flush():
            if pending_responses:
                contents.append(t.Content(role="user", parts=list(pending_responses)))
                pending_responses.clear()

        for m in messages:
            if m["role"] == "tool":
                pending_responses.append(
                    t.Part.from_function_response(name=m["name"], response={"result": m["content"]})
                )
                continue
            flush()
            if m["role"] == "user":
                contents.append(t.Content(role="user", parts=[t.Part(text=m["text"])]))
            elif m["role"] == "assistant":
                if m.get("raw") is not None:
                    # Re-send the provider's own content object verbatim: Gemini 3
                    # models attach thought signatures to function calls and expect
                    # them back on the next turn.
                    contents.append(m["raw"])
                else:
                    parts = []
                    if m.get("text"):
                        parts.append(t.Part(text=m["text"]))
                    for c in m.get("tool_calls") or []:
                        parts.append(t.Part(function_call=t.FunctionCall(name=c["name"], args=c["args"])))
                    contents.append(t.Content(role="model", parts=parts))
        flush()
        return contents

    def step(self, system, messages, tools):
        t = self._types
        config = t.GenerateContentConfig(
            system_instruction=system,
            tools=[t.Tool(function_declarations=[
                t.FunctionDeclaration(name=x["name"], description=x["description"],
                                      parameters_json_schema=x["parameters"])
                for x in tools
            ])],
            automatic_function_calling=t.AutomaticFunctionCallingConfig(disable=True),
            temperature=0.2,
        )
        try:
            resp = self.client.models.generate_content(
                model=self.model, contents=self._contents(messages), config=config
            )
        except Exception as e:
            s = str(e)
            if "429" in s or "RESOURCE_EXHAUSTED" in s or "rate limit" in s.lower():
                raise ReasonerError(f"Gemini rate limit: {s[:300]}", kind="rate_limit")
            if "503" in s or "500" in s or "UNAVAILABLE" in s or "overloaded" in s.lower() or "high demand" in s.lower():
                raise ReasonerError(f"Gemini temporarily unavailable: {s[:300]}", kind="transient")
            raise ReasonerError(f"Gemini error: {s[:300]}", kind="fatal")

        if not resp.candidates or not resp.candidates[0].content:
            reason = getattr(resp.candidates[0], "finish_reason", None) if resp.candidates else "no candidates"
            raise ReasonerError(f"Gemini returned no content ({reason}).", kind="transient")
        content = resp.candidates[0].content
        text_parts, calls = [], []
        for i, p in enumerate(content.parts or []):
            if getattr(p, "text", None) and not getattr(p, "thought", False):
                text_parts.append(p.text)
            if getattr(p, "function_call", None):
                fc = p.function_call
                calls.append({"id": getattr(fc, "id", None) or f"call_{int(time.time()*1000)}_{i}",
                              "name": fc.name, "args": dict(fc.args or {})})
        return {"text": " ".join(text_parts).strip(), "tool_calls": calls, "raw": content}


def make_reasoner(provider=None):
    """VESPER_REASONER = groq | gemini. Defaults to gemini — the only provider
    verified end to end on this machine (see README); 'groq' is selected
    explicitly once GROQ_API_KEY is set and the benchmark has been run."""
    provider = (provider or os.environ.get("VESPER_REASONER") or "gemini").lower()
    if provider == "groq":
        key = os.environ.get("GROQ_API_KEY")
        if not key:
            raise ReasonerError("VESPER_REASONER=groq but GROQ_API_KEY is not set in agent/.env.", kind="fatal")
        return GroqReasoner(key, os.environ.get("GROQ_MODEL"))
    if provider == "gemini":
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise ReasonerError("GEMINI_API_KEY is not set in agent/.env.", kind="fatal")
        return GeminiReasoner(key, os.environ.get("GEMINI_MODEL"))
    raise ReasonerError(f"Unknown VESPER_REASONER '{provider}' (use groq or gemini).", kind="fatal")
