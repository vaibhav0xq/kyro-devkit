#!/usr/bin/env python3
"""Exit-code checks for kyro_quickstart.py. Standard library only.

    python3 -m unittest discover -s examples/python -v

No network. kyro_get is replaced with a stub, so nothing here calls the API,
spends rate units or needs credentials.
"""
import io
import contextlib
import unittest

import kyro_quickstart as q


def decision(verdict, limit=100.0):
    """A decision payload shaped like the v1 envelope's data object."""
    return {
        "wallet": "0xbb30481982786ea53fe1856e0745eec814d83252",
        "useCase": "payment",
        "decision": verdict,
        "score": 89,
        "riskLevel": "Trusted",
        "scoreModelVersion": "identity_score_v1",
        "recommendedLimit": {"amountUsdc": limit, "currency": "USDC"},
        "freshness": {"cacheStatus": "cached"},
        "reasons": [],
        "decisionModelVersion": "decision_v0.4.1",
    }


class ExitCodes(unittest.TestCase):
    def run_main(self, payload, amount="25", wallet=None, use_case="payment"):
        """Call main() with kyro_get stubbed out. Returns the exit code."""
        wallet = wallet or q.DEFAULT_WALLET
        original = q.kyro_get
        if isinstance(payload, Exception):
            q.kyro_get = lambda *a, **k: (_ for _ in ()).throw(payload)
        else:
            q.kyro_get = lambda *a, **k: payload
        try:
            with contextlib.redirect_stdout(io.StringIO()), \
                 contextlib.redirect_stderr(io.StringIO()):
                return q.main(["kyro_quickstart.py", wallet, use_case, amount])
        finally:
            q.kyro_get = original

    def test_block_exits_3(self):
        self.assertEqual(self.run_main(decision("block")), 3)

    def test_caution_exits_2(self):
        self.assertEqual(self.run_main(decision("caution")), 2)

    def test_allow_within_limit_exits_0(self):
        self.assertEqual(self.run_main(decision("allow", limit=100.0), amount="25"), 0)

    def test_allow_over_limit_exits_2(self):
        self.assertEqual(self.run_main(decision("allow", limit=10.0), amount="25"), 2)

    def test_unknown_verdict_holds_even_under_the_limit(self):
        """Regression: an unrecognised verdict must not fall through to 0."""
        for verdict in ("review", "ALLOW", "", "allow_with_conditions"):
            with self.subTest(verdict=verdict):
                code = self.run_main(decision(verdict, limit=100.0), amount="1")
                self.assertEqual(code, 2, "verdict %r should hold" % verdict)

    def test_no_answer_exits_1(self):
        err = q.KyroError("NETWORK", "connection refused")
        self.assertEqual(self.run_main(err), 1)

    def test_bad_arguments_exit_1(self):
        self.assertEqual(self.run_main(decision("allow"), wallet="not-a-wallet"), 1)
        self.assertEqual(self.run_main(decision("allow"), amount="-5"), 1)
        self.assertEqual(self.run_main(decision("allow"), amount="abc"), 1)
        self.assertEqual(self.run_main(decision("allow"), use_case="gambling"), 1)


if __name__ == "__main__":
    unittest.main()
