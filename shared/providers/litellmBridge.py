import asyncio
import json
import sys
import os
import traceback
import uuid
from typing import Any

# Ensure unbuffered stdout for NDJSON line-by-line protocol
os.environ["PYTHONUNBUFFERED"] = "1"

_protocol_fd = sys.stdout          # The REAL stdout — NDJSON only
sys.stdout = sys.stderr             # All print() / library output → stderr

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------

_shutdown = False

# Strong references to asyncio tasks to prevent GC mid-execution.
# Python docs: "Save a reference to the result of asyncio.create_task(),
# to avoid a task disappearing mid-execution."
_active_tasks: set[asyncio.Task[None]] = set()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _send(obj: dict[str, Any]) -> None:
    """Write a single NDJSON line to the protocol stdout, flushed immediately.
    Uses _protocol_fd (the REAL stdout) instead of sys.stdout to avoid
    interference from library print statements."""
    try:
        _protocol_fd.write(json.dumps(obj, default=str) + "\n")
        _protocol_fd.flush()
    except (BrokenPipeError, OSError):
        pass  # Parent process gone, nothing we can do


def _log(msg: str) -> None:
    """Write a log line to stderr (which is sys.stdout after redirect)."""
    try:
        sys.stderr.write(f"[litellm-bridge] {msg}\n")
        sys.stderr.flush()
    except (BrokenPipeError, OSError):
        pass


def _serialize_error(err: Exception) -> dict[str, Any]:
    """Serialize a Python exception for the TS side, preserving LiteLLM error types."""
    error_info: dict[str, Any] = {
        "error_type": type(err).__name__,
        "message": str(err),
        "traceback": traceback.format_exc(),
    }
    status_code = getattr(err, "status_code", None)
    if status_code is not None:
        error_info["status_code"] = status_code
    llm_provider = getattr(err, "llm_provider", None)
    if llm_provider is not None:
        error_info["llm_provider"] = llm_provider
    return error_info


def _get_reasoning_content(response: Any) -> str | None:
    try:
        choices = getattr(response, "choices", None)
        if not choices:
            return None
        msg = getattr(choices[0], "message", None)
        if not msg:
            return None
        text = getattr(msg, "reasoning_content", None)
        if text and isinstance(text, str) and text.strip():
            return text.strip()
    except (IndexError, AttributeError, TypeError):
        pass
    return None


def _extract_response_data(response: Any) -> dict[str, Any]:
    """Extract ALL fields from a litellm ModelResponse — nothing stripped.

    Captures:
    - response: full model_dump() (Pydantic public fields)
    - _hidden_params: LiteLLM-private metadata (response_cost, model_id, api_base, etc.)
      — these are NOT included in model_dump() because Pydantic excludes underscore-prefixed attrs
    - _response_headers: raw HTTP headers from the provider API
    - usage: normalized token counts with reasoning/cache breakdowns
    - cost_usd: LiteLLM-computed cost from _hidden_params.response_cost
    - response_ms: latency measured by LiteLLM
    - litellm_version: version of LiteLLM SDK that processed this request
    """
    import litellm as _litellm_mod

    data: dict[str, Any] = {}

    # Core response via model_dump() (Pydantic v2)
    if hasattr(response, "model_dump"):
        data["response"] = response.model_dump()
    elif hasattr(response, "dict"):
        data["response"] = response.dict()
    else:
        data["response"] = str(response)

    # _hidden_params: LiteLLM-private metadata NOT included in model_dump().
    # Contains response_cost, model_id, api_base, original_response, etc.
    hidden = getattr(response, "_hidden_params", {}) or {}
    if hidden:
        # Serialize HiddenParams object — it may have model_dump() or be a plain dict
        if hasattr(hidden, "model_dump"):
            data["_hidden_params"] = hidden.model_dump()
        elif hasattr(hidden, "__dict__"):
            data["_hidden_params"] = {
                k: v for k, v in hidden.__dict__.items()
                if not k.startswith("__")
            }
        elif isinstance(hidden, dict):
            data["_hidden_params"] = dict(hidden)
        else:
            data["_hidden_params"] = str(hidden)
    else:
        data["_hidden_params"] = {}

    # _response_headers: raw HTTP headers from the provider API
    resp_headers = getattr(response, "_response_headers", None)
    if resp_headers:
        if isinstance(resp_headers, dict):
            data["_response_headers"] = dict(resp_headers)
        else:
            data["_response_headers"] = {k: v for k, v in resp_headers.items()} if hasattr(resp_headers, "items") else str(resp_headers)

    # Usage extraction
    usage = getattr(response, "usage", None)
    if usage:
        data["usage"] = {
            "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
            "completion_tokens": getattr(usage, "completion_tokens", 0) or 0,
            "total_tokens": getattr(usage, "total_tokens", 0) or 0,
        }

        # Reasoning tokens (OpenAI, Anthropic thinking, Kimi)
        cd = getattr(usage, "completion_tokens_details", None)
        if cd:
            data["usage"]["reasoning_tokens"] = getattr(cd, "reasoning_tokens", 0) or 0
        else:
            data["usage"]["reasoning_tokens"] = 0

        # Older LiteLLM versions don't populate completion_tokens_details
        # for Bedrock Converse, but DO pass through reasoning_content text.
        # Use litellm.token_counter() — same function newer versions use internally.
        if data["usage"]["reasoning_tokens"] == 0:
            reasoning_text = _get_reasoning_content(response)
            if reasoning_text:
                import litellm
                model = getattr(response, "model", None) or ""
                data["usage"]["reasoning_tokens"] = litellm.token_counter(
                    model=model, text=reasoning_text
                )

        # Prompt caching (OpenAI)
        pd = getattr(usage, "prompt_tokens_details", None)
        if pd:
            data["usage"]["cached_tokens"] = getattr(pd, "cached_tokens", 0) or 0
        else:
            data["usage"]["cached_tokens"] = 0

        # Anthropic cache fields (LiteLLM pass-through)
        data["usage"]["cache_read_input_tokens"] = getattr(usage, "cache_read_input_tokens", 0) or 0
        data["usage"]["cache_creation_input_tokens"] = getattr(usage, "cache_creation_input_tokens", 0) or 0

    # Cost extraction from _hidden_params
    data["cost_usd"] = hidden.get("response_cost", None) if isinstance(hidden, dict) else getattr(hidden, "response_cost", None)
    data["response_ms"] = getattr(response, "response_ms", None) or getattr(response, "_response_ms", None)

    # LiteLLM version — definitive proof this went through LiteLLM
    try:
        from litellm._version import version as _litellm_ver
        data["litellm_version"] = _litellm_ver
    except ImportError:
        data["litellm_version"] = getattr(_litellm_mod, "__version__", "unknown")

    return data


# ---------------------------------------------------------------------------
# Request handlers
# ---------------------------------------------------------------------------

async def _handle_completion(req: dict[str, Any]) -> None:
    """Handle a 'completion' request: call litellm.acompletion() and return result."""
    import litellm

    # Silently drop unsupported params instead of throwing UnsupportedParamsError.
    # Required for cross-provider compatibility (e.g., Bedrock rejects 'thinking' param).
    litellm.drop_params = True

    # Enable verbose logging — writes detailed LiteLLM debug info to stderr.
    # This provides independent proof that LiteLLM is processing each request.
    os.environ.setdefault("LITELLM_LOG", "DEBUG")

    request_id = req.get("id", str(uuid.uuid4()))

    # Register ARN -> base_model pricing so LiteLLM populates
    # _hidden_params.response_cost automatically during the call.
    # Without this, response_cost is null for ARN-based model strings
    # because LiteLLM's internal cost calculator can't find the ARN
    # in its model_cost dict.
    if req.get("base_model") and req["model"] != req["base_model"]:
        try:
            import litellm as _litellm_for_reg
            base_info = _litellm_for_reg.model_cost.get(req["base_model"])
            if base_info:
                _litellm_for_reg.register_model({req["model"]: base_info})
        except Exception:
            pass  # registration failure must not block the call

    try:
        # Build kwargs from the request
        kwargs: dict[str, Any] = {
            "model": req["model"],
            "messages": req["messages"],
        }

        msg_count = len(req.get("messages", []))
        payload_chars = len(json.dumps(req["messages"], default=str))
        _log(f"Request {request_id}: {msg_count} messages, ~{payload_chars} chars payload")

        # Optional parameters — only include if provided
        for key in (
            "tools", "tool_choice", "max_tokens", "temperature",
            "top_p", "stop", "seed", "response_format",
            "extra_headers", "reasoning_effort", "store",
            "model_id",
        ):
            if key in req and req[key] is not None:
                kwargs[key] = req[key]

        # API key override (for providers that need explicit keys)
        if req.get("api_key"):
            kwargs["api_key"] = req["api_key"]

        # Base URL override
        if req.get("base_url"):
            kwargs["api_base"] = req["base_url"]

        # AWS region for Bedrock providers
        if req.get("aws_region_name"):
            kwargs["aws_region_name"] = req["aws_region_name"]

        # Vertex AI credentials (for Gemini via Vertex)
        if req.get("vertex_project"):
            kwargs["vertex_project"] = req["vertex_project"]
        if req.get("vertex_location"):
            kwargs["vertex_location"] = req["vertex_location"]
        if req.get("vertex_credentials"):
            kwargs["vertex_credentials"] = req["vertex_credentials"]

        # Timeout (ms -> seconds)
        timeout_ms = req.get("timeout_ms", 600_000)
        kwargs["timeout"] = timeout_ms / 1000.0

        # Extra body for thinking/reasoning config
        if req.get("extra_body"):
            # LiteLLM passes extra params through to the provider
            for k, v in req["extra_body"].items():
                kwargs[k] = v

        # Log all kwargs keys and key params for debugging
        kwargs_keys = sorted(kwargs.keys())
        _log(f"Calling litellm.acompletion: model={kwargs['model']}, aws_region={kwargs.get('aws_region_name', '(none)')}, keys={kwargs_keys}")

        import time as _time
        t0 = _time.monotonic()

        # Enforce timeout at asyncio level — LiteLLM's timeout param is unreliable
        # for Bedrock providers (see LiteLLM Issue #23375).
        acompletion_timeout = kwargs.pop("timeout", 600.0)
        try:
            response = await asyncio.wait_for(
                litellm.acompletion(**kwargs),
                timeout=acompletion_timeout,
            )
        except asyncio.TimeoutError:
            elapsed = _time.monotonic() - t0
            raise TimeoutError(
                f"litellm.acompletion timed out after {elapsed:.1f}s "
                f"(limit={acompletion_timeout}s, model={kwargs['model']})"
            )

        elapsed = _time.monotonic() - t0

        result = _extract_response_data(response)
        usage = result.get("usage", {})
        _log(f"Response {request_id}: {elapsed:.1f}s, in={usage.get('prompt_tokens', '?')}, out={usage.get('completion_tokens', '?')}")

        # Post-hoc cost fallback: when _hidden_params.response_cost is null
        # (happens for ARN-based model strings), use litellm.completion_cost()
        # with base_model to resolve pricing from a known short model name.
        if not result.get("cost_usd") and req.get("base_model"):
            try:
                cost = litellm.completion_cost(
                    completion_response=response,
                    model=req["model"],
                    base_model=req["base_model"],
                )
                result["cost_usd"] = float(cost) if cost else None
                _log(f"Post-hoc cost for {request_id}: base_model={req['base_model']}, cost={result['cost_usd']}")
            except Exception:
                pass  # cost stays None — no crash

        _send({
            "id": request_id,
            "type": "result",
            "data": result,
        })

    except Exception as exc:
        _log(f"Completion error for {request_id}: {type(exc).__name__}: {exc}")
        _send({
            "id": request_id,
            "type": "error",
            "error": _serialize_error(exc),
        })


def _extract_responses_data(response: Any) -> dict[str, Any]:
    """Extract fields from a litellm Responses API response.

    Maps Responses API field names to the same bridge protocol field names
    that _extract_response_data() produces, so the TS side can parse either
    response format identically.
    """
    import litellm as _litellm_mod

    data: dict[str, Any] = {}

    # Core response — Responses API returns a ResponsesAPIResponse object
    if hasattr(response, "model_dump"):
        data["response"] = response.model_dump()
    elif hasattr(response, "dict"):
        data["response"] = response.dict()
    else:
        data["response"] = str(response)

    # _hidden_params
    hidden = getattr(response, "_hidden_params", {}) or {}
    if hidden:
        if hasattr(hidden, "model_dump"):
            data["_hidden_params"] = hidden.model_dump()
        elif hasattr(hidden, "__dict__"):
            data["_hidden_params"] = {
                k: v for k, v in hidden.__dict__.items()
                if not k.startswith("__")
            }
        elif isinstance(hidden, dict):
            data["_hidden_params"] = dict(hidden)
        else:
            data["_hidden_params"] = str(hidden)
    else:
        data["_hidden_params"] = {}

    # _response_headers
    resp_headers = getattr(response, "_response_headers", None)
    if resp_headers:
        if isinstance(resp_headers, dict):
            data["_response_headers"] = dict(resp_headers)
        else:
            data["_response_headers"] = {k: v for k, v in resp_headers.items()} if hasattr(resp_headers, "items") else str(resp_headers)

    # Usage: Responses API uses input_tokens / output_tokens (not prompt_tokens / completion_tokens)
    usage = getattr(response, "usage", None)
    if usage:
        input_tokens = getattr(usage, "input_tokens", 0) or 0
        output_tokens = getattr(usage, "output_tokens", 0) or 0
        data["usage"] = {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        }

        # Reasoning tokens from output_tokens_details.reasoning_tokens
        otd = getattr(usage, "output_tokens_details", None)
        if otd:
            data["usage"]["reasoning_tokens"] = getattr(otd, "reasoning_tokens", 0) or 0
        else:
            data["usage"]["reasoning_tokens"] = 0

        # Input token caching from input_tokens_details.cached_tokens
        itd = getattr(usage, "input_tokens_details", None)
        if itd:
            data["usage"]["cached_tokens"] = getattr(itd, "cached_tokens", 0) or 0
        else:
            data["usage"]["cached_tokens"] = 0

        data["usage"]["cache_read_input_tokens"] = 0
        data["usage"]["cache_creation_input_tokens"] = 0

    # Cost from _hidden_params
    data["cost_usd"] = hidden.get("response_cost", None) if isinstance(hidden, dict) else getattr(hidden, "response_cost", None)
    data["response_ms"] = getattr(response, "response_ms", None) or getattr(response, "_response_ms", None)

    # LiteLLM version
    try:
        from litellm._version import version as _litellm_ver
        data["litellm_version"] = _litellm_ver
    except ImportError:
        data["litellm_version"] = getattr(_litellm_mod, "__version__", "unknown")

    return data


async def _handle_responses(req: dict[str, Any]) -> None:
    """Handle a 'responses' request: call litellm.aresponses() and return result."""
    import litellm

    litellm.drop_params = True
    os.environ.setdefault("LITELLM_LOG", "DEBUG")

    request_id = req.get("id", str(uuid.uuid4()))

    # Register ARN -> base_model pricing (see _handle_completion for rationale).
    if req.get("base_model") and req["model"] != req["base_model"]:
        try:
            base_info = litellm.model_cost.get(req["base_model"])
            if base_info:
                litellm.register_model({req["model"]: base_info})
        except Exception:
            pass

    try:
        kwargs: dict[str, Any] = {
            "model": req["model"],
            "input": req["input"],
        }

        msg_count = len(req.get("input", []))
        payload_chars = len(json.dumps(req["input"], default=str))
        _log(f"Responses request {request_id}: {msg_count} input items, ~{payload_chars} chars payload")

        # Optional parameters
        for key in (
            "tools", "tool_choice", "max_output_tokens", "temperature",
            "top_p", "stop", "store", "reasoning",
            "extra_headers",
        ):
            if key in req and req[key] is not None:
                kwargs[key] = req[key]

        # Instructions (system prompt) — separate field in Responses API
        if req.get("instructions"):
            kwargs["instructions"] = req["instructions"]

        # API key override
        if req.get("api_key"):
            kwargs["api_key"] = req["api_key"]

        # Base URL override
        if req.get("base_url"):
            kwargs["api_base"] = req["base_url"]

        # AWS region for Bedrock
        if req.get("aws_region_name"):
            kwargs["aws_region_name"] = req["aws_region_name"]

        # Vertex AI credentials
        if req.get("vertex_project"):
            kwargs["vertex_project"] = req["vertex_project"]
        if req.get("vertex_location"):
            kwargs["vertex_location"] = req["vertex_location"]
        if req.get("vertex_credentials"):
            kwargs["vertex_credentials"] = req["vertex_credentials"]

        # Timeout (ms -> seconds)
        timeout_ms = req.get("timeout_ms", 600_000)
        aresponses_timeout = timeout_ms / 1000.0

        kwargs_keys = sorted(kwargs.keys())
        _log(f"Calling litellm.aresponses: model={kwargs['model']}, keys={kwargs_keys}")

        import time as _time
        t0 = _time.monotonic()

        try:
            response = await asyncio.wait_for(
                litellm.aresponses(**kwargs),
                timeout=aresponses_timeout,
            )
        except asyncio.TimeoutError:
            elapsed = _time.monotonic() - t0
            raise TimeoutError(
                f"litellm.aresponses timed out after {elapsed:.1f}s "
                f"(limit={aresponses_timeout}s, model={kwargs['model']})"
            )

        elapsed = _time.monotonic() - t0

        result = _extract_responses_data(response)
        usage = result.get("usage", {})
        _log(f"Responses response {request_id}: {elapsed:.1f}s, in={usage.get('prompt_tokens', '?')}, out={usage.get('completion_tokens', '?')}, reasoning={usage.get('reasoning_tokens', '?')}")

        # Post-hoc cost fallback (same pattern as _handle_completion)
        if not result.get("cost_usd") and req.get("base_model"):
            try:
                cost = litellm.completion_cost(
                    completion_response=response,
                    model=req["model"],
                    base_model=req["base_model"],
                )
                result["cost_usd"] = float(cost) if cost else None
                _log(f"Post-hoc cost for {request_id}: base_model={req['base_model']}, cost={result['cost_usd']}")
            except Exception:
                pass  # cost stays None

        _send({
            "id": request_id,
            "type": "result",
            "data": result,
        })

    except Exception as exc:
        _log(f"Responses error for {request_id}: {type(exc).__name__}: {exc}")
        _send({
            "id": request_id,
            "type": "error",
            "error": _serialize_error(exc),
        })


async def _handle_model_info(req: dict[str, Any]) -> None:
    """Handle a 'model_info' request: return model capabilities and pricing."""
    import litellm

    request_id = req.get("id", str(uuid.uuid4()))

    try:
        model = req["model"]
        info = litellm.get_model_info(model)

        _send({
            "id": request_id,
            "type": "result",
            "data": {
                "model": model,
                "info": info if isinstance(info, dict) else str(info),
            },
        })

    except Exception as exc:
        _send({
            "id": request_id,
            "type": "error",
            "error": _serialize_error(exc),
        })


async def _handle_cost(req: dict[str, Any]) -> None:
    """Handle a 'cost' request: compute cost from a response object."""
    import litellm

    request_id = req.get("id", str(uuid.uuid4()))

    try:
        # Accept either a model + token counts, or a full response
        model = req.get("model", "")
        prompt_tokens = req.get("prompt_tokens", 0)
        completion_tokens = req.get("completion_tokens", 0)

        cost = litellm.completion_cost(
            model=model,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )

        _send({
            "id": request_id,
            "type": "result",
            "data": {"cost_usd": float(cost)},
        })

    except Exception as exc:
        _send({
            "id": request_id,
            "type": "error",
            "error": _serialize_error(exc),
        })


async def _handle_ping(req: dict[str, Any]) -> None:
    """Handle a 'ping' request: health check."""
    request_id = req.get("id", str(uuid.uuid4()))

    # Verify litellm is importable
    try:
        import litellm
        version = getattr(litellm, "__version__", "unknown")
    except ImportError:
        version = "NOT_INSTALLED"

    _send({
        "id": request_id,
        "type": "result",
        "data": {
            "status": "ok",
            "litellm_version": version,
            "python_version": sys.version,
        },
    })


# ---------------------------------------------------------------------------
# Dispatch table
# ---------------------------------------------------------------------------

HANDLERS = {
    "completion": _handle_completion,
    "responses": _handle_responses,
    "model_info": _handle_model_info,
    "cost": _handle_cost,
    "ping": _handle_ping,
}


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

async def _process_line(line: str) -> None:
    """Parse a single NDJSON line and dispatch to the appropriate handler."""
    stripped = line.strip()
    if not stripped:
        return

    try:
        req = json.loads(stripped)
    except json.JSONDecodeError as parse_err:
        _send({
            "id": "unknown",
            "type": "error",
            "error": {
                "error_type": "JSONDecodeError",
                "message": f"Invalid JSON: {parse_err}",
                "traceback": "",
            },
        })
        return

    cmd_type = req.get("type", "")
    handler = HANDLERS.get(cmd_type)

    if handler is None:
        _send({
            "id": req.get("id", "unknown"),
            "type": "error",
            "error": {
                "error_type": "UnknownCommand",
                "message": f"Unknown command type: {cmd_type}. Valid: {list(HANDLERS.keys())}",
                "traceback": "",
            },
        })
        return

    # Dispatch as concurrent task — this is the multiplexing magic.
    # Each request runs independently, responses are tagged by request_id.
    # CRITICAL: Save strong reference to prevent GC mid-execution.
    task = asyncio.create_task(handler(req))
    _active_tasks.add(task)
    task.add_done_callback(_active_tasks.discard)


async def main() -> None:
    """Main event loop: read NDJSON lines from stdin, dispatch concurrently."""
    global _shutdown

    # Send ready signal so the TS side knows we're alive
    _send({"type": "ready", "data": {"pid": os.getpid(), "python": sys.version}})
    _log(f"Bridge ready (pid={os.getpid()}, python={sys.version})")

    loop = asyncio.get_event_loop()

    # asyncio.StreamReader default limit is 64KB — eval payloads grow with
    # conversation history and can exceed any fixed cap. Use 2^63 (effectively
    # unlimited) so the bridge never rejects a valid request due to line length.
    reader = asyncio.StreamReader(limit=2 ** 63)
    protocol = asyncio.StreamReaderProtocol(reader)

    try:
        transport, _ = await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    except Exception as exc:
        _log(f"Failed to connect stdin pipe: {exc}")
        _send({
            "id": "init",
            "type": "error",
            "error": _serialize_error(exc),
        })
        return

    try:
        while not _shutdown:
            try:
                line_bytes = await reader.readline()
            except asyncio.CancelledError:
                _log("Main loop cancelled")
                break
            except Exception as exc:
                _log(f"readline error: {type(exc).__name__}: {exc}")
                # Don't break immediately — try to continue if possible
                await asyncio.sleep(0.1)
                continue

            if not line_bytes:
                # EOF — stdin closed, time to exit
                _log("stdin EOF received, shutting down")
                break

            line = line_bytes.decode("utf-8", errors="replace")
            await _process_line(line)

    finally:
        _shutdown = True
        transport.close()

        # Give pending tasks a brief window to complete
        pending = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        if pending:
            _log(f"Waiting for {len(pending)} pending tasks to complete...")
            # Wait up to 5 seconds for in-flight requests
            done, still_pending = await asyncio.wait(pending, timeout=5.0)
            for task in still_pending:
                task.cancel()
            if still_pending:
                _log(f"Cancelled {len(still_pending)} tasks that didn't complete in time")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        _log("Interrupted by user")
    except Exception as exc:
        # Write to stderr (sys.stderr = original stderr since we didn't touch it)
        sys.stderr.write(f"[litellm-bridge] Fatal: {exc}\n{traceback.format_exc()}\n")
        sys.stderr.flush()
        sys.exit(1)
