#!/usr/bin/env bash
#
# Manual curl tests for venice-e2ee-proxy
# Usage: ./test/curl-test.sh [proxy_url]
#
# Requires: the proxy to be running (npm start or npm run dev)
# Requires: VENICE_API_KEY to be set
#
set -euo pipefail

PROXY_URL="${1:-http://127.0.0.1:3000}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass=0
fail=0

check() {
  local name="$1"
  local expected_status="$2"
  shift 2

  echo -e "\n${YELLOW}TEST: ${name}${NC}"
  echo "  Command: curl $*"

  # Run curl, capture status code and body separately
  local tmpfile
  tmpfile=$(mktemp)
  local http_code
  http_code=$(curl -s -o "$tmpfile" -w "%{http_code}" "$@") || true
  local body
  body=$(cat "$tmpfile")
  rm -f "$tmpfile"

  if [ "$http_code" = "$expected_status" ]; then
    echo -e "  ${GREEN}PASS${NC} (HTTP ${http_code})"
    echo "  Response: ${body:0:200}"
    ((pass++))
  else
    echo -e "  ${RED}FAIL${NC} (expected HTTP ${expected_status}, got ${http_code})"
    echo "  Response: ${body:0:500}"
    ((fail++))
  fi
}

echo "======================================="
echo "Venice E2EE Proxy - curl tests"
echo "Proxy URL: ${PROXY_URL}"
echo "======================================="

# ---- Health check ----
check "Health check" "200" \
  "${PROXY_URL}/health"

# ---- Missing model ----
check "Missing model returns 400" "400" \
  -X POST "${PROXY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "hi"}]}'

# ---- Missing messages ----
check "Missing messages returns 400" "400" \
  -X POST "${PROXY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{"model": "e2ee-deepseek-v4-flash"}'

# ---- 404 ----
check "Unknown endpoint returns 404" "404" \
  "${PROXY_URL}/v1/unknown"

# ---- E2EE streaming request ----
echo -e "\n${YELLOW}TEST: E2EE streaming request${NC}"
echo "  Sending streaming request to e2ee-deepseek-v4-flash..."
tmpfile=$(mktemp)
http_code=$(curl -s -o "$tmpfile" -w "%{http_code}" \
  -X POST "${PROXY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "e2ee-deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Say hello in exactly 3 words."}],
    "stream": true
  }')
body=$(cat "$tmpfile")
rm -f "$tmpfile"

if [ "$http_code" = "200" ]; then
  if echo "$body" | grep -q "data: \[DONE\]"; then
    echo -e "  ${GREEN}PASS${NC} (HTTP ${http_code}, got SSE events with [DONE])"
    # Count content events
    content_events=$(echo "$body" | grep -c "^data: {" || true)
    echo "  Content events: ${content_events}"
    echo "  Last 3 lines:"
    echo "$body" | tail -3 | sed 's/^/    /'
    ((pass++))
  else
    echo -e "  ${RED}FAIL${NC} (HTTP ${http_code} but no [DONE] marker)"
    echo "  Response: ${body:0:500}"
    ((fail++))
  fi
else
  echo -e "  ${RED}FAIL${NC} (HTTP ${http_code})"
  echo "  Response: ${body:0:500}"
  ((fail++))
fi

# ---- E2EE non-streaming request ----
echo -e "\n${YELLOW}TEST: E2EE non-streaming request${NC}"
echo "  Sending non-streaming request to e2ee-deepseek-v4-flash..."
tmpfile=$(mktemp)
http_code=$(curl -s -o "$tmpfile" -w "%{http_code}" \
  -X POST "${PROXY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "e2ee-deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Say hello in exactly 3 words."}],
    "stream": false
  }')
body=$(cat "$tmpfile")
rm -f "$tmpfile"

if [ "$http_code" = "200" ]; then
  if echo "$body" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['choices'][0]['message']['content']" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${NC} (HTTP ${http_code}, valid completion response)"
    content=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])")
    echo "  Content: ${content}"
    ((pass++))
  else
    echo -e "  ${RED}FAIL${NC} (HTTP ${http_code} but invalid response format)"
    echo "  Response: ${body:0:500}"
    ((fail++))
  fi
else
  echo -e "  ${RED}FAIL${NC} (HTTP ${http_code})"
  echo "  Response: ${body:0:500}"
  ((fail++))
fi

# ---- Parallel E2EE requests ----
echo -e "\n${YELLOW}TEST: Parallel E2EE requests (5 concurrent)${NC}"
pids=()
tmpfiles=()
for i in $(seq 1 5); do
  tf=$(mktemp)
  tmpfiles+=("$tf")
  curl -s -o "$tf" -w "%{http_code}" \
    -X POST "${PROXY_URL}/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "{
      \"model\": \"e2ee-deepseek-v4-flash\",
      \"messages\": [{\"role\": \"user\", \"content\": \"What is ${i} + ${i}? Reply with just the number.\"}],
      \"stream\": false
    }" > "${tf}.code" 2>/dev/null &
  pids+=($!)
done

# Wait for all requests
all_ok=true
for i in "${!pids[@]}"; do
  wait "${pids[$i]}" || true
  code=$(cat "${tmpfiles[$i]}.code" 2>/dev/null || echo "000")
  # The code is appended to the response body by -w, extract last 3 chars
  body=$(cat "${tmpfiles[$i]}" 2>/dev/null || echo "")
  rm -f "${tmpfiles[$i]}" "${tmpfiles[$i]}.code"

  if [ "$code" != "200" ] && [ "${code: -3}" != "200" ]; then
    echo "  Request $((i+1)): FAILED (code: ${code})"
    all_ok=false
  else
    echo "  Request $((i+1)): OK"
  fi
done

if $all_ok; then
  echo -e "  ${GREEN}PASS${NC} (all 5 parallel requests succeeded)"
  ((pass++))
else
  echo -e "  ${RED}FAIL${NC} (some parallel requests failed)"
  ((fail++))
fi

# ---- /chat/completions endpoint (without /v1) ----
check "Endpoint without /v1 prefix" "200" \
  -X POST "${PROXY_URL}/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "e2ee-deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Say ok"}],
    "stream": false
  }'

# ---- Summary ----
echo ""
echo "======================================="
echo -e "Results: ${GREEN}${pass} passed${NC}, ${RED}${fail} failed${NC}"
echo "======================================="

if [ "$fail" -gt 0 ]; then
  exit 1
fi
