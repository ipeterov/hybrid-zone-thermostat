"""The controller that controls nothing: the user drives the units."""

from datetime import datetime

from .base import ZoneByZoneController
from .model import ZoneDecision, ZoneSnapshot, ZoneState


class ManualController(ZoneByZoneController):
    """Leaves every unit alone and says so.

    >>> from datetime import UTC
    >>> zone = ZoneSnapshot("lr", True, 21.0, 22.0, 1.5, (), (), {})
    >>> ManualController().decide_zone(zone, datetime.now(UTC), None).state
    <ZoneState.MANUAL: 'manual'>
    """

    def decide_zone(
        self,
        zone: ZoneSnapshot,
        now: datetime,
        outdoor_temperature: float | None,
    ) -> ZoneDecision:
        return ZoneDecision(
            state=ZoneState.MANUAL,
            reason="HZT isn't driving this zone's units.",
        )
