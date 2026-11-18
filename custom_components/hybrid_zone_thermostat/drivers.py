"""Turning a room unit's demand into service calls to its HA entity.

Only one kind so far: a `climate` entity driven by setpoint offset, as a
split AC. HZT picks heat, cool or off, and sets the setpoint past the AC's
own reading by an amount that grows with demand:

    setpoint = AC's reading ± (PUSH_MIN + PUSH_SPAN * level)

rounded to the AC's step and clamped to its range. The AC's own loop then
runs its compressor about as hard as HZT wants, whatever its sensor's bias
(the Hisense reads several degrees high while heating): what matters is the
gap it sees, not the absolute number.
"""

from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta

from homeassistant.components.climate import (
    ATTR_CURRENT_TEMPERATURE,
    ATTR_HVAC_MODE,
    ATTR_HVAC_MODES,
    ATTR_MAX_TEMP,
    ATTR_MIN_TEMP,
    ATTR_TARGET_TEMP_STEP,
    SERVICE_SET_HVAC_MODE,
    SERVICE_SET_TEMPERATURE,
)
from homeassistant.components.climate import (
    DOMAIN as CLIMATE_DOMAIN,
)
from homeassistant.const import (
    ATTR_ENTITY_ID,
    ATTR_TEMPERATURE,
    STATE_UNAVAILABLE,
)
from homeassistant.core import Context, HomeAssistant, State

from .control import Mode, UnitDemand

PUSH_MIN = 1.0
PUSH_SPAN = 3.0
# Setpoint-only changes go out at most this often; mode changes at once
# (equipment protection already paces those).
MIN_SETPOINT_INTERVAL = timedelta(seconds=60)


@dataclass(frozen=True, slots=True)
class Command:
    hvac_mode: str
    temperature: float | None = None


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, int | float) else None


def command_for(
    state: State, demand: UnitDemand, room_temperature: float | None
) -> Command | None:
    """What to tell the entity for ``demand``; None if it can't do it.

    >>> from homeassistant.core import State
    >>> ac = State("climate.ac", "off", {
    ...     "hvac_modes": ["off", "heat", "cool"], "current_temperature": 29.6,
    ...     "target_temp_step": 1, "min_temp": 16, "max_temp": 32})
    >>> command_for(ac, UnitDemand(Mode.HEAT, 0.5), 22.0)
    Command(hvac_mode='heat', temperature=32.0)
    >>> command_for(ac, UnitDemand(Mode.COOL, 0.0), 26.0)
    Command(hvac_mode='cool', temperature=29.0)
    >>> command_for(ac, UnitDemand(None), 22.0)
    Command(hvac_mode='off', temperature=None)
    """
    if demand.mode is None:
        return Command("off")
    modes = state.attributes.get(ATTR_HVAC_MODES) or []
    if demand.mode.value not in modes:
        return None
    reading = _number(state.attributes.get(ATTR_CURRENT_TEMPERATURE))
    if reading is None:
        reading = room_temperature
    if reading is None:
        return Command(demand.mode.value)
    push = PUSH_MIN + PUSH_SPAN * demand.level
    raw = reading + push if demand.mode is Mode.HEAT else reading - push
    step = _number(state.attributes.get(ATTR_TARGET_TEMP_STEP)) or 0.5
    setpoint = round(raw / step) * step
    low = _number(state.attributes.get(ATTR_MIN_TEMP))
    high = _number(state.attributes.get(ATTR_MAX_TEMP))
    if low is not None:
        setpoint = max(low, setpoint)
    if high is not None:
        setpoint = min(high, setpoint)
    return Command(demand.mode.value, round(setpoint, 1))


class ClimateDriver:
    """Sends commands to one climate entity, and recognises its own."""

    def __init__(self, hass: HomeAssistant, entity_id: str) -> None:
        self.hass = hass
        self.entity_id = entity_id
        self.last: Command | None = None
        self._last_setpoint_sent: datetime | None = None
        self._contexts: deque[str] = deque(maxlen=20)

    def is_ours(self, state: State) -> bool:
        """Whether this state is what HZT asked for (or HZT's own call)."""
        if state.context.id in self._contexts:
            return True
        if self.last is None:
            return False
        if state.state != self.last.hvac_mode:
            return False
        if self.last.temperature is None:
            return True
        return _number(state.attributes.get(ATTR_TEMPERATURE)) == (
            self.last.temperature
        )

    async def async_apply(
        self, demand: UnitDemand, room_temperature: float | None, now: datetime
    ) -> None:
        state = self.hass.states.get(self.entity_id)
        if state is None or state.state == STATE_UNAVAILABLE:
            return
        command = command_for(state, demand, room_temperature)
        if command is None:
            return
        mode_change = state.state != command.hvac_mode
        setpoint_change = command.temperature is not None and (
            _number(state.attributes.get(ATTR_TEMPERATURE))
            != command.temperature
        )
        if not (mode_change or setpoint_change):
            self.last = command
            return
        if (
            not mode_change
            and self._last_setpoint_sent is not None
            and now - self._last_setpoint_sent < MIN_SETPOINT_INTERVAL
        ):
            return

        context = Context()
        self._contexts.append(context.id)
        if command.temperature is None:
            await self.hass.services.async_call(
                CLIMATE_DOMAIN,
                SERVICE_SET_HVAC_MODE,
                {
                    ATTR_ENTITY_ID: self.entity_id,
                    ATTR_HVAC_MODE: command.hvac_mode,
                },
                blocking=True,
                context=context,
            )
            self.last = command
            return
        await self.hass.services.async_call(
            CLIMATE_DOMAIN,
            SERVICE_SET_TEMPERATURE,
            {
                ATTR_ENTITY_ID: self.entity_id,
                ATTR_HVAC_MODE: command.hvac_mode,
                ATTR_TEMPERATURE: command.temperature,
            },
            blocking=True,
            context=context,
        )
        # Only once it went through, so a failed call is retried.
        self.last = command
        self._last_setpoint_sent = now
