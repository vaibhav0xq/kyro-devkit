#!/usr/bin/env python3
"""Kyro quickstart in Python, standard library only (3.8+).

Reads a pre-transaction decision for one wallet and one use case, prints the
verdict, then exits with a code a shell pipeline can branch on:

    0  proceed   verdict allow and the amount is within the advisory limit
    2  hold      verdict caution or the amount exceeds the advisory limit
    3  block     verdict block
    1  failure   the request did not produce a Kyro answer

    python3 kyro_quickstart.py 0xbb30481982786ea53fe1856e0745eec814d83252 payment 25

No credentials are needed. The anonymous tier allows 20 rate units per minute
per IP and this script spends one. Set KYRO_API_KEY to raise the budget
(server-side only) and KYRO_BASE_URL to target another origin.

Kyro verdicts are advisory. Kyro never holds or moves funds; the caller
decides what to do with the answer.
"""
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = os.environ.get("KYRO_BASE_URL", "https://www.thekyro.co").rstrip("/")
API_KEY = os.environ.get("KYRO_API_KEY")
USE_CASES = ("payment", "escrow", "lending", "marketplace")
WALLET_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
DEFAULT_WALLET = "0xbb30481982786ea53fe1856e0745eec814d83252"


class KyroError(Exception):
    """The API answered with an error envelope or no valid envelope arrived."""

    def __init__(self, code, message, status=None, retry_after=None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.retry_after = retry_after


def kyro_get(path, params=None):
    """GET a v1 path and return the data payload, raising KyroError on any failure."""
    url = BASE_URL + "/api/v1" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"accept": "application/json"}
    if API_KEY:
        if not url.startswith("https://") and not url.startswith("http://localhost"):
            raise KyroError("INSECURE_TRANSPORT", "refusing to send an API key over plain http")
        headers["authorization"] = "Bearer " + API_KEY
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status = response.status
            raw = response.read()
            rate = (response.headers.get("x-ratelimit-remaining"), response.headers.get("x-ratelimit-limit"))
    except urllib.error.HTTPError as error:
        status = error.code
        raw = error.read()
        rate = (error.headers.get("x-ratelimit-remaining"), error.headers.get("x-ratelimit-limit"))
        retry_after = error.headers.get("retry-after")
        envelope = _parse_envelope(raw, status)
        err = envelope.get("error") or {}
        raise KyroError(
            err.get("code", "HTTP_%d" % status),
            err.get("message", "HTTP %d" % status),
            status=status,
            retry_after=int(retry_after) if retry_after and retry_after.isdigit() else None,
        )
    except urllib.error.URLError as error:
        raise KyroError("NETWORK", str(error.reason))

    if rate[0] is not None:
        print("rate budget: %s/%s units left this minute" % rate, file=sys.stderr)
    envelope = _parse_envelope(raw, status)
    if envelope.get("ok") is not True or "data" not in envelope:
        err = envelope.get("error") or {}
        raise KyroError(err.get("code", "BAD_RESPONSE"), err.get("message", "unexpected envelope"), status=status)
    return envelope["data"]


def _parse_envelope(raw, status):
    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise KyroError("BAD_RESPONSE", "HTTP %d did not carry a JSON envelope" % status, status=status)
    if not isinstance(envelope, dict):
        raise KyroError("BAD_RESPONSE", "HTTP %d carried a non-object body" % status, status=status)
    return envelope


def main(argv):
    wallet = argv[1] if len(argv) > 1 else DEFAULT_WALLET
    use_case = argv[2] if len(argv) > 2 else "payment"
    raw_amount = argv[3] if len(argv) > 3 else "25"

    try:
        amount = float(raw_amount)
    except ValueError:
        amount = math.nan
    if not math.isfinite(amount) or amount < 0:
        print("amount must be a non-negative number of USDC, got %r" % raw_amount, file=sys.stderr)
        return 1
    if not WALLET_RE.match(wallet):
        print("expected a 0x-prefixed 40-hex wallet address, got %r" % wallet, file=sys.stderr)
        return 1
    if use_case not in USE_CASES:
        print("unknown use case %r. Valid values: %s" % (use_case, ", ".join(USE_CASES)), file=sys.stderr)
        return 1

    try:
        decision = kyro_get("/decision/" + wallet, {"useCase": use_case})
    except KyroError as error:
        suffix = " (retry in %ss)" % error.retry_after if error.retry_after else ""
        print("Kyro request failed: %s %s%s" % (error.code, error, suffix), file=sys.stderr)
        return 1

    limit = decision["recommendedLimit"]
    print("wallet      %s%s" % (decision["wallet"], " (%s)" % decision["username"] if decision.get("username") else ""))
    print("use case    %s" % decision["useCase"])
    print("verdict     %s" % decision["decision"])
    print("score       %s (%s, %s)" % (decision["score"], decision["riskLevel"], decision["scoreModelVersion"]))
    print("limit       %s %s advisory" % (limit["amountUsdc"], limit["currency"]))
    print("freshness   %s" % decision["freshness"]["cacheStatus"])
    print("reasons     %s" % (", ".join(reason["code"] for reason in decision["reasons"]) or "none"))
    print("model       %s" % decision["decisionModelVersion"])

    verdict = decision["decision"]
    if verdict == "block":
        print("\nHOLD: block verdict for %g USDC." % amount)
        return 3
    if verdict == "caution":
        print("\nHOLD: caution verdict, route %g USDC to manual review." % amount)
        return 2
    if amount > limit["amountUsdc"]:
        print("\nHOLD: %g USDC exceeds the advisory limit of %s USDC." % (amount, limit["amountUsdc"]))
        return 2
    print("\nPROCEED: %g USDC is within the advisory limit." % amount)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
