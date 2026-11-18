"""What a controller sees and what it decides. Plain data, no Home Assistant.

A controller never sees raw devices. Before it runs, outdoor lockouts and
unit availability are already folded into each unit's ``can_heat`` and
``can_cool``. After it runs, equipment protection (minimum run and rest
times) and the per-device drivers turn its demands into service calls. So
every controller, PI or MPC or anything else, gets lockouts and protection
for free and can't get them wrong.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum


class Mode(StrEnum):
    """The direction a room unit is asked to work in."""

    HEAT = "heat"
    COOL = "cool"


class ZoneState(StrEnum):
    """What a zone is doing, as the dashboard shows it. Never a lie: a zone
    that is holding its temperature with nothing running is IDLE, not OFF."""

    OFF = "off"  # The user turned the zone off.
    MANUAL = "manual"  # HZT is not driving this zone's units.
    HEATING = "heating"
    IDLE = "idle"  # In the idle band: nothing needs to run.
    COOLING = "cooling"
    FAULT = "fault"  # No usable room temperature; units held off.


@dataclass(frozen=True, slots=True)
class UnitSnapshot:
    """One room unit, as it may be used right now."""

    unit_id: str
    can_heat: bool
    can_cool: bool
    # What people call it, for reasons. Falls back to the id.
    name: str = ""


@dataclass(frozen=True, slots=True)
class ZoneSnapshot:
    """One zone at the moment of a decision."""

    zone_id: str
    enabled: bool
    room_temperature: float | None
    target: float
    # The width of the band, centred on the target, where nothing runs.
    idle_band: float
    # Unit ids, first choice first. A unit may be in both orders.
    heating_order: tuple[str, ...]
    cooling_order: tuple[str, ...]
    units: Mapping[str, UnitSnapshot]

    @property
    def heat_setpoint(self) -> float:
        """Heating holds the band's lower edge."""
        return self.target - self.idle_band / 2

    @property
    def cool_setpoint(self) -> float:
        """Cooling holds the band's upper edge."""
        return self.target + self.idle_band / 2


@dataclass(frozen=True, slots=True)
class HouseSnapshot:
    """Everything a controller may base a decision on."""

    now: datetime
    outdoor_temperature: float | None
    zones: Mapping[str, ZoneSnapshot]


@dataclass(frozen=True, slots=True)
class UnitDemand:
    """What one room unit should do: work in ``mode`` at ``level`` (0 to 1,
    0 meaning its minimum output), or stop when ``mode`` is None."""

    mode: Mode | None
    level: float = 0.0


OFF = UnitDemand(mode=None)


@dataclass(frozen=True, slots=True)
class ZoneDecision:
    """A zone's state, its units' demands, and why, in one line for people.

    A unit missing from ``demands`` is left alone: HZT sends it nothing.
    """

    state: ZoneState
    demands: Mapping[str, UnitDemand] = field(default_factory=dict)
    reason: str = ""


@dataclass(frozen=True, slots=True)
class HouseDecision:
    """One decision per zone in the snapshot."""

    zones: Mapping[str, ZoneDecision]
