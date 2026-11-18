"""What the panel reads and writes."""

from typing import Any

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

import probatio

from .const import DOMAIN
from .storage import ConfigStore


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_get_config)


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
    store: ConfigStore | None = hass.data.get(DOMAIN)
    if store is None:
        connection.send_error(
            msg["id"], "not_loaded", "Hybrid Zone Thermostat isn't set up."
        )
        return
    connection.send_result(msg["id"], store.config)
