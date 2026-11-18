"""Names shared across the integration."""

from typing import Final

DOMAIN: Final = "hybrid_zone_thermostat"
NAME: Final = "Hybrid Zone Thermostat"

# The sidebar page, and the URL its files are served from.
PANEL_URL_PATH: Final = "climate-zones"
PANEL_TITLE: Final = "Climate zones"
PANEL_ICON: Final = "mdi:home-thermometer"
PANEL_ELEMENT: Final = "hzt-panel"
FRONTEND_URL: Final = f"/{DOMAIN}/frontend"

STORAGE_VERSION: Final = 1
STORAGE_KEY: Final = DOMAIN
