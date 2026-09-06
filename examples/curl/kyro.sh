#!/usr/bin/env bash
# Kyro API from the shell. Needs curl; uses jq for pretty printing when present.
#
#   ./kyro.sh score    <wallet>
#   ./kyro.sh decision <wallet> [useCase]          payment (default) | escrow | lending | marketplace
#   ./kyro.sh batch    <useCase> <wallet|username>...   up to 10 unique rows anonymously
#   ./kyro.sh trust    <wallet>
#   ./kyro.sh graph    <wallet>
#   ./kyro.sh profile  <username>
#   ./kyro.sh receipt  <wallet> [useCase]          mints an immutable receipt (POST)
#   ./kyro.sh receipt-get <rcp_id>
#   ./kyro.sh intake   <wallet>                    starts indexing an unknown wallet (POST, 8 units)
#   ./kyro.sh refresh  <wallet>                    keyed only: re-index the interaction graph (POST)
#
# Environment:
#   KYRO_BASE_URL   defaults to https://www.thekyro.co
#   KYRO_API_KEY    optional kyro_live_... key; raises the rate budget. Never put it in a browser.
#   KYRO_RAW=1      print the raw JSON envelope instead of pretty printing
#
# Anonymous budget: 20 rate units per minute per IP. Reads cost 1 unit (a score
# read that starts a rescan of a stale known wallet costs 5 more), a batch of N
# unique rows costs N, an intake start costs 8. Responses carry
# X-RateLimit-Limit and X-RateLimit-Remaining; a 429 adds Retry-After.
set -euo pipefail

BASE="${KYRO_BASE_URL:-https://www.thekyro.co}/api/v1"

usage() {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-64}"
}

die() {
  echo "kyro.sh: $*" >&2
  exit 2
}

require_wallet() {
  [[ "${1:-}" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "expected a 0x-prefixed 40-hex wallet address, got '${1:-}'"
}

require_use_case() {
  case "${1:-payment}" in
    payment|escrow|lending|marketplace) ;;
    *) die "unknown useCase '$1'. Valid values: payment, escrow, lending, marketplace" ;;
  esac
}

# call <method> <path-with-query> [json-body]
call() {
  local method="$1" path="$2" body="${3:-}"
  local -a args=(-sS --max-time 30 -X "$method" -H 'accept: application/json')
  if [[ -n "${KYRO_API_KEY:-}" ]]; then
    [[ "$BASE" == https://* || "$BASE" == http://localhost* || "$BASE" == http://127.0.0.1* ]] \
      || die "refusing to send an API key over plain http"
    args+=(-H "authorization: Bearer ${KYRO_API_KEY}")
  fi
  if [[ -n "$body" ]]; then
    args+=(-H 'content-type: application/json' --data "$body")
  fi

  local headers
  headers="$(mktemp)"
  trap 'rm -f "$headers"' RETURN

  local response
  response="$(curl "${args[@]}" -D "$headers" "${BASE}${path}")"

  local status remaining limit retry
  status="$(awk 'toupper($1) ~ /^HTTP\// {code=$2} END {print code}' "$headers")"
  limit="$(awk 'tolower($1)=="x-ratelimit-limit:" {gsub("\r","",$2); print $2}' "$headers")"
  remaining="$(awk 'tolower($1)=="x-ratelimit-remaining:" {gsub("\r","",$2); print $2}' "$headers")"
  retry="$(awk 'tolower($1)=="retry-after:" {gsub("\r","",$2); print $2}' "$headers")"

  {
    printf 'HTTP %s' "$status"
    [[ -n "$limit" ]] && printf '  rate %s/%s units left this minute' "${remaining:-?}" "$limit"
    [[ -n "$retry" ]] && printf '  retry after %ss' "$retry"
    printf '\n'
  } >&2

  if [[ "${KYRO_RAW:-0}" == "1" ]] || ! command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$response"
  else
    printf '%s\n' "$response" | jq .
  fi

  [[ "$status" == 2* ]]
}

json_array() {
  local out="[" first=1
  for item in "$@"; do
    item="${item//\\/\\\\}"
    item="${item//\"/\\\"}"
    if [[ $first == 1 ]]; then first=0; else out+=","; fi
    out+="\"$item\""
  done
  printf '%s]' "$out"
}

cmd="${1:-}"
[[ -n "$cmd" ]] || usage
shift

case "$cmd" in
  score)
    require_wallet "${1:-}"
    call GET "/score/$1"
    ;;
  decision)
    require_wallet "${1:-}"
    require_use_case "${2:-payment}"
    call GET "/decision/$1?useCase=${2:-payment}"
    ;;
  batch)
    require_use_case "${1:-}"
    use_case="$1"; shift
    [[ $# -ge 1 ]] || die "batch needs at least one wallet or username"
    call POST "/decision/batch" "{\"inputs\":$(json_array "$@"),\"useCase\":\"$use_case\"}"
    ;;
  trust)
    require_wallet "${1:-}"
    call GET "/trust/$1"
    ;;
  graph)
    require_wallet "${1:-}"
    call GET "/interaction-graph/$1"
    ;;
  profile)
    [[ -n "${1:-}" ]] || die "profile needs a Kyro username, e.g. vaibhav_meta.kyro"
    call GET "/profile/$1"
    ;;
  receipt)
    require_wallet "${1:-}"
    require_use_case "${2:-payment}"
    call POST "/decision-receipts" "{\"wallet\":\"$1\",\"useCase\":\"${2:-payment}\"}"
    ;;
  receipt-get)
    [[ "${1:-}" =~ ^rcp_[A-Za-z0-9_-]{16}$ ]] || die "expected a receipt id like rcp_Zt3kQ9wXb2LmNpQr"
    call GET "/decision-receipts/$1"
    ;;
  intake)
    require_wallet "${1:-}"
    call POST "/intake/$1"
    ;;
  refresh)
    require_wallet "${1:-}"
    [[ -n "${KYRO_API_KEY:-}" ]] || die "refresh requires KYRO_API_KEY; every other command works anonymously"
    call POST "/interaction-graph/$1/refresh"
    ;;
  -h|--help|help)
    usage 0
    ;;
  *)
    die "unknown command '$cmd' (run with --help)"
    ;;
esac
