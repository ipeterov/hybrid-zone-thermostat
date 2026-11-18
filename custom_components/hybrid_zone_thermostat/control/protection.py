"""Equipment protection: minimum run and rest times, and a changeover gap.

Applied to a controller's demands before they reach the devices, so no
strategy can short-cycle a compressor or a boiler:

- a unit that started runs at least ``min_run`` before it stops;
- a unit that stopped rests at least ``min_rest`` before it starts again;
- a unit switching between heating and cooling stops first, and rests at
  least ``changeover`` before running the other way.

While a unit is held on against the controller's wish, it runs at its
minimum (level 0).
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from .model import OFF, Mode, UnitDemand

CHANGEOVER = timedelta(minutes=10)
LONG_AGO = timedelta(days=1)


@dataclass(frozen=True, slots=True)
class Limits:
    min_run: timedelta
    min_rest: timedelta
    changeover: timedelta = CHANGEOVER


@dataclass(slots=True)
class _Record:
    mode: Mode | None
    since: datetime
    # The mode it last ran in, to tell a restart from a changeover.
    last_mode: Mode | None = None


def _minutes(delta: timedelta) -> str:
    minutes = max(1, round(delta.total_seconds() / 60))
    return f"{minutes} min"


class Protection:
    """Tracks what each unit was last told, and since when."""

    def __init__(self) -> None:
        self._units: dict[str, _Record] = {}

    def apply(
        self,
        unit_id: str,
        wanted: UnitDemand,
        limits: Limits,
        now: datetime,
    ) -> tuple[UnitDemand, str | None]:
        """The demand that may go out now, and why it differs, if it does.

        A unit seen for the first time starts as asked; one only ever seen
        off counts as long rested.
        """
        record = self._units.get(unit_id)
        if record is None:
            since = now if wanted.mode else now - LONG_AGO
            self._units[unit_id] = _Record(wanted.mode, since, wanted.mode)
            return wanted, None
        if wanted.mode == record.mode:
            return wanted, None

        elapsed = now - record.since
        if record.mode is not None:
            if elapsed < limits.min_run:
                left = _minutes(limits.min_run - elapsed)
                return (
                    UnitDemand(record.mode, 0.0),
                    f"held on for its minimum run ({left} left)",
                )
            self._units[unit_id] = _Record(None, now, record.mode)
            if wanted.mode is None:
                return OFF, None
            return OFF, f"stopped before switching to {wanted.mode}"

        switching = record.last_mode not in (None, wanted.mode)
        rest = (
            max(limits.min_rest, limits.changeover)
            if switching
            else limits.min_rest
        )
        if elapsed < rest:
            left = _minutes(rest - elapsed)
            why = "changeover rest" if switching else "minimum rest"
            return OFF, f"held off for its {why} ({left} left)"
        self._units[unit_id] = _Record(wanted.mode, now, wanted.mode)
        return wanted, None

    def stopped(self, unit_id: str, now: datetime) -> None:
        """The unit stopped on its own (it went unavailable, say): its rest
        starts now and nothing holds it on."""
        record = self._units.get(unit_id)
        if record is not None and record.mode is not None:
            self._units[unit_id] = _Record(None, now, record.mode)

    def dump_state(self) -> dict[str, Any]:
        return {
            unit_id: {
                "mode": record.mode.value if record.mode else None,
                "since": record.since.isoformat(),
                "last_mode": record.last_mode.value
                if record.last_mode
                else None,
            }
            for unit_id, record in self._units.items()
        }

    def load_state(self, state: Any) -> None:
        self._units = {}
        for unit_id, saved in (state or {}).items():
            self._units[unit_id] = _Record(
                Mode(saved["mode"]) if saved.get("mode") else None,
                datetime.fromisoformat(saved["since"]),
                Mode(saved["last_mode"]) if saved.get("last_mode") else None,
            )
