"""PI control with demand split across an ordered list of units.

Per zone there are two loops, as in ASHRAE Guideline 36's separate heating
and cooling setpoints: the zone has one target and an idle band centred on
it, heating holds the band's lower edge and cooling its upper edge.
Between the two, nothing runs. Each loop turns its error into a demand
from 0 to 1:

    demand = clamp(kp * error + integral, 0, 1)

where the integral grows by ``ki * error`` per hour and is clamped to
[0, 1], so it can't wind up past full demand or below nothing. When one
loop starts, the other's integral is reset.

The demand is split across the units in the zone's order that may work in
that direction right now (lockouts already applied). With n of them, unit
k (counting from 0) owns the slice from k/n to (k+1)/n: it joins when the
demand rises past k/n, and runs at the fraction of its slice that's
filled. So a small, short error runs the first unit gently; an error that
persists grows the integral until the next unit joins. That's the "joins
after N minutes or N degrees below" rule, from two numbers instead of two
per unit. A small hysteresis around each slice boundary stops a unit
flapping on and off at the edge.

A loop holds its setpoint, so once the room reaches it the error and the
demand are about zero, and sensor noise would flip the zone between
running and idle every tick. So a zone leaves heating or cooling only once
the room is ``EXIT_DIFFERENTIAL`` past the setpoint, into the idle band:
until then the first unit keeps running at its minimum. This is a
thermostat's differential, and it suits inverter units, which are better
off running slowly than starting and stopping.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from .base import ZoneByZoneController
from .model import (
    OFF,
    Mode,
    UnitDemand,
    ZoneDecision,
    ZoneSnapshot,
    ZoneState,
)

# A gap between calls longer than this (HA was down, say) counts as this
# long, so one late call can't swing the integral to its limit.
MAX_STEP = timedelta(minutes=10)

# °C past the setpoint, into the idle band, before a running zone goes idle.
# Never more than half the band, so heating's and cooling's never overlap.
EXIT_DIFFERENTIAL = 0.3


@dataclass(frozen=True, slots=True)
class PIGains:
    """Tuning shared by every zone for now."""

    kp: float = 0.5  # demand per °C of error: 2 °C off is full demand
    ki: float = 0.5  # demand per °C·hour: 1 °C off for 2 h adds full demand
    stage_hysteresis: float = 0.05  # demand, around each slice boundary


@dataclass(slots=True)
class _Loop:
    integral: float = 0.0
    # Units running in this loop's direction, by id.
    running: set[str] = field(default_factory=set)


@dataclass(slots=True)
class _ZoneMemory:
    heat: _Loop = field(default_factory=_Loop)
    cool: _Loop = field(default_factory=_Loop)
    last_update: datetime | None = None
    # The direction the zone ran in last decision, None when idle.
    active: Mode | None = None


def _edge(value: float) -> str:
    """A band edge: one decimal, or two on a quarter degree (24 ± 0.75)."""
    hundredths = round(value * 100)
    return f"{value:.1f}" if hundredths % 10 == 0 else f"{value:.2f}"


def _and(items: list[str]) -> str:
    """'A', 'A and B', 'A, B and C'."""
    return (
        items[0]
        if len(items) == 1
        else f"{', '.join(items[:-1])} and {items[-1]}"
    )


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


class PIController(ZoneByZoneController):
    """See the module docstring."""

    def __init__(self, gains: PIGains | None = None) -> None:
        self.gains = gains or PIGains()
        self._zones: dict[str, _ZoneMemory] = {}

    def decide_zone(
        self,
        zone: ZoneSnapshot,
        now: datetime,
        outdoor_temperature: float | None,
    ) -> ZoneDecision:
        memory = self._zones.setdefault(zone.zone_id, _ZoneMemory())
        all_off = dict.fromkeys(zone.units, OFF)

        if not zone.enabled:
            self._zones[zone.zone_id] = _ZoneMemory()
            return ZoneDecision(ZoneState.OFF, all_off, "Zone is off.")

        if zone.room_temperature is None:
            # Memory is kept: a reading that's missing for a moment (HA
            # starting, a sensor reconnecting) mustn't restart the loops.
            return ZoneDecision(
                ZoneState.FAULT,
                all_off,
                "No room temperature, so every unit is held off.",
            )

        hours = self._step_hours(memory, now)
        temperature = zone.room_temperature
        heat_error = zone.heat_setpoint - temperature
        cool_error = temperature - zone.cool_setpoint

        heat_demand = self._update_loop(memory.heat, heat_error, hours)
        cool_demand = self._update_loop(memory.cool, cool_error, hours)

        # Only one direction at a time. The band keeps both errors from
        # being positive together, but an integral can outlast its error.
        if cool_demand > 0:
            memory.heat = _Loop()
            heat_demand = 0.0
        elif heat_demand > 0:
            memory.cool = _Loop()

        differential = min(EXIT_DIFFERENTIAL, zone.idle_band / 2)
        if heat_demand > 0:
            mode, demand = Mode.HEAT, heat_demand
        elif cool_demand > 0:
            mode, demand = Mode.COOL, cool_demand
        elif memory.active is Mode.HEAT and heat_error > -differential:
            mode, demand = Mode.HEAT, 0.0
        elif memory.active is Mode.COOL and cool_error > -differential:
            mode, demand = Mode.COOL, 0.0
        else:
            memory.active = None
            memory.heat.running.clear()
            memory.cool.running.clear()
            return ZoneDecision(
                ZoneState.IDLE,
                all_off,
                f"{temperature:.1f} °C is between {_edge(zone.heat_setpoint)} "
                f"and {_edge(zone.cool_setpoint)}: nothing needs to run.",
            )

        if mode is Mode.HEAT:
            loop, state = memory.heat, ZoneState.HEATING
            order = [
                unit_id
                for unit_id in zone.heating_order
                if unit_id in zone.units and zone.units[unit_id].can_heat
            ]
        else:
            loop, state = memory.cool, ZoneState.COOLING
            order = [
                unit_id
                for unit_id in zone.cooling_order
                if unit_id in zone.units and zone.units[unit_id].can_cool
            ]
        memory.active = mode

        if demand > 0:
            levels = self._split(demand, order, loop.running)
            reason = self._reason(zone, mode, levels)
        else:
            # Past the setpoint but within the differential: the first
            # unit keeps going at its minimum.
            levels = {order[0]: 0.0} if order else {}
            loop.running.clear()
            loop.running.update(levels)
            reason = self._holding_reason(zone, mode, differential, order)

        demands = dict(all_off)
        for unit_id, level in levels.items():
            demands[unit_id] = UnitDemand(mode=mode, level=level)
        return ZoneDecision(state, demands, reason)

    def _step_hours(self, memory: _ZoneMemory, now: datetime) -> float:
        last, memory.last_update = memory.last_update, now
        if last is None or now <= last:
            return 0.0
        return min(now - last, MAX_STEP) / timedelta(hours=1)

    def _update_loop(self, loop: _Loop, error: float, hours: float) -> float:
        loop.integral = _clamp(loop.integral + self.gains.ki * error * hours)
        return _clamp(self.gains.kp * error + loop.integral)

    def _split(
        self, demand: float, order: list[str], running: set[str]
    ) -> dict[str, float]:
        """Which units run, and at what level. Updates ``running``."""
        count = len(order)
        hysteresis = self.gains.stage_hysteresis
        levels: dict[str, float] = {}
        for index, unit_id in enumerate(order):
            start = index / count
            # The first unit runs on any demand at all.
            threshold = (
                0.0
                if index == 0
                else start - hysteresis
                if unit_id in running
                else start + hysteresis
            )
            if demand > threshold:
                levels[unit_id] = _clamp(demand * count - index)
        running.clear()
        running.update(levels)
        return levels

    # Reasons are read on the dashboard: plain sentences, units by name,
    # in the order they joined.

    @staticmethod
    def _reason(
        zone: ZoneSnapshot, mode: Mode, levels: Mapping[str, float]
    ) -> str:
        assert zone.room_temperature is not None
        if mode is Mode.HEAT:
            gap = zone.heat_setpoint - zone.room_temperature
            where = f"{gap:.1f} °C below {_edge(zone.heat_setpoint)}"
            doing = "heating"
        else:
            gap = zone.room_temperature - zone.cool_setpoint
            where = f"{gap:.1f} °C above {_edge(zone.cool_setpoint)}"
            doing = "cooling"
        if not levels:
            return f"{where}, but nothing may {mode} right now."
        running = _and(
            [
                f"{zone.units[unit_id].name or unit_id} at {level:.0%}"
                for unit_id, level in levels.items()
            ]
        )
        return f"{where}: {doing} with {running}."

    @staticmethod
    def _holding_reason(
        zone: ZoneSnapshot, mode: Mode, differential: float, order: list[str]
    ) -> str:
        assert zone.room_temperature is not None
        if mode is Mode.HEAT:
            setpoint, doing = zone.heat_setpoint, "heating"
            stop = setpoint + differential
        else:
            setpoint, doing = zone.cool_setpoint, "cooling"
            stop = setpoint - differential
        where = f"{zone.room_temperature:.1f} °C, just past {_edge(setpoint)}"
        if not order:
            return f"{where}, but nothing may {mode} right now."
        first = zone.units[order[0]].name or order[0]
        return (
            f"{where}: {first} keeps {doing} at its minimum until "
            f"{_edge(stop)}."
        )

    def dump_state(self) -> dict[str, Any]:
        return {
            zone_id: {
                "heat_integral": memory.heat.integral,
                "cool_integral": memory.cool.integral,
                "heat_running": sorted(memory.heat.running),
                "cool_running": sorted(memory.cool.running),
                "last_update": memory.last_update.isoformat()
                if memory.last_update
                else None,
                "active": memory.active,
            }
            for zone_id, memory in self._zones.items()
        }

    def load_state(self, state: Mapping[str, Any]) -> None:
        self._zones = {}
        for zone_id, saved in state.items():
            last_update = saved.get("last_update")
            self._zones[zone_id] = _ZoneMemory(
                heat=_Loop(
                    float(saved.get("heat_integral", 0.0)),
                    set(saved.get("heat_running", ())),
                ),
                cool=_Loop(
                    float(saved.get("cool_integral", 0.0)),
                    set(saved.get("cool_running", ())),
                ),
                last_update=datetime.fromisoformat(last_update)
                if last_update
                else None,
                active=Mode(saved["active"]) if saved.get("active") else None,
            )
