#!/usr/bin/env python3
"""Reproduce, from the TDX quote alone, what Venice's enclave is running.

Every value printed here is recomputed from the quote binary rather than read
out of the fields Venice reports about itself. Where a claim can be checked, it
is checked, and the result says so; where it cannot, the script says that too
rather than leaving a gap that looks like a pass.

  ./scripts/audit-attestation.py
  ./scripts/audit-attestation.py --model e2ee-glm-5-2-p --show-compose
"""

import argparse
import hashlib
import json
import os
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

# TDX quote layout: 48-byte header, then the body. Offsets are into the body.
BODY = 48
FIELDS = {
    "mrtd": 136,
    "mrconfigid": 184,
    "mrowner": 232,
    "mrownerconfig": 280,
    "rtmr0": 328,
    "rtmr1": 376,
    "rtmr2": 424,
    "rtmr3": 472,
}
REPORT_DATA = 520
OK, BAD, INFO = "PASS", "FAIL", "  --"


def fetch(model, api_key, base_url):
    nonce = secrets.token_hex(32)
    url = (
        f"{base_url}/api/v1/tee/attestation"
        f"?model={urllib.parse.quote(model)}&nonce={nonce}"
    )
    req = urllib.request.Request(
        url, headers={"Accept": "application/json", "Authorization": f"Bearer {api_key}"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read()), nonce


def measurement(quote, name):
    start = BODY + FIELDS[name]
    return quote[start : start + 48].hex()


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--model", default="e2ee-glm-5-2-p")
    parser.add_argument("--api-key", default=os.environ.get("VENICE_API_KEY"))
    parser.add_argument("--base-url", default=os.environ.get("VENICE_BASE_URL", "https://api.venice.ai"))
    parser.add_argument("--show-compose", action="store_true", help="print the measured compose file")
    args = parser.parse_args()

    if not args.api_key:
        sys.exit("VENICE_API_KEY is not set (or pass --api-key).")

    try:
        att, nonce = fetch(args.model, args.api_key, args.base_url)
    except urllib.error.HTTPError as e:
        sys.exit(f"Attestation fetch failed: HTTP {e.code}: {e.read().decode()[:200]}")

    evidence = att.get("attestation", {}).get("evidence")
    if not evidence or "quote" not in evidence:
        sys.exit(
            f"{args.model} returned no ACI evidence block — this is a pre-ACI gateway, "
            "and nothing below can be reproduced for it."
        )

    quote = bytes.fromhex(evidence["quote"])
    compose = evidence["app_compose"]
    vm = json.loads(evidence["vm_config"])
    log = json.loads(evidence["event_log"])

    print(f"model         {args.model}")
    print(f"tee           {att.get('tee_hardware')} via {att.get('tee_provider')}")
    print(f"workload      {att.get('workload_id')}")
    print()

    # ── Freshness and key binding, straight out of REPORTDATA ──────────
    print("BINDING (recomputed from the quote's REPORTDATA)")
    rd = quote[BODY + REPORT_DATA : BODY + REPORT_DATA + 64].hex()
    addr, embedded_nonce = rd[:40], rd[64:]
    signing = (att.get("signing_address") or "")[2:].lower()
    print(f"  {OK if embedded_nonce == nonce else BAD}  our nonce is inside the quote")
    print(f"  {OK if addr == signing else BAD}  quote binds the signing key {att.get('signing_address')}")

    debug = bool(quote[BODY + 120] & 0x01)
    print(f"  {BAD if debug else OK}  TEE is {'in DEBUG MODE' if debug else 'not in debug mode'}")
    print()

    # ── What the enclave is configured to run ──────────────────────────
    print("WHAT IS RUNNING (recomputed, not taken from Venice's own report)")
    compose_sha = hashlib.sha256(compose.encode()).hexdigest()
    mrconfigid = measurement(quote, "mrconfigid")
    expected = "01" + compose_sha + "0" * 30
    print(f"  {OK if mrconfigid == expected else BAD}  MRCONFIGID reproduces from the compose manifest")
    print(f"        sha256(app_compose) = {compose_sha}")
    print(f"        MRCONFIGID          = {mrconfigid}")

    events = {e["event"]: e.get("event_payload") for e in log if isinstance(e, dict)}
    ok_compose = events.get("compose-hash", "").lower() == compose_sha.lower()
    ok_image = events.get("os-image-hash", "").lower() == vm["os_image_hash"].lower()
    print(f"  {OK if ok_compose else BAD}  event log's compose-hash matches that manifest")
    print(f"  {OK if ok_image else BAD}  event log's os-image-hash matches vm_config")
    print(f"  {INFO}  MRTD (firmware + kernel) = {measurement(quote, 'mrtd')[:32]}…")
    print(f"  {INFO}  RTMR3 is extended by {sum(1 for e in log if e.get('imr') == 3)} measured boot events")
    print()

    print("VM AS ATTESTED")
    print(f"  os image     {vm['image']}  ({vm['os_image_hash'][:16]}…)")
    print(f"  cpus         {vm['cpu_count']}")
    print(f"  gpus         {vm['num_gpus']}"
          + ("   <-- the attested VM has no GPU; inference runs elsewhere" if vm["num_gpus"] == 0 else ""))
    print()

    # ── Container images named by the measured manifest ────────────────
    print("IMAGES NAMED BY THE MEASURED MANIFEST")
    images = re.findall(r"image:\s*(\S+)", json.loads(compose)["docker_compose_file"])
    unpinned = []
    for image in images:
        if "@sha256:" in image:
            name, digest = image.split("@sha256:")
            print(f"  {OK}  {name}")
            print(f"        pinned @ sha256:{digest[:24]}…")
        else:
            unpinned.append(image)
            print(f"  {BAD}  {image}")
            print(f"        NOT pinned — this tag can point at different content later")
    print()

    prov = att.get("attestation", {}).get("source_provenance") or {}
    if prov:
        print("BUILT AT BOOT, NOT SHIPPED AS AN IMAGE")
        print(f"  repo         {prov.get('repo_url')}")
        print(f"  commit       {prov.get('repo_commit')}")
        print(f"  image digest {prov.get('image_digest') or 'null — the built artifact is not measured'}")
        print()

    print("WHAT THIS DOES NOT ESTABLISH")
    print("  - that the source built at boot matches the commit named above:")
    print("    the build is not reproducible and its output is not measured")
    if unpinned:
        print(f"  - what {', '.join(unpinned)} actually contained at boot")
    print("  - anything about the GPU host, which is a separate machine")
    print("    (see the GPU attestation section of the README)")

    if args.show_compose:
        print("\n" + "=" * 70)
        print(json.loads(compose)["docker_compose_file"])


if __name__ == "__main__":
    main()
