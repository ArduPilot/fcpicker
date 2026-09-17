"""Tests for the maintenance tooling itself.

link_check.py and drift_report.py are the scripts that decide whether anyone
gets told about a broken link or a silently changed catalog. A bug in either is
invisible by construction — the failure mode is a report that says nothing is
wrong. Both had a false-positive problem during development (an unhelpful
"URLError" for two different real causes; GitHub rate limits read as 404s), so
their pure logic is worth pinning.

Nothing here touches the network: only the URL collection, the error
classification and the diff shaping are exercised.
"""
from __future__ import annotations

import json

import pytest

import drift_report
import link_check


class TestLinkCollection:
    def test_collects_every_url_field(self, tmp_path, monkeypatch):
        """A new URL-bearing field must not silently escape checking."""
        boards = tmp_path / "boards"
        boards.mkdir()
        (boards / "X.json").write_text(json.dumps({
            "slug": "X",
            "docs_url": "https://example.invalid/docs",
            "repo_url": "https://example.invalid/repo",
            "manual": {
                "ardupilot_repo_url": "https://example.invalid/vendor",
                "documents": [
                    {"url": "https://example.invalid/sheet.pdf", "kind": "datasheet"},
                ],
            },
        }))
        registry = tmp_path / "manufacturers.json"
        registry.write_text(json.dumps({"manufacturers": [{
            "id": "acme",
            "website": "https://example.invalid/acme",
            "store_url": "https://example.invalid/shop",
            "distributors_url": None,
        }]}))
        monkeypatch.setattr(link_check, "BOARDS_DIR", boards)
        monkeypatch.setattr(link_check, "REGISTRY", registry)

        found = {url for url, _, _ in link_check.collect()}
        assert found == {
            "https://example.invalid/docs",
            "https://example.invalid/repo",
            "https://example.invalid/vendor",
            "https://example.invalid/sheet.pdf",
            "https://example.invalid/acme",
            "https://example.invalid/shop",
        }

    def test_each_url_is_checked_once(self, tmp_path, monkeypatch):
        """Boards share wiki pages; checking one URL 40 times is just rudeness."""
        boards = tmp_path / "boards"
        boards.mkdir()
        shared = "https://example.invalid/common-thecube-overview.html"
        for slug in ("A", "B", "C"):
            (boards / f"{slug}.json").write_text(
                json.dumps({"slug": slug, "docs_url": shared, "manual": {}})
            )
        monkeypatch.setattr(link_check, "BOARDS_DIR", boards)
        monkeypatch.setattr(link_check, "REGISTRY", tmp_path / "missing.json")

        assert [u for u, _, _ in link_check.collect()] == [shared]


class TestErrorClassification:
    @pytest.mark.parametrize("message,expected", [
        ("[SSL: CERTIFICATE_VERIFY_FAILED] certificate has expired (_ssl.c:1080)",
         "TLS: certificate expired"),
        ("[SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate",
         "TLS: incomplete chain"),
        ("[Errno 8] nodename nor servname provided", "DNS: no such host"),
        ("The read operation timed out", "timeout"),
        ("[Errno 61] Connection refused", "connection refused"),
    ])
    def test_real_cause_is_reported(self, message, expected):
        """"URLError" described an expired certificate and a dead host alike.

        The distinction is the whole point: an expired certificate shows every
        visitor a browser warning and needs the vendor told, while an incomplete
        chain is something browsers paper over.
        """
        assert link_check._explain(Exception(message)) == expected

    def test_unknown_errors_keep_their_detail(self):
        out = link_check._explain(ValueError("something unanticipated"))
        assert "ValueError" in out and "unanticipated" in out

    def test_expired_and_incomplete_chain_are_not_conflated(self):
        expired = link_check._explain(Exception("certificate has expired"))
        chain = link_check._explain(Exception("unable to get local issuer certificate"))
        assert expired != chain


class TestThrottling:
    @pytest.mark.parametrize("url,throttled", [
        ("https://github.com/ArduPilot/ardupilot/blob/master/x/README.md", True),
        ("https://raw.githubusercontent.com/ArduPilot/ardupilot/master/x", True),
        ("https://www.mateksys.com/", False),
        ("https://ardupilot.org/copter/docs/common-matekh743-wing.html", False),
    ])
    def test_only_github_is_throttled(self, url, throttled):
        """Unthrottled concurrent requests to GitHub produced false 404s.

        Pacing every host instead would make a full run take hours, so the
        slowdown is confined to the host that actually rate-limits us.
        """
        assert link_check._is_throttled(url) is throttled


class TestDriftShaping:
    def test_flatten_produces_dotted_paths(self):
        flat = drift_report.flatten({"io": {"pwm": {"total": 13}}, "slug": "X"})
        assert flat == {"io.pwm.total": 13, "slug": "X"}

    def test_human_and_ai_blocks_are_not_drift(self):
        """build.py preserves both, so a change there is never parser drift.

        Including them would make every extraction pass look like the parser
        had changed, which is exactly the signal this is meant to isolate.
        """
        board = {
            "slug": "X",
            "io": {"uart_count": 7},
            "manual": {"notes": "hand written"},
            "ai": {"mcu_part": "STM32H743IIK6"},
        }
        derived = drift_report.build_derived(board)
        assert derived == {"slug": "X", "io.uart_count": 7}
        assert not any(k.startswith(("manual", "ai")) for k in derived)
