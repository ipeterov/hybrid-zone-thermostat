"""Outdoor lockouts: below a temperature, a unit may not heat (or cool).

Residential dual-fuel practice: a heat pump's compressor has a minimum
outdoor temperature, below which it's inefficient or can't keep up, and a
cooler shouldn't run when it's cold outside. Applied before a controller
runs, by clearing the unit's ``can_heat`` / ``can_cool``.

A lockout holds until the outdoor temperature is ``HYSTERESIS`` above its
threshold, so a reading wobbling around it doesn't flip the unit on and off.
"""

from typing import Any

from .model import Mode

HYSTERESIS = 1.0


class Lockouts:
    """Remembers which locks are engaged, for the hysteresis."""

    def __init__(self) -> None:
        self._locked: set[tuple[str, Mode]] = set()

    def allows(
        self,
        unit_id: str,
        mode: Mode,
        threshold: float | None,
        outdoor: float | None,
    ) -> bool:
        """Whether the unit may work in ``mode`` now.

        With no threshold, or no outdoor reading, nothing is locked.

        >>> lockouts = Lockouts()
        >>> lockouts.allows("ac", Mode.HEAT, -15, -16)
        False
        >>> lockouts.allows("ac", Mode.HEAT, -15, -14.5)  # within hysteresis
        False
        >>> lockouts.allows("ac", Mode.HEAT, -15, -13.9)
        True
        """
        key = (unit_id, mode)
        if threshold is None or outdoor is None:
            self._locked.discard(key)
            return True
        limit = threshold + HYSTERESIS if key in self._locked else threshold
        if outdoor < limit:
            self._locked.add(key)
            return False
        self._locked.discard(key)
        return True

    def dump_state(self) -> list[list[str]]:
        return sorted([unit_id, mode.value] for unit_id, mode in self._locked)

    def load_state(self, state: Any) -> None:
        self._locked = {
            (str(unit_id), Mode(mode)) for unit_id, mode in state or ()
        }
