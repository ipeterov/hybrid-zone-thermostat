"""Runs a house: snapshot, controller, protection, drivers.

On every relevant state change and every 30 s:

1. Build a snapshot from HA's states. Outdoor lockouts and unavailable
   entities are folded into each unit's can_heat / can_cool here.
2. Ask the controller for a decision.
3. Equipment protection may hold a unit on or off; its notes join the
   zone's reason.
4. For a zone that's live (not in shadow mode) and not under a manual
   override, the drivers send the demands to the devices.

A zone in shadow mode goes through 1-3 exactly as a live one does, so what
it shows is what it would do, but nothing reaches its units.

Manual changes: if someone changes a live zone's unit directly (its mode or
setpoint, to something HZT didn't ask for), HZT stops driving that zone for
MANUAL_HOLD and says so. Changing the zone's target or turning it off and on
hands it back at once.
"""

import logging
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Any

from homeassistant.const import (
    ATTR_TEMPERATURE,
    EVENT_HOMEASSISTANT_STARTED,
    STATE_UNAVAILABLE,
    STATE_UNKNOWN,
)
from homeassistant.core import (
    CALLBACK_TYPE,
    Event,
    EventStateChangedData,
    HomeAssistant,
    callback,
)
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN, SWITCH_DOMAINS
from .control import (
    Controller,
    HouseDecision,
    HouseSnapshot,
    Mode,
    UnitSnapshot,
    ZoneDecision,
    ZoneSnapshot,
    ZoneState,
)
from .control.lockouts import Lockouts
from .control.protection import Limits, Protection
from .drivers import ClimateDriver, SwitchDriver, on_minutes
from .storage import ConfigStore, RoomUnitConfig, ZoneConfig

_LOGGER = logging.getLogger(__name__)


def is_switch(unit: RoomUnitConfig) -> bool:
    return unit["entity_id"].split(".", 1)[0] in SWITCH_DOMAINS


SIGNAL_UPDATE = f"{DOMAIN}_update"
UPDATE_INTERVAL = timedelta(seconds=30)
MANUAL_HOLD = timedelta(hours=2)
# A missing room temperature (a sensor not loaded yet after a restart, a
# dropped Zigbee message) leaves the zone's units as they are for this long
# before they're turned off.
SENSOR_GRACE = timedelta(minutes=10)
STATE_STORAGE_KEY = f"{DOMAIN}.controller"
STATE_STORAGE_VERSION = 1
# How long runtime state may sit unsaved: a restart loses at most this
# much of a PI integral's history or a unit's run timer.
STATE_SAVE_DELAY = 60


@dataclass(slots=True)
class UnitStatus:
    """What the panel shows about a unit, beyond the controller's demand."""

    available: bool = True
    heat_locked: bool = False
    cool_locked: bool = False
    note: str | None = None
    # Switches: how long they're on in each cycle at the current demand.
    duty: str | None = None


@dataclass(slots=True)
class ManualOverride:
    until: datetime
    reason: str


class Engine:
    """One per config entry, which means one per house."""

    def __init__(
        self, hass: HomeAssistant, store: ConfigStore, controller: Controller
    ) -> None:
        self.hass = hass
        self.store = store
        self.controller = controller
        self.lockouts = Lockouts()
        self.protection = Protection()
        self.snapshot: HouseSnapshot | None = None
        self.decision: HouseDecision | None = None
        self.unit_status: dict[str, UnitStatus] = {}
        self.manual: dict[str, ManualOverride] = {}
        self._sensor_missing_since: dict[str, datetime] = {}
        self._drivers: dict[str, ClimateDriver | SwitchDriver] = {}
        self._state_store: Store[dict[str, Any]] = Store(
            hass, STATE_STORAGE_VERSION, STATE_STORAGE_KEY
        )
        self._unsubscribe: list[CALLBACK_TYPE] = []
        self._driving = False
        self._drive_again = False

    # ---- Lifecycle -------------------------------------------------------

    async def async_start(self) -> None:
        saved = await self._state_store.async_load() or {}
        if "controller" in saved:
            self.controller.load_state(saved["controller"])
            self.protection.load_state(saved.get("protection"))
            self.lockouts.load_state(saved.get("lockouts"))
        watched = self._watched_entities()
        if watched:
            self._unsubscribe.append(
                async_track_state_change_event(
                    self.hass, watched, self._on_state_change
                )
            )
        self._unsubscribe.append(
            async_track_time_interval(self.hass, self._on_tick, UPDATE_INTERVAL)
        )
        if not self.hass.is_running:
            self._unsubscribe.append(
                self.hass.bus.async_listen_once(
                    EVENT_HOMEASSISTANT_STARTED, self._on_started
                )
            )
        self.async_update()

    @callback
    def _on_started(self, event: Event) -> None:
        self.async_update()

    async def async_stop(self) -> None:
        for unsubscribe in self._unsubscribe:
            unsubscribe()
        self._unsubscribe.clear()
        await self._state_store.async_save(self._dump_state())

    def _dump_state(self) -> dict[str, Any]:
        return {
            "controller": self.controller.dump_state(),
            "protection": self.protection.dump_state(),
            "lockouts": self.lockouts.dump_state(),
        }

    # ---- Changes from the zone's own entity ------------------------------

    async def async_update_zone(self, zone_id: str, **changes: Any) -> None:
        """Change a zone's target or on/off, save, and decide again.

        The person used HZT's own control, so a manual override ends.
        """
        zone = self.store.zone(zone_id)
        zone.update(changes)  # type: ignore[typeddict-item]
        self.manual.pop(zone_id, None)
        await self.store.async_save(self.store.config)
        self.async_update()

    # ---- The loop ----------------------------------------------------------

    @callback
    def async_update(self) -> None:
        now = dt_util.utcnow()
        for zone_id, override in list(self.manual.items()):
            if now >= override.until:
                del self.manual[zone_id]
        self.snapshot = self._build_snapshot(now)
        decision = self.controller.decide(self.snapshot)
        self.decision = HouseDecision(
            zones={
                zone_id: self._finish_zone(zone_id, zone_decision, now)
                for zone_id, zone_decision in decision.zones.items()
            }
        )
        self._state_store.async_delay_save(self._dump_state, STATE_SAVE_DELAY)
        async_dispatcher_send(self.hass, SIGNAL_UPDATE)
        self._schedule_drive()

    @callback
    def _on_state_change(self, event: Event[EventStateChangedData]) -> None:
        self._check_manual_change(event)
        self.async_update()

    @callback
    def _on_tick(self, now: datetime) -> None:
        self.async_update()

    def _finish_zone(
        self, zone_id: str, decision: ZoneDecision, now: datetime
    ) -> ZoneDecision:
        """Apply manual overrides, the sensor grace and equipment
        protection."""
        if (override := self.manual.get(zone_id)) is not None:
            return ZoneDecision(ZoneState.MANUAL, {}, override.reason)
        if decision.state is ZoneState.FAULT:
            since = self._sensor_missing_since.setdefault(zone_id, now)
            if now - since < SENSOR_GRACE:
                minutes = int(SENSOR_GRACE.total_seconds() // 60)
                return ZoneDecision(
                    ZoneState.FAULT,
                    {},
                    "No room temperature, so the units are left as they "
                    f"are; they're turned off if it's still missing after "
                    f"{minutes} min.",
                )
        else:
            self._sensor_missing_since.pop(zone_id, None)
        units = {unit["id"]: unit for unit in self._units_of(zone_id)}
        demands = dict(decision.demands)
        notes: list[str] = []
        for unit_id, wanted in decision.demands.items():
            unit = units.get(unit_id)
            if unit is None:
                continue
            status = self.unit_status.setdefault(unit_id, UnitStatus())
            if not status.available or decision.state is ZoneState.OFF:
                # HA can't reach it, or the person turned the zone off: an
                # off they asked for wins over the minimum run (the unit's
                # own firmware still guards its compressor). Its rest
                # starts now, so a quick on again still waits.
                self.protection.stopped(unit_id, now)
                status.note = None
                status.duty = None
                continue
            limits = Limits(
                min_run=timedelta(minutes=unit["min_run"]),
                min_rest=timedelta(minutes=unit["min_rest"]),
            )
            demand, note = self.protection.apply(unit_id, wanted, limits, now)
            demands[unit_id] = demand
            status.note = note
            status.duty = None
            if is_switch(unit) and demand.mode is not None:
                cycle = unit["cycle_minutes"]
                on = on_minutes(
                    demand.level, cycle, unit["min_run"], unit["min_rest"]
                )
                status.duty = (
                    "on the whole time"
                    if on >= cycle
                    else f"on {on:g} of every {cycle:g} min"
                )
            if note:
                notes.append(f"{unit['name']} {note}.")
        reason = " ".join([decision.reason, *notes]).strip()
        return replace(decision, demands=demands, reason=reason)

    # ---- Snapshot ----------------------------------------------------------

    def _units_of(self, zone_id: str) -> list[RoomUnitConfig]:
        return [
            unit
            for unit in self.store.config["room_units"]
            if unit["zone_id"] == zone_id
        ]

    def _watched_entities(self) -> list[str]:
        config = self.store.config
        entities = [
            zone["room_sensor"]
            for zone in config["zones"]
            if zone["room_sensor"]
        ]
        entities += [unit["entity_id"] for unit in config["room_units"]]
        if config["house"]["outdoor_sensor"]:
            entities.append(config["house"]["outdoor_sensor"])
        return sorted(set(entities))

    def _build_snapshot(self, now: datetime) -> HouseSnapshot:
        config = self.store.config
        outdoor = self._read_temperature(config["house"]["outdoor_sensor"])
        return HouseSnapshot(
            now=now,
            outdoor_temperature=outdoor,
            zones={
                zone["id"]: self._zone_snapshot(zone, outdoor)
                for zone in config["zones"]
            },
        )

    def _zone_snapshot(
        self, zone: ZoneConfig, outdoor: float | None
    ) -> ZoneSnapshot:
        units: dict[str, UnitSnapshot] = {}
        for unit in self._units_of(zone["id"]):
            available = self._is_available(unit["entity_id"])
            heat_ok = self.lockouts.allows(
                unit["id"], Mode.HEAT, unit["heat_lockout_below"], outdoor
            )
            cool_ok = self.lockouts.allows(
                unit["id"], Mode.COOL, unit["cool_lockout_below"], outdoor
            )
            status = self.unit_status.setdefault(unit["id"], UnitStatus())
            status.available = available
            status.heat_locked = unit["can_heat"] and not heat_ok
            status.cool_locked = unit["can_cool"] and not cool_ok
            units[unit["id"]] = UnitSnapshot(
                unit_id=unit["id"],
                can_heat=unit["can_heat"] and available and heat_ok,
                can_cool=unit["can_cool"] and available and cool_ok,
                name=unit["name"],
            )
        return ZoneSnapshot(
            zone_id=zone["id"],
            enabled=zone["enabled"],
            room_temperature=self._read_temperature(zone["room_sensor"]),
            target=zone["target"],
            idle_band=zone["idle_band"],
            heating_order=tuple(zone["heating_order"]),
            cooling_order=tuple(zone["cooling_order"]),
            units=units,
        )

    def _read_temperature(self, entity_id: str | None) -> float | None:
        if entity_id is None:
            return None
        state = self.hass.states.get(entity_id)
        if state is None or state.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            return None
        try:
            return float(state.state)
        except ValueError:
            return None

    def _is_available(self, entity_id: str) -> bool:
        state = self.hass.states.get(entity_id)
        return state is not None and state.state != STATE_UNAVAILABLE

    # ---- Driving the devices --------------------------------------------

    def _driver(self, unit: RoomUnitConfig) -> ClimateDriver | SwitchDriver:
        driver = self._drivers.get(unit["id"])
        if driver is None or driver.entity_id != unit["entity_id"]:
            if is_switch(unit):
                driver = SwitchDriver(
                    self.hass,
                    unit["entity_id"],
                    cycle=timedelta(minutes=unit["cycle_minutes"]),
                    min_run=timedelta(minutes=unit["min_run"]),
                    min_rest=timedelta(minutes=unit["min_rest"]),
                )
            else:
                driver = ClimateDriver(self.hass, unit["entity_id"])
            self._drivers[unit["id"]] = driver
        return driver

    @callback
    def _schedule_drive(self) -> None:
        if self._driving:
            self._drive_again = True
            return
        self._driving = True
        self.hass.async_create_background_task(
            self._async_drive(), f"{DOMAIN} drive"
        )

    async def _async_drive(self) -> None:
        try:
            while True:
                self._drive_again = False
                await self._async_send_all()
                if not self._drive_again:
                    break
        finally:
            self._driving = False

    async def _async_send_all(self) -> None:
        decision, snapshot = self.decision, self.snapshot
        if decision is None or snapshot is None:
            return
        # While HA starts, entities appear one by one: a decision made now
        # may rest on a sensor that hasn't loaded yet.
        if not self.hass.is_running:
            return
        for zone in self.store.config["zones"]:
            if zone["shadow"] or zone["id"] in self.manual:
                continue
            zone_decision = decision.zones.get(zone["id"])
            zone_snapshot = snapshot.zones.get(zone["id"])
            if zone_decision is None or zone_snapshot is None:
                continue
            for unit in self._units_of(zone["id"]):
                demand = zone_decision.demands.get(unit["id"])
                if demand is None:
                    continue
                try:
                    await self._driver(unit).async_apply(
                        demand, zone_snapshot.room_temperature, snapshot.now
                    )
                except HomeAssistantError as error:
                    # One unit's failure mustn't stop the others; the next
                    # update tries again.
                    _LOGGER.warning(
                        "Couldn't command %s: %s", unit["entity_id"], error
                    )

    @callback
    def _check_manual_change(self, event: Event[EventStateChangedData]) -> None:
        """A live zone's unit changed to something HZT didn't ask for."""
        old, new = event.data["old_state"], event.data["new_state"]
        if old is None or new is None or new.state == STATE_UNAVAILABLE:
            return
        changed = old.state != new.state or old.attributes.get(
            ATTR_TEMPERATURE
        ) != new.attributes.get(ATTR_TEMPERATURE)
        if not changed:
            return
        for unit in self.store.config["room_units"]:
            if unit["entity_id"] != new.entity_id:
                continue
            zone = self.store.zone(unit["zone_id"])
            driver = self._drivers.get(unit["id"])
            if zone["shadow"] or driver is None or driver.last is None:
                continue
            now = dt_util.utcnow()
            if driver.is_ours(new, now):
                continue
            until = now + MANUAL_HOLD
            what = new.state
            temperature = new.attributes.get(ATTR_TEMPERATURE)
            if new.state != "off" and temperature is not None:
                what = f"{new.state} {temperature} °C"
            local = dt_util.as_local(until).strftime("%H:%M")
            self.manual[zone["id"]] = ManualOverride(
                until=until,
                reason=(
                    f"{unit['name']} was set to {what} by hand, so HZT "
                    f"leaves it alone until {local}. Change the target to "
                    "hand it back sooner."
                ),
            )
            # Re-learn what's there when driving resumes.
            driver.last = None
