"""What the panel reads and writes."""

from typing import TYPE_CHECKING, Any

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

import probatio

from .const import DOMAIN
from .storage import InvalidConfig, validate_config

if TYPE_CHECKING:
    from .engine import Engine


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_get_config)
    websocket_api.async_register_command(hass, ws_save_config)


def _engine(hass: HomeAssistant) -> Engine | None:
    entries = hass.config_entries.async_loaded_entries(DOMAIN)
    return entries[0].runtime_data if entries else None


@websocket_api.require_admin
@websocket_api.websocket_command(
    {probatio.Required("type"): f"{DOMAIN}/config"}
)
@callback
def ws_get_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """The house's whole configuration."""
    engine = _engine(hass)
    if engine is None:
        connection.send_error(
            msg["id"], "not_loaded", "Hybrid Zone Thermostat isn't set up."
        )
        return
    connection.send_result(msg["id"], engine.store.config)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): f"{DOMAIN}/config/save",
        probatio.Required("config"): dict,
    }
)
@websocket_api.async_response
async def ws_save_config(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Replace the whole configuration, then reload so entities follow."""
    engine = _engine(hass)
    if engine is None:
        connection.send_error(
            msg["id"], "not_loaded", "Hybrid Zone Thermostat isn't set up."
        )
        return
    try:
        config = validate_config(msg["config"])
    except InvalidConfig as error:
        connection.send_error(msg["id"], "invalid_config", str(error))
        return
    await engine.store.async_save(config)
    entry = hass.config_entries.async_loaded_entries(DOMAIN)[0]
    hass.config_entries.async_schedule_reload(entry.entry_id)
    connection.send_result(msg["id"], config)
