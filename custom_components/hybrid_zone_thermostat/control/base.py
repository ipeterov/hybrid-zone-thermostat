"""The controller interface every strategy implements."""

from abc import ABC, abstractmethod
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from .model import HouseDecision, HouseSnapshot, ZoneDecision, ZoneSnapshot


class Controller(ABC):
    """Decides, from a snapshot of the whole house, what every unit does.

    It sees the whole house, not one zone, because the strategies worth
    having later need it: MPC plans every zone together, and a shared
    multi-split can only heat or cool for all of its rooms at once.

    A controller may keep state between calls (a PI loop's integral, a
    model's estimates). ``dump_state`` and ``load_state`` carry it across a
    Home Assistant restart; the result must be JSON-serialisable.
    """

    @abstractmethod
    def decide(self, house: HouseSnapshot) -> HouseDecision:
        """Return one decision per zone in ``house``."""

    def dump_state(self) -> dict[str, Any]:
        """State worth keeping across a restart."""
        return {}

    def load_state(self, state: Mapping[str, Any]) -> None:  # noqa: B027
        """Restore what ``dump_state`` returned. Unknown keys are ignored."""


class ZoneByZoneController(Controller):
    """A controller that decides each zone on its own, ignoring the others."""

    def decide(self, house: HouseSnapshot) -> HouseDecision:
        return HouseDecision(
            zones={
                zone_id: self.decide_zone(
                    zone, house.now, house.outdoor_temperature
                )
                for zone_id, zone in house.zones.items()
            }
        )

    @abstractmethod
    def decide_zone(
        self,
        zone: ZoneSnapshot,
        now: datetime,
        outdoor_temperature: float | None,
    ) -> ZoneDecision:
        """Decide one zone."""
