"""The captured D1 wire responses, pinned.

These assert what the API *actually returned* on 2026-10-05, so that the
response-unwrapping and error-classification code written in phase 1 has a
fixed target, and so that a change in Cloudflare's response shape fails here
rather than silently at the next stocktake.

There is no network access in this module. It reads
`tests/fixtures/d1_responses.json` and nothing else.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

FIXTURES = Path(__file__).parent / "fixtures" / "d1_responses.json"


@pytest.fixture(scope="module")
def captured() -> Dict[str, Any]:
    return json.loads(FIXTURES.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------
# The shape every successful response has
# --------------------------------------------------------------------------
def test_a_successful_response_nests_its_rows_two_levels_deep(captured) -> None:
    """`body.result[0].results` -- not `body.results`.

    Pinned because getting this wrong produces a Store that appears to work and
    returns nothing, which is a confusing way to lose an afternoon.
    """
    body = captured["success_select"]["body"]
    assert body["success"] is True
    assert body["errors"] == []
    assert body["result"][0]["results"] == [{"one": 1}]


def test_a_successful_response_reports_what_it_cost(captured) -> None:
    """`meta.rows_read` / `rows_written` are the quota instrumentation.

    They are the only honest way to know how much of the 5M/100k daily budget a
    command spends, and the reason the read budget stopped being guesswork.
    """
    meta = captured["success_select"]["body"]["result"][0]["meta"]
    for key in ("rows_read", "rows_written", "changes", "last_row_id", "duration"):
        assert key in meta, f"meta lost {key}"


def test_meta_admits_that_d1_retries_internally(captured) -> None:
    """`total_attempts` -- an apparent single call may already have been retried.

    Worth knowing before adding a retry layer on top of one that already exists.
    """
    assert captured["success_select"]["body"]["result"][0]["meta"]["total_attempts"] == 1


# --------------------------------------------------------------------------
# Errors. Classify on `code`, never on the HTTP status.
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    "name, http, code",
    [
        ("auth_error", 401, 10000),
        ("multi_statement_with_params_rejected", 400, 7400),
        ("sql_error_no_such_table", 400, 7500),
        ("constraint_violation", 400, 7500),
        ("database_not_found", 404, 7404),
    ],
)
def test_each_captured_error_has_the_status_and_code_it_had_when_measured(
    captured, name: str, http: int, code: int
) -> None:
    case = captured[name]
    assert case["http"] == http
    assert case["body"]["errors"][0]["code"] == code


def test_distinct_failures_share_http_400_so_the_code_is_what_distinguishes_them(
    captured,
) -> None:
    """The reason classification must key on `errors[].code`.

    A malformed request (7400) and a SQL error (7500) both arrive as 400, and
    they call for different behaviour -- so branching on the status alone cannot
    be right.
    """
    four_hundreds = {
        name: case["body"]["errors"][0]["code"]
        for name, case in captured.items()
        if isinstance(case, dict) and case.get("http") == 400
    }
    assert len(four_hundreds) >= 3
    assert len(set(four_hundreds.values())) >= 2, "400 is not a single condition"


def test_a_sql_error_is_a_400_and_not_a_200(captured) -> None:
    """The correction recorded in AGENTS.md section 4.

    An earlier version of that file asserted a SQL error comes back as HTTP 200
    with `success: false`. It does not. The claim came from a design review and
    was never verified; this test is the correction, pinned so it cannot quietly
    creep back into the code as a `status == 200` check.
    """
    assert captured["sql_error_no_such_table"]["http"] == 400


def test_every_error_body_carries_a_message_and_no_rows(captured) -> None:
    """`errors[0].message` is the only text worth showing a user.

    `result` is null on every failure, so there is nothing to partially apply.
    """
    for name, case in captured.items():
        if not isinstance(case, dict) or "http" not in case or case["http"] == 200:
            continue
        body = case["body"]
        assert body["success"] is False, name
        assert body["result"] is None, name
        assert body["errors"][0]["message"].strip(), name


def test_no_fixture_contains_a_credential(captured) -> None:
    """A guard, because these were captured from a live authenticated session.

    The probe masked the token, but a future re-capture might not, and a fixture
    is exactly the kind of file that gets pasted into an issue.
    """
    blob = json.dumps(captured).lower()
    for needle in ("bearer ", "cfut", "authorization"):
        assert needle not in blob, f"a fixture appears to contain a credential: {needle!r}"
