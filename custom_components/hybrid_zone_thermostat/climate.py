"""One climate entity per zone: the one control a room has."""

from typing import Any

from homeassistant.components.climate import (
    ClimateEntity,
    ClimateEntityFeature,
    HVACAction,
    HVACMode,
)
from homeassistant.const import (
    ATTR_TEMPERATURE,
    MAJOR_VERSION,
    MINOR_VERSION,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_platform
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

import probatio

from . import HztConfigEntry
from .control import ZoneState
from .drivers import SWITCH_DOMAINS
from .entity import ZoneEntity

# HA 2026.11 renamed climate temperatures to native_* and warns about the
# old names; the test harness's HA (2026.10) only knows the old ones. The
# entity provides native_* and, on an older HA, the old names too. Drop
# the old names once the tests run on 2026.11 (`uv run dev bump-ha`).
NATIVE_TEMPERATURES = (MAJOR_VERSION, MINOR_VERSION) >= (2026, 11)

SERVICE_SET_IDLE_BAND = "set_idle_band"

_ACTIONS = {
    ZoneState.HEATING: HVACAction.HEATING,
    ZoneState.COOLING: HVACAction.COOLING,
    ZoneState.IDLE: HVACAction.IDLE,
    ZoneState.OFF: HVACAction.OFF,
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: HztConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    engine = entry.runtime_data
    # The card drags the band's cooling edge; config saves are admin-only,
    # and this is a zone's everyday setting like its target.
    entity_platform.async_get_current_platform().async_register_entity_service(
        SERVICE_SET_IDLE_BAND,
        {
            probatio.Required("idle_band"): probatio.All(
                probatio.Coerce(float), probatio.Range(min=0.5, max=5)
            )
        },
        "async_set_idle_band",
    )
    async_add_entities(
        ZoneClimate(engine, entry.entry_id, zone["id"])
        for zone in engine.store.config["zones"]
    )


class ZoneClimate(ZoneEntity, ClimateEntity):
    """One target per zone; heat or cool is the controller's call, so the
    only modes are on (heat_cool) and off."""

    _attr_name = None
    _attr_hvac_modes = [HVACMode.HEAT_COOL, HVACMode.OFF]  # noqa: RUF012
    _attr_supported_features = (
        ClimateEntityFeature.TARGET_TEMPERATURE
        | ClimateEntityFeature.TURN_ON
        | ClimateEntityFeature.TURN_OFF
    )
    _attr_native_temperature_unit = UnitOfTemperature.CELSIUS
    _attr_target_temperature_step = 0.5
    _attr_min_temp = 5
    _attr_max_temp = 35

    def __init__(self, engine: Any, entry_id: str, zone_id: str) -> None:
        super().__init__(engine, entry_id, zone_id)
        self._attr_unique_id = f"{entry_id}_{zone_id}_climate"

    @property
    def hvac_mode(self) -> HVACMode:
        enabled = self.engine.store.zone(self.zone_id)["enabled"]
        return HVACMode.HEAT_COOL if enabled else HVACMode.OFF

    @property
    def hvac_action(self) -> HVACAction | None:
        decision = self.zone_decision
        if decision is None:
            return None
        if decision.state is ZoneState.OFF:
            return HVACAction.OFF
        # In shadow mode nothing runs, so claiming "heating" would be a lie.
        if self.engine.store.zone(self.zone_id)["shadow"]:
            return None
        return _ACTIONS.get(decision.state)

    @property
    def native_current_temperature(self) -> float | None:
        snapshot = self.zone_snapshot
        return snapshot.room_temperature if snapshot else None

    @property
    def native_target_temperature(self) -> float:
        return self.engine.store.zone(self.zone_id)["target"]

    if not NATIVE_TEMPERATURES:
        _attr_temperature_unit = UnitOfTemperature.CELSIUS
        current_temperature = native_current_temperature
        target_temperature = native_target_temperature

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Everything the zone card shows, so it needs no admin-only API."""
        decision = self.zone_decision
        zone = self.engine.store.zone(self.zone_id)
        heating = zone["heating_order"]
        cooling = zone["cooling_order"]
        units = []
        for unit in self.engine.store.config["room_units"]:
            if unit["zone_id"] != self.zone_id:
                continue
            status = self.engine.unit_status.get(unit["id"])
            units.append(
                {
                    "id": unit["id"],
                    "name": unit["name"],
                    "entity_id": unit["entity_id"],
                    "heat_rank": heating.index(unit["id"]) + 1
                    if unit["id"] in heating
                    else None,
                    "cool_rank": cooling.index(unit["id"]) + 1
                    if unit["id"] in cooling
                    else None,
                    "available": status.available if status else True,
                    "heat_locked": status.heat_locked if status else False,
                    "cool_locked": status.cool_locked if status else False,
                    "heat_lockout_below": unit["heat_lockout_below"],
                    "cool_lockout_below": unit["cool_lockout_below"],
                    "note": status.note if status else None,
                    "duty": status.duty if status else None,
                    "kind": "switch"
                    if unit["entity_id"].split(".", 1)[0] in SWITCH_DOMAINS
                    else "climate",
                    "cycle_minutes": unit["cycle_minutes"],
                }
            )
        return {
            "hzt_zone_id": self.zone_id,
            "zone_state": decision.state.value if decision else None,
            "reason": decision.reason if decision else None,
            "shadow": zone["shadow"],
            "idle_band": zone["idle_band"],
            "room_sensor": zone["room_sensor"],
            "units": units,
            "demands": {
                unit_id: {
                    "mode": demand.mode.value if demand.mode else None,
                    "level": round(demand.level, 3),
                }
                for unit_id, demand in decision.demands.items()
            }
            if decision
            else {},
        }

    async def async_set_temperature(self, **kwargs: Any) -> None:
        if (temperature := kwargs.get(ATTR_TEMPERATURE)) is not None:
            await self.engine.async_update_zone(
                self.zone_id, target=float(temperature)
            )

    async def async_set_idle_band(self, idle_band: float) -> None:
        await self.engine.async_update_zone(self.zone_id, idle_band=idle_band)

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        await self.engine.async_update_zone(
            self.zone_id, enabled=hvac_mode != HVACMode.OFF
        )

    async def async_turn_on(self) -> None:
        await self.async_set_hvac_mode(HVACMode.HEAT_COOL)

    async def async_turn_off(self) -> None:
        await self.async_set_hvac_mode(HVACMode.OFF)
