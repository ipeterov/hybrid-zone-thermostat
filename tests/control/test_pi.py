from datetime import UTC, datetime, timedelta

import pytest

from custom_components.hybrid_zone_thermostat.control import (
    HouseSnapshot,
    Mode,
    PIController,
    UnitSnapshot,
    ZoneSnapshot,
    ZoneState,
)

T0 = datetime(2026, 11, 18, 18, 0, tzinfo=UTC)

UNITS = {
    "ac": UnitSnapshot("ac", can_heat=True, can_cool=True),
    "radiator": UnitSnapshot("radiator", can_heat=True, can_cool=False),
}


def zone(
    temperature: float | None,
    *,
    # With the 1.5 band centred on it: heats below 22.0, cools above 23.5.
    target: float = 22.75,
    enabled: bool = True,
    units: dict[str, UnitSnapshot] | None = None,
) -> ZoneSnapshot:
    return ZoneSnapshot(
        zone_id="living_room",
        enabled=enabled,
        room_temperature=temperature,
        target=target,
        idle_band=1.5,
        heating_order=("ac", "radiator"),
        cooling_order=("ac",),
        units=units or UNITS,
    )


def decide(controller: PIController, snapshot: ZoneSnapshot, at: datetime):
    house = HouseSnapshot(
        now=at, outdoor_temperature=5.0, zones={"z": snapshot}
    )
    return controller.decide(house).zones["z"]


def run_for(controller: PIController, snapshot: ZoneSnapshot, minutes: int):
    """Call every minute for ``minutes``; return the last decision."""
    decision = None
    for minute in range(minutes + 1):
        decision = decide(controller, snapshot, T0 + timedelta(minutes=minute))
    assert decision is not None
    return decision


def test_small_error_runs_only_the_first_unit():
    decision = decide(PIController(), zone(21.6), T0)

    assert decision.state is ZoneState.HEATING
    assert decision.demands["ac"].mode is Mode.HEAT
    assert decision.demands["radiator"].mode is None


def test_persistent_error_brings_in_the_second_unit():
    early = run_for(PIController(), zone(21.6), 5)
    late = run_for(PIController(), zone(21.6), 120)

    assert early.demands["radiator"].mode is None
    assert late.demands["radiator"].mode is Mode.HEAT
    assert late.demands["ac"].level == 1.0


def test_large_error_brings_in_the_second_unit_at_once():
    decision = decide(PIController(), zone(20.5), T0)

    assert decision.demands["radiator"].mode is Mode.HEAT


def test_idle_band_runs_nothing():
    decision = decide(PIController(), zone(22.8), T0)

    assert decision.state is ZoneState.IDLE
    assert all(d.mode is None for d in decision.demands.values())


@pytest.mark.parametrize(
    ("temperature", "state"),
    [
        (21.2, ZoneState.HEATING),
        (21.3, ZoneState.IDLE),
        (22.7, ZoneState.IDLE),
        (22.8, ZoneState.COOLING),
    ],
)
def test_the_band_is_centred_on_the_target(
    temperature: float, state: ZoneState
):
    decision = decide(PIController(), zone(temperature, target=22.0), T0)

    assert decision.state is state


def test_a_quarter_degree_edge_is_said_as_it_is():
    decision = decide(PIController(), zone(22.0, target=22.0), T0)

    assert "between 21.25 and 22.75" in decision.reason


def test_above_the_band_cools_with_the_cooling_order():
    decision = decide(PIController(), zone(24.0), T0)

    assert decision.state is ZoneState.COOLING
    assert decision.demands["ac"].mode is Mode.COOL
    assert decision.demands["radiator"].mode is None


def test_changeover_resets_the_other_loop():
    controller = PIController()
    run_for(controller, zone(21.0), 60)

    decision = decide(controller, zone(24.0), T0 + timedelta(minutes=61))

    assert decision.state is ZoneState.COOLING
    assert controller.dump_state()["living_room"]["heat_integral"] == 0.0


def test_locked_out_unit_is_skipped_and_the_next_moves_up():
    units = {
        "ac": UnitSnapshot("ac", can_heat=False, can_cool=True),
        "radiator": UnitSnapshot("radiator", can_heat=True, can_cool=False),
    }

    decision = decide(PIController(), zone(21.6, units=units), T0)

    assert decision.demands["ac"].mode is None
    assert decision.demands["radiator"].mode is Mode.HEAT
    assert decision.reason == "0.4 °C below 22.0: heating with radiator at 20%."


def test_no_room_temperature_holds_everything_off():
    decision = decide(PIController(), zone(None), T0)

    assert decision.state is ZoneState.FAULT
    assert all(d.mode is None for d in decision.demands.values())


def test_a_missing_reading_keeps_the_loops_memory():
    controller = PIController()
    run_for(controller, zone(24.0), 30)
    before = controller.dump_state()["living_room"]["cool_integral"]

    decide(controller, zone(None), T0 + timedelta(minutes=31))

    assert before > 0
    assert controller.dump_state()["living_room"]["cool_integral"] == before


def test_cooling_keeps_going_at_minimum_just_below_the_edge():
    controller = PIController()
    run_for(controller, zone(23.8), 5)  # cooling, 0.3 above 23.5

    # Back down to the edge, then 0.2 into the band: the integral has
    # drained, but the zone holds on within the 0.3 differential.
    for minute, temperature in enumerate([23.5, 23.4, 23.3, 23.4], start=6):
        decision = decide(
            controller, zone(temperature), T0 + timedelta(hours=minute)
        )
        assert decision.state is ZoneState.COOLING
        assert decision.demands["ac"].mode is Mode.COOL

    assert decision.demands["ac"].level == 0.0
    assert decision.reason == (
        "23.4 °C, just past 23.5: ac keeps cooling at its minimum until 23.2."
    )


def test_cooling_stops_past_the_differential():
    controller = PIController()
    run_for(controller, zone(23.8), 5)

    decision = decide(controller, zone(23.2), T0 + timedelta(hours=2))

    assert decision.state is ZoneState.IDLE


def test_rising_into_the_band_from_below_does_not_hold_cooling():
    decision = decide(PIController(), zone(23.4), T0)

    assert decision.state is ZoneState.IDLE


def test_heating_keeps_going_at_minimum_just_above_the_target():
    controller = PIController()
    run_for(controller, zone(21.8), 5)

    decision = decide(controller, zone(22.2), T0 + timedelta(hours=2))

    assert decision.state is ZoneState.HEATING
    assert decision.demands["ac"].level == 0.0
    assert decision.demands["radiator"].mode is None


def test_disabled_zone_is_off():
    decision = decide(PIController(), zone(18.0, enabled=False), T0)

    assert decision.state is ZoneState.OFF
    assert all(d.mode is None for d in decision.demands.values())


def test_a_long_gap_counts_as_at_most_ten_minutes():
    controller = PIController()
    decide(controller, zone(21.0), T0)

    decide(controller, zone(21.0), T0 + timedelta(hours=6))

    integral = controller.dump_state()["living_room"]["heat_integral"]
    assert integral == pytest.approx(0.5 * 1.0 * (10 / 60))


def test_state_survives_a_dump_and_load():
    first = PIController()
    run_for(first, zone(21.6), 90)

    second = PIController()
    second.load_state(first.dump_state())

    assert second.dump_state() == first.dump_state()
