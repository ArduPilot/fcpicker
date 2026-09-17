"""Cross-check the AI extraction pass against the hwdef parser.

The two derive the same facts independently: the parser reads ArduPilot's
hwdef, the extraction pass reads vendor pages and the wiki. Where they agree,
that is genuine corroboration — and they agree on nearly everything. Where
they diverge, one of them is wrong and it is worth a human look.

This is computed on every run rather than read from the `ai.discrepancies`
field, which is a snapshot from whenever the pass last ran. That distinction
is not academic: one stored discrepancy claims our uart_count for
MatekF765-SE is 8 including UART4, when the parser correctly reports 7 and
honours the `undef UART4`. A frozen list goes stale; a computed comparison
cannot.

Each check carries a ratchet of known divergences. They may shrink, never
grow — a new disagreement means something changed and nobody noticed.
"""
from __future__ import annotations

import re

import pytest

# ArduPilot builds several parts on a superset compile target, so the silicon
# on the board and the hwdef's target legitimately differ. The AI reads the
# former off vendor documentation, the parser the latter out of hwdef; neither
# is wrong. Pairs are unordered.
MCU_TARGET_ALIASES = {
    frozenset({"STM32F765", "STM32F767"}),
    frozenset({"STM32H753", "STM32H743"}),
    frozenset({"STM32H755", "STM32H757"}),
}

# Boards where the two sources genuinely disagree, as of writing. Shrink this
# by fixing the data, never extend it to silence a failure.
KNOWN_UART_DIVERGENCE = {"AIRLink", "BETAFPV-F405-I2C", "JHEMCU-H743HD", "PH4-mini"}
# Two of these matter more than the rest: sanity_check.py independently flags
# CubeRedPrimary-PPPGW and Pixhawk6X-PPPGW as "3 IMU but 0 baro — verify
# against wiki", and the extraction pass agrees they do have a barometer. Two
# independent signals pointing at the same parser gap.
KNOWN_FEATURE_DIVERGENCE = {
    "BeastH7v2", "CubeRedPrimary-PPPGW", "FlywooH743Pro", "GEPRC_TAKER_H743",
    "IFLIGHT_2RAW_H7", "MambaF405US-I2C", "MambaF405v2", "Pixhawk6X-PPPGW",
    "speedybeef4",
}
KNOWN_MCU_DIVERGENCE: set[str] = set()


def ai_boards(boards):
    return [b for b in boards if b.get("ai")]


def _family(part: str | None) -> str | None:
    m = re.match(r"(STM32[A-Z]?\d{3})", (part or "").upper())
    return m.group(1) if m else None


def test_the_ai_pass_covers_most_of_the_catalog(boards):
    """A comparison over a handful of boards would prove nothing."""
    covered = len(ai_boards(boards))
    assert covered > len(boards) * 0.8, (
        f"only {covered}/{len(boards)} boards have an ai block — too thin to "
        "cross-check against"
    )


def test_can_count_agrees_exactly(boards):
    """CAN interfaces are unambiguous in both sources; any divergence is real."""
    bad = [
        f"{b['slug']}: ai={b['ai']['can_count']} parser={b['io']['can_count']}"
        for b in ai_boards(boards)
        if b["ai"].get("can_count") is not None
        and b["ai"]["can_count"] != b["io"]["can_count"]
    ]
    assert not bad, "AI and parser disagree on CAN count:\n  " + "\n  ".join(bad)


def test_uart_count_agrees(boards):
    bad = [
        f"{b['slug']}: ai={b['ai']['uart_count']} parser={b['io']['uart_count']}"
        for b in ai_boards(boards)
        if b["ai"].get("uart_count") is not None
        and b["ai"]["uart_count"] != b["io"]["uart_count"]
        and b["slug"] not in KNOWN_UART_DIVERGENCE
    ]
    assert not bad, (
        "new AI/parser disagreement on UART count:\n  " + "\n  ".join(bad)
        + "\n\nCheck the hwdef's SERIAL_ORDER against the vendor page before "
          "adding anything to KNOWN_UART_DIVERGENCE."
    )


@pytest.mark.parametrize(
    "field,reader",
    [
        ("has_sdcard", lambda b: b["io"]["sdcard"]),
        ("has_baro", lambda b: len(b["baros"]) > 0),
    ],
)
def test_boolean_features_agree(boards, field, reader):
    bad = [
        f"{b['slug']}: ai={b['ai'][field]} parser={reader(b)}"
        for b in ai_boards(boards)
        if b["ai"].get(field) is not None
        and b["ai"][field] != reader(b)
        and b["slug"] not in KNOWN_FEATURE_DIVERGENCE
    ]
    assert not bad, f"AI and parser disagree on {field}:\n  " + "\n  ".join(bad)


def test_mcu_part_is_consistent_with_the_compile_target(boards):
    """The AI reads the silicon; the parser reads the build target.

    Those differ legitimately where ArduPilot builds a part on a superset
    target, so the check is family compatibility rather than string equality.
    """
    bad = []
    for b in ai_boards(boards):
        ai_part, parser_part = b["ai"].get("mcu_part"), (b.get("mcu") or {}).get("part")
        fa, fp = _family(ai_part), _family(parser_part)
        if not fa or not fp or fa == fp:
            continue
        if frozenset({fa, fp}) in MCU_TARGET_ALIASES:
            continue
        if b["slug"] in KNOWN_MCU_DIVERGENCE:
            continue
        bad.append(f"{b['slug']}: ai={ai_part} parser={parser_part}")
    assert not bad, (
        "AI-read MCU is not the parser's family or a known superset target:\n  "
        + "\n  ".join(bad)
        + "\n\nIf this is another legitimate target alias, add the pair to "
          "MCU_TARGET_ALIASES; otherwise one of the two readings is wrong."
    )
