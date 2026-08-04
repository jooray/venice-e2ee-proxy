#!/usr/bin/env python3
"""Report whether Venice's attestation actually carries GPU evidence.

A GPU attestation gate can only be worth adding if there is GPU evidence to
gate on. This asks Venice directly, per model:

  - is `nvidia_payload` present at all?
  - what does `server_verification.nvidia` say (Venice's own verdict)?
  - what does the attested CVM report for `num_gpus`?

With --nras it goes one step further and submits the evidence to NVIDIA's
Remote Attestation Service, then checks the claim that actually matters:
whether `eat_nonce` in NVIDIA's signed token echoes the nonce we sent to
Venice. That binding is what separates a real verification from a replay.
--nras sends the GPU evidence to NVIDIA, so it is off by default.
"""

import argparse
import base64
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu"


def get_json(url, api_key=None, timeout=30, retries=4):
    """GET with backoff on 429/5xx.

    Venice rate-limits the attestation endpoint hard enough that a naive sweep
    reports "no GPU evidence" when it means "never got to ask".
    """
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, headers=headers)

    delay = 5
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            retriable = e.code == 429 or 500 <= e.code < 600
            if not retriable or attempt == retries - 1:
                raise
            wait = int(e.headers.get("Retry-After") or delay)
            print(f"    (HTTP {e.code}, retrying in {wait}s)", file=sys.stderr)
            time.sleep(wait)
            delay = min(delay * 2, 60)
    raise RuntimeError("unreachable")


def get_models(api_key):
    data = get_json("https://api.venice.ai/api/v1/models", api_key)
    return [m["id"] for m in data.get("data", [])]


def find_key(obj, key):
    """Depth-first search for `key` anywhere in a nested structure.

    The attestation nests differently across gateway versions, so hunting for
    the field beats hardcoding a path that quietly returns None after an
    upstream reshuffle.
    """
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            found = find_key(v, key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = find_key(v, key)
            if found is not None:
                return found
    return None


def decode_jwt_claims(token):
    """Decode a JWT payload without verifying it.

    The token arrived over TLS straight from NVIDIA, so TLS is what
    authenticates it here. Signature verification would matter for a token
    relayed or cached by someone else.
    """
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


def verify_with_nras(nvidia_payload, expected_nonce):
    """Submit GPU evidence to NVIDIA and report what comes back."""
    body = nvidia_payload if isinstance(nvidia_payload, bytes) else nvidia_payload.encode()
    req = urllib.request.Request(
        NRAS_URL,
        data=body,
        headers={"Accept": "application/json", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.read().decode()[:200]}"}
    except Exception as e:
        return {"error": str(e)[:200]}

    # Response shape: [["JWT", "<overall token>"], {"GPU-0": "<token>", ...}]
    try:
        overall = decode_jwt_claims(result[0][1])
        per_gpu = {k: decode_jwt_claims(v) for k, v in result[1].items()}
    except Exception as e:
        return {"error": f"unexpected NRAS response shape: {e}"}

    eat_nonce = overall.get("eat_nonce")
    return {
        "overall_result": overall.get("x-nvidia-overall-att-result"),
        "eat_nonce": eat_nonce,
        "nonce_matches": eat_nonce == expected_nonce,
        "gpus": {
            name: {
                "dbgstat": c.get("dbgstat"),
                "secboot": c.get("secboot"),
                "measres": c.get("measres"),
                "hwmodel": c.get("hwmodel"),
                "report_nonce_match": c.get("x-nvidia-gpu-attestation-report-nonce-match"),
            }
            for name, c in per_gpu.items()
        },
    }


def probe(model, api_key, base_url, use_nras):
    nonce = secrets.token_hex(32)
    url = f"{base_url}/api/v1/tee/attestation?model={urllib.parse.quote(model)}&nonce={nonce}"
    try:
        att = get_json(url, api_key)
    except urllib.error.HTTPError as e:
        return {"model": model, "error": f"HTTP {e.code}: {e.read().decode()[:160]}"}
    except Exception as e:
        return {"model": model, "error": str(e)[:160]}

    payload = att.get("nvidia_payload")
    sv_nvidia = (att.get("server_verification") or {}).get("nvidia")

    row = {
        "model": model,
        "verified": att.get("verified"),
        "nonce_echoed": att.get("nonce") == nonce,
        "has_intel_quote": bool(att.get("intel_quote")),
        "nvidia_payload": bool(payload),
        "nvidia_payload_bytes": len(payload) if isinstance(payload, str) else None,
        "server_nvidia": sv_nvidia,
        "num_gpus": find_key(att, "num_gpus"),
    }

    if payload and use_nras:
        row["nras"] = verify_with_nras(payload, nonce)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api-key", default=os.environ.get("VENICE_API_KEY"))
    parser.add_argument("--base-url", default=os.environ.get("VENICE_BASE_URL", "https://api.venice.ai"))
    parser.add_argument("--model", action="append", help="probe only this model (repeatable)")
    parser.add_argument("--all", action="store_true", help="probe every model, not just e2ee-* ones")
    parser.add_argument(
        "--nras",
        action="store_true",
        help="submit GPU evidence to NVIDIA's attestation service (contacts nvidia.com)",
    )
    parser.add_argument("--json", action="store_true", help="emit raw JSON instead of a table")
    args = parser.parse_args()

    if not args.api_key:
        sys.exit("VENICE_API_KEY is not set (or pass --api-key).")

    if args.model:
        models = args.model
    else:
        models = get_models(args.api_key)
        if not args.all:
            models = [m for m in models if m.startswith("e2ee-")]
        if not models:
            sys.exit("No e2ee-* models found. Use --all to probe everything.")

    rows = [probe(m, args.api_key, args.base_url, args.nras) for m in models]

    if args.json:
        print(json.dumps(rows, indent=2))
        return

    print(f"{'model':<34} {'quote':<6} {'gpu evidence':<14} {'num_gpus':<9} venice verdict")
    print("-" * 96)
    for r in rows:
        if "error" in r:
            print(f"{r['model']:<34} {r['error']}")
            continue
        sv = r["server_nvidia"]
        verdict = "absent" if sv is None else ("valid" if sv.get("valid") else f"INVALID: {sv.get('error')}")
        evidence = f"{r['nvidia_payload_bytes']} B" if r["nvidia_payload"] else "absent"
        gpus = "-" if r["num_gpus"] is None else str(r["num_gpus"])
        print(
            f"{r['model']:<34} {'yes' if r['has_intel_quote'] else 'no':<6} "
            f"{evidence:<14} {gpus:<9} {verdict}"
        )
        if not r["nonce_echoed"]:
            print(f"{'':<34} !! attestation did not echo our nonce")
        nras = r.get("nras")
        if nras:
            if "error" in nras:
                print(f"{'':<34} NRAS: {nras['error']}")
            else:
                match = "matches our nonce" if nras["nonce_matches"] else "!! NONCE MISMATCH"
                print(f"{'':<34} NRAS: overall={nras['overall_result']}, eat_nonce {match}")
                for name, g in nras["gpus"].items():
                    print(
                        f"{'':<34}   {name}: {g['hwmodel']} secboot={g['secboot']} "
                        f"dbgstat={g['dbgstat']} measres={g['measres']}"
                    )

    have_evidence = [r for r in rows if r.get("nvidia_payload")]
    failed = [r for r in rows if "error" in r]
    answered = len(rows) - len(failed)

    print()
    if failed:
        print(f"{len(failed)}/{len(rows)} model(s) could not be probed (see errors above).")
    if have_evidence:
        print(f"{len(have_evidence)}/{answered} model(s) that answered return GPU evidence.")
        if not args.nras:
            print("Re-run with --nras to check it against NVIDIA and verify the nonce binding.")
    elif answered:
        print(
            f"None of the {answered} model(s) that answered carry GPU evidence. A GPU attestation "
            "gate would have nothing to verify — see the GPU attestation section of the README."
        )
    else:
        print("No model answered, so this run says nothing either way. Retry with fewer --model args.")


if __name__ == "__main__":
    main()
