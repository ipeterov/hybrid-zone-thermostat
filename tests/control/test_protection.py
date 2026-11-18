from datetime import UTC, datetime, timedelta

from custom_components.hybrid_zone_thermostat.control import (
    OFF,
    Mode,
    UnitDemand,
)
from custom_components.hybrid_zone_thermostat.control.protection import (
    Limits,
    Protection,
)

T0 = datetime(2026, 11, 18, 18, 0, tzinfo=UTC)
LIMITS = Limits(
    min_run=timedelta(minutes=6),
    min_rest=timedelta(minutes=4),
    changeover=timedelta(minutes=10),
)
HEAT = UnitDemand(Mode.HEAT, 0.7)
COOL = UnitDemand(Mode.COOL, 0.7)


def at(minutes: float) -> datetime:
    return T0 + timedelta(minutes=minutes)


def test_a_new_unit_starts_as_asked():
    demand, note = Protection().apply("ac", HEAT, LIMITS, T0)

    assert demand == HEAT
    assert note is None


def test_a_unit_runs_its_minimum_before_stopping():
    protection = Protection()
    protection.apply("ac", HEAT, LIMITS, at(0))

    held, note = protection.apply("ac", OFF, LIMITS, at(2))
    stopped, _ = protection.apply("ac", OFF, LIMITS, at(6))

    assert held == UnitDemand(Mode.HEAT, 0.0)
    assert note == "held on for its minimum run (4 min left)"
    assert stopped == OFF


def test_a_stopped_unit_rests_before_starting():
    protection = Protection()
    protection.apply("ac", HEAT, LIMITS, at(0))
    protection.apply("ac", OFF, LIMITS, at(10))

    held, note = protection.apply("ac", HEAT, LIMITS, at(12))
    started, _ = protection.apply("ac", HEAT, LIMITS, at(14))

    assert held == OFF
    assert note == "held off for its minimum rest (2 min left)"
    assert started == HEAT


def test_switching_direction_stops_then_waits_the_changeover():
    protection = Protection()
    protection.apply("ac", HEAT, LIMITS, at(0))

    stopping, note = protection.apply("ac", COOL, LIMITS, at(10))
    waiting, wait_note = protection.apply("ac", COOL, LIMITS, at(15))
    cooling, _ = protection.apply("ac", COOL, LIMITS, at(20))

    assert stopping == OFF
    assert note == "stopped before switching to cool"
    assert waiting == OFF
    assert wait_note == "held off for its changeover rest (5 min left)"
    assert cooling == COOL


def test_level_changes_pass_straight_through():
    protection = Protection()
    protection.apply("ac", HEAT, LIMITS, at(0))

    demand, note = protection.apply(
        "ac", UnitDemand(Mode.HEAT, 0.2), LIMITS, at(1)
    )

    assert demand.level == 0.2
    assert note is None


def test_state_survives_a_dump_and_load():
    first = Protection()
    first.apply("ac", HEAT, LIMITS, at(0))

    second = Protection()
    second.load_state(first.dump_state())
    held, _ = second.apply("ac", OFF, LIMITS, at(2))

    assert held.mode is Mode.HEAT


def test_a_unit_only_ever_seen_off_needs_no_rest():
    protection = Protection()
    protection.apply("radiator", OFF, LIMITS, at(0))

    demand, note = protection.apply("radiator", HEAT, LIMITS, at(1))

    assert demand == HEAT
    assert note is None
