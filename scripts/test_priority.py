"""
Test script for verifying Gemini Priority PayGo setup.
Usage:
  # Test Developer API (standard, no priority):
  GEMINI_API_KEY=your_key python3 test_priority.py --mode developer

  # Test Vertex AI (priority):
  GOOGLE_CLOUD_PROJECT=your_project python3 test_priority.py --mode vertex

  # Test both:
  GEMINI_API_KEY=your_key GOOGLE_CLOUD_PROJECT=your_project python3 test_priority.py --mode both
"""
import argparse
import os
from google import genai
from google.genai import types

PRIORITY_HEADERS = {
    "X-Vertex-AI-LLM-Request-Type": "shared",
    "X-Vertex-AI-LLM-Shared-Request-Type": "priority",
}

MODEL = "gemini-3.1-pro-preview"

PROMPT = [types.Content(
    role="user",
    parts=[types.Part.from_text(text="Say hello in one word.")],
)]

CONFIG = types.GenerateContentConfig(temperature=0.0, max_output_tokens=50)


def test_developer_api():
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        print("[developer] SKIP: GEMINI_API_KEY not set")
        return

    print(f"[developer] Testing with key {'*' * 8}{api_key[-4:]}...")
    client = genai.Client(
        api_key=api_key,
        http_options={"timeout": 30_000, "headers": PRIORITY_HEADERS},
    )
    response = client.models.generate_content(model=MODEL, contents=PROMPT, config=CONFIG)
    _print_result("developer", response)


def test_vertex_api():
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        print("[vertex] SKIP: GEMINI_API_KEY not set")
        return

    print(f"[vertex] Testing with key {'*' * 8}{api_key[-4:]}... against aiplatform.googleapis.com")

    client = genai.Client(
        api_key=api_key,
        http_options={
            "timeout": 30_000,
            "headers": PRIORITY_HEADERS,
            "base_url": "https://aiplatform.googleapis.com/",
        },
    )
    # Patch api_version so path resolves to: v1/publishers/google/models/{model}:generateContent
    if not (
        hasattr(client, "_api_client")
        and hasattr(client._api_client, "_http_options")
        and hasattr(client._api_client._http_options, "api_version")
    ):
        raise RuntimeError(
            "google-genai SDK internal structure changed: "
            "_api_client._http_options.api_version not found. "
            "Update the priority patch or pin google-genai to a known-good version."
        )
    client._api_client._http_options.api_version = "v1/publishers/google"

    response = client.models.generate_content(model=MODEL, contents=PROMPT, config=CONFIG)
    _print_result("vertex", response)


def _print_result(mode: str, response):
    print(f"[{mode}] text: {response.text!r}")
    if response.usage_metadata:
        tt = response.usage_metadata.traffic_type
        print(f"[{mode}] traffic_type: {tt}")
        if str(tt) == "TrafficType.ON_DEMAND_PRIORITY":
            print(f"[{mode}] SUCCESS: Priority PayGo is active!")
        elif tt is None:
            print(f"[{mode}] traffic_type=None — priority headers ignored (non-Vertex endpoint)")
        else:
            print(f"[{mode}] traffic_type={tt} — not priority (downgraded or standard)")
    else:
        print(f"[{mode}] No usage_metadata returned")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["developer", "vertex", "both"], default="both")
    args = parser.parse_args()

    if args.mode in ("developer", "both"):
        try:
            test_developer_api()
        except Exception as e:
            print(f"[developer] ERROR: {type(e).__name__}: {e}")

    if args.mode in ("vertex", "both"):
        try:
            test_vertex_api()
        except Exception as e:
            print(f"[vertex] ERROR: {type(e).__name__}: {e}")
