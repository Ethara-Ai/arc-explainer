"""
Comparison test: Direct Bedrock API calls vs LiteLLM calls.
Makes 1 API call per model through both paths and saves raw responses
side-by-side to prove LiteLLM is actually in the call path.

Usage: python3 scripts/test_litellm_proof.py
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

# Add project root to path so we can import litellm from external/
project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root / "external" / "litellm"))

# Load .env
from dotenv import load_dotenv
load_dotenv(project_root / ".env")

OUTPUT_DIR = Path("/tmp/litellm-proof")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

SIMPLE_PROMPT = "What is 2+2? Answer with just the number."

MODELS = {
    "claude-bedrock": {
        "litellm_model": f"bedrock/converse/{os.environ.get('BEDROCK_CLAUDE_ARN', 'anthropic.claude-opus-4-6-v1')}",
        "aws_region": os.environ.get("AWS_REGION", "ap-south-1"),
    },
    "kimi-bedrock": {
        "litellm_model": f"bedrock/converse/{os.environ.get('BEDROCK_KIMI_ARN', 'moonshotai.kimi-k2.5')}",
        "aws_region": os.environ.get("AWS_REGION", "ap-south-1"),
    },
    "gemini-3.1": {
        "litellm_model": "vertex_ai/gemini-3.1-pro-preview",
        "api_key": os.environ.get("GEMINI_API_KEY"),
        "vertex_project": os.environ.get("GCP_PROJECT"),
        "vertex_location": os.environ.get("GCP_LOCATION", "us-central1"),
        "vertex_credentials": os.environ.get("VERTEXAI_CREDENTIALS"),
    },
    "gpt-5.4": {
        "litellm_model": "openai/gpt-5.4",
        "api_key": os.environ.get("GPT_API_KEY"),
    },
}


def serialize_any(obj: Any) -> Any:
    """Recursively serialize anything to JSON-safe types."""
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, bytes):
        return obj.decode("utf-8", errors="replace")
    if isinstance(obj, dict):
        return {str(k): serialize_any(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [serialize_any(item) for item in obj]
    if hasattr(obj, "model_dump"):
        return serialize_any(obj.model_dump())
    if hasattr(obj, "__dict__"):
        return serialize_any(obj.__dict__)
    return str(obj)


async def call_litellm(model_key: str, config: dict) -> dict[str, Any]:
    """Make a single LiteLLM call and capture EVERYTHING."""
    import litellm
    os.environ.setdefault("LITELLM_LOG", "DEBUG")
    litellm.drop_params = True

    kwargs: dict[str, Any] = {
        "model": config["litellm_model"],
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": SIMPLE_PROMPT},
        ],
        "max_tokens": 100,
    }

    if config.get("aws_region"):
        kwargs["aws_region_name"] = config["aws_region"]
    if config.get("api_key"):
        kwargs["api_key"] = config["api_key"]
    if config.get("vertex_project"):
        kwargs["vertex_project"] = config["vertex_project"]
    if config.get("vertex_location"):
        kwargs["vertex_location"] = config["vertex_location"]
    if config.get("vertex_credentials"):
        kwargs["vertex_credentials"] = config["vertex_credentials"]

    print(f"\n{'='*60}")
    print(f"[LiteLLM] Calling {model_key}: {config['litellm_model']}")
    print(f"{'='*60}")

    t0 = time.monotonic()
    response = await litellm.acompletion(**kwargs)
    elapsed = time.monotonic() - t0

    # Capture EVERYTHING from the response object
    result: dict[str, Any] = {
        "_source": "litellm",
        "_model_key": model_key,
        "_elapsed_seconds": round(elapsed, 2),
    }
    try:
        from litellm._version import version as _lv
        result["_litellm_version"] = _lv
    except ImportError:
        result["_litellm_version"] = getattr(litellm, "__version__", "unknown")

    # 1. model_dump() — the public Pydantic fields
    if hasattr(response, "model_dump"):
        result["model_dump"] = serialize_any(response.model_dump())
    elif hasattr(response, "dict"):
        result["model_dump"] = serialize_any(response.dict())

    # 2. _hidden_params — LiteLLM private metadata (NOT in model_dump)
    hidden = getattr(response, "_hidden_params", None)
    if hidden is not None:
        if hasattr(hidden, "model_dump"):
            result["_hidden_params"] = serialize_any(hidden.model_dump())
        elif hasattr(hidden, "__dict__"):
            result["_hidden_params"] = serialize_any({
                k: v for k, v in hidden.__dict__.items()
                if not k.startswith("__")
            })
        elif isinstance(hidden, dict):
            result["_hidden_params"] = serialize_any(hidden)
        else:
            result["_hidden_params"] = str(hidden)
    else:
        result["_hidden_params"] = None

    # 3. _response_headers — raw HTTP headers
    resp_headers = getattr(response, "_response_headers", None)
    if resp_headers is not None:
        if isinstance(resp_headers, dict):
            result["_response_headers"] = dict(resp_headers)
        elif hasattr(resp_headers, "items"):
            result["_response_headers"] = {k: v for k, v in resp_headers.items()}
        else:
            result["_response_headers"] = str(resp_headers)
    else:
        result["_response_headers"] = None

    # 4. response_ms
    result["response_ms"] = getattr(response, "response_ms", None) or getattr(response, "_response_ms", None)

    # 5. All other private attrs we can find
    for attr_name in dir(response):
        if attr_name.startswith("_") and not attr_name.startswith("__"):
            if attr_name not in ("_hidden_params", "_response_headers", "_response_ms"):
                val = getattr(response, attr_name, None)
                if val is not None and not callable(val):
                    result[f"private_{attr_name}"] = serialize_any(val)

    return result


async def call_direct_bedrock(model_key: str, config: dict) -> dict[str, Any]:
    """Make a direct Bedrock Converse API call via boto3 — NO LiteLLM."""
    import boto3

    if "aws_region" not in config:
        return {"_source": "direct_bedrock", "_model_key": model_key, "_skipped": True, "_reason": "Not a Bedrock model"}

    arn = config["litellm_model"].replace("bedrock/converse/", "")
    region = config["aws_region"]

    # Parse the Bedrock API key (base64-encoded accessKeyId:secretKey)
    bedrock_key = os.environ.get("BEDROCK_API_KEY", "")
    if bedrock_key.startswith("ABSK"):
        import base64
        decoded = base64.b64decode(bedrock_key[4:]).decode("utf-8")
        parts = decoded.split(":")
        # Format: BedrockAPIKey-<id>-at-<account>:<secret>
        access_key_id = parts[0] if len(parts) >= 2 else ""
        secret_key = parts[1] if len(parts) >= 2 else ""
    else:
        access_key_id = os.environ.get("AWS_ACCESS_KEY_ID", "")
        secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY", "")

    print(f"\n{'='*60}")
    print(f"[Direct Bedrock] Calling {model_key}: {arn}")
    print(f"  Region: {region}")
    print(f"{'='*60}")

    client = boto3.client(
        "bedrock-runtime",
        region_name=region,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_key,
    )

    t0 = time.monotonic()
    try:
        response = client.converse(
            modelId=arn,
            messages=[
                {
                    "role": "user",
                    "content": [{"text": SIMPLE_PROMPT}],
                }
            ],
            system=[{"text": "You are a helpful assistant."}],
            inferenceConfig={"maxTokens": 100},
        )
        elapsed = time.monotonic() - t0

        result = {
            "_source": "direct_bedrock",
            "_model_key": model_key,
            "_elapsed_seconds": round(elapsed, 2),
            "_litellm_version": None,  # NOT using LiteLLM
            "_hidden_params": None,    # Direct API has no _hidden_params
        }

        # The raw boto3 response includes ResponseMetadata
        result["response"] = serialize_any(response)

        return result

    except Exception as exc:
        elapsed = time.monotonic() - t0
        return {
            "_source": "direct_bedrock",
            "_model_key": model_key,
            "_elapsed_seconds": round(elapsed, 2),
            "_error": f"{type(exc).__name__}: {exc}",
        }


async def call_direct_openai(model_key: str, config: dict) -> dict[str, Any]:
    """Make a direct OpenAI API call — NO LiteLLM."""
    if not config.get("api_key"):
        return {"_source": "direct_openai", "_model_key": model_key, "_skipped": True, "_reason": "No API key"}

    from openai import AsyncOpenAI

    model_name = config["litellm_model"].replace("openai/", "")

    print(f"\n{'='*60}")
    print(f"[Direct OpenAI] Calling {model_key}: {model_name}")
    print(f"{'='*60}")

    client = AsyncOpenAI(api_key=config["api_key"])

    t0 = time.monotonic()
    try:
        response = await client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": SIMPLE_PROMPT},
            ],
            max_completion_tokens=100,
        )
        elapsed = time.monotonic() - t0

        result = {
            "_source": "direct_openai",
            "_model_key": model_key,
            "_elapsed_seconds": round(elapsed, 2),
            "_litellm_version": None,
            "_hidden_params": None,
        }

        if hasattr(response, "model_dump"):
            result["response"] = serialize_any(response.model_dump())
        else:
            result["response"] = serialize_any(response)

        return result

    except Exception as exc:
        elapsed = time.monotonic() - t0
        return {
            "_source": "direct_openai",
            "_model_key": model_key,
            "_elapsed_seconds": round(elapsed, 2),
            "_error": f"{type(exc).__name__}: {exc}",
        }


def write_result(filename: str, data: dict) -> None:
    """Write a result to a JSON file."""
    filepath = OUTPUT_DIR / filename
    with open(filepath, "w") as f:
        json.dump(data, f, indent=2, default=str)
    print(f"  -> Saved: {filepath}")


def print_comparison(litellm_result: dict, direct_result: dict, model_key: str) -> None:
    """Print a side-by-side comparison highlighting LiteLLM-specific fields."""
    print(f"\n{'#'*70}")
    print(f"# COMPARISON: {model_key}")
    print(f"{'#'*70}")

    # 1. Check for _hidden_params
    litellm_hidden = litellm_result.get("_hidden_params")
    direct_hidden = direct_result.get("_hidden_params")
    print(f"\n  _hidden_params present?")
    print(f"    LiteLLM: {'YES' if litellm_hidden else 'NO'} — {type(litellm_hidden).__name__}")
    print(f"    Direct:  {'YES' if direct_hidden else 'NO'} — {type(direct_hidden).__name__}")
    if litellm_hidden and isinstance(litellm_hidden, dict):
        print(f"    LiteLLM _hidden_params keys: {list(litellm_hidden.keys())}")
        cost = litellm_hidden.get("response_cost")
        api_base = litellm_hidden.get("api_base")
        model_id = litellm_hidden.get("model_id")
        print(f"      response_cost: {cost}")
        print(f"      api_base: {api_base}")
        print(f"      model_id: {model_id}")

    # 2. Check for litellm_version
    print(f"\n  litellm_version:")
    print(f"    LiteLLM: {litellm_result.get('_litellm_version', 'N/A')}")
    print(f"    Direct:  {direct_result.get('_litellm_version', 'N/A')}")

    # 3. Check for _response_headers
    litellm_headers = litellm_result.get("_response_headers")
    direct_headers = direct_result.get("_response_headers")
    print(f"\n  _response_headers present?")
    print(f"    LiteLLM: {'YES' if litellm_headers else 'NO'}")
    print(f"    Direct:  {'YES' if direct_headers else 'NO'}")

    # 4. Response ID format comparison
    litellm_id = litellm_result.get("model_dump", {}).get("id", "N/A") if isinstance(litellm_result.get("model_dump"), dict) else "N/A"
    direct_resp = direct_result.get("response", {})
    direct_id = direct_resp.get("id", direct_resp.get("ResponseMetadata", {}).get("RequestId", "N/A")) if isinstance(direct_resp, dict) else "N/A"
    print(f"\n  Response ID format:")
    print(f"    LiteLLM: {litellm_id}")
    print(f"    Direct:  {direct_id}")

    # 5. Response structure keys
    litellm_md = litellm_result.get("model_dump", {})
    print(f"\n  LiteLLM model_dump top-level keys: {list(litellm_md.keys()) if isinstance(litellm_md, dict) else 'N/A'}")
    print(f"  Direct response top-level keys: {list(direct_resp.keys()) if isinstance(direct_resp, dict) else 'N/A'}")

    # 6. response_ms
    print(f"\n  response_ms:")
    print(f"    LiteLLM: {litellm_result.get('response_ms', 'N/A')}")
    print(f"    Direct:  N/A (not tracked by native SDK)")

    if direct_result.get("_skipped"):
        print(f"\n  [SKIPPED DIRECT CALL: {direct_result.get('_reason')}]")

    print()


async def main() -> None:
    print("=" * 70)
    print("LiteLLM PROOF-OF-INTEGRATION TEST")
    print(f"Output dir: {OUTPUT_DIR}")
    print("=" * 70)

    for model_key, config in MODELS.items():
        # LiteLLM call
        try:
            litellm_result = await call_litellm(model_key, config)
            write_result(f"litellm_{model_key}.json", litellm_result)
        except Exception as exc:
            print(f"  [ERROR] LiteLLM {model_key}: {exc}")
            litellm_result = {"_source": "litellm", "_model_key": model_key, "_error": str(exc)}
            write_result(f"litellm_{model_key}.json", litellm_result)

        # Direct call (Bedrock or OpenAI)
        try:
            if "aws_region" in config:
                direct_result = await call_direct_bedrock(model_key, config)
            elif "openai" in config.get("litellm_model", ""):
                direct_result = await call_direct_openai(model_key, config)
            else:
                direct_result = {
                    "_source": "direct",
                    "_model_key": model_key,
                    "_skipped": True,
                    "_reason": f"No direct client for {config.get('litellm_model', 'unknown')}",
                }
            write_result(f"direct_{model_key}.json", direct_result)
        except Exception as exc:
            print(f"  [ERROR] Direct {model_key}: {exc}")
            direct_result = {"_source": "direct", "_model_key": model_key, "_error": str(exc)}
            write_result(f"direct_{model_key}.json", direct_result)

        # Print comparison
        print_comparison(litellm_result, direct_result, model_key)

    # Summary
    print("\n" + "=" * 70)
    print("PROOF SUMMARY")
    print("=" * 70)
    print(f"\nAll results saved to: {OUTPUT_DIR}")
    print(f"Files:")
    for f in sorted(OUTPUT_DIR.glob("*.json")):
        size = f.stat().st_size
        print(f"  {f.name} ({size:,} bytes)")


if __name__ == "__main__":
    asyncio.run(main())
