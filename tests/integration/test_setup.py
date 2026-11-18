from homeassistant import config_entries
from homeassistant.components.frontend import DATA_PANELS
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.setup import async_setup_component

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.hybrid_zone_thermostat.const import (
    DOMAIN,
    PANEL_URL_PATH,
)


async def test_config_flow_creates_the_one_entry(hass: HomeAssistant):
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {}
    )

    assert result["type"] is FlowResultType.CREATE_ENTRY


async def test_the_panel_survives_a_reload_and_goes_with_the_entry(
    hass: HomeAssistant,
):
    await async_setup_component(hass, "http", {})
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)

    assert await hass.config_entries.async_setup(entry.entry_id)
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]

    # Saving settings reloads the entry; the person stays on the panel.
    assert await hass.config_entries.async_reload(entry.entry_id)
    assert PANEL_URL_PATH in hass.data[DATA_PANELS]

    assert await hass.config_entries.async_remove(entry.entry_id)
    assert PANEL_URL_PATH not in hass.data[DATA_PANELS]
