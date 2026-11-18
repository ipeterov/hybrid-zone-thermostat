import "../src/panel";

import type { Hass, HouseConfig } from "../src/hass";

// A test sets `window.hztFixture` (via page.addInitScript) to choose what
// the fake backend returns; without one, the house is empty.
declare global {
  interface Window {
    hztFixture?: { config?: HouseConfig; error?: string };
  }
}

const fixture = window.hztFixture ?? {};
const emptyHouse: HouseConfig = {
  zones: [],
  room_units: [],
  central_units: [],
};

const hass: Hass = {
  callWS<T>(message: { type: string }): Promise<T> {
    if (message.type !== "hybrid_zone_thermostat/config") {
      return Promise.reject(new Error(`Unknown command ${message.type}`));
    }
    if (fixture.error) {
      return Promise.reject(new Error(fixture.error));
    }
    return Promise.resolve((fixture.config ?? emptyHouse) as T);
  },
};

const panel = document.createElement("hzt-panel") as HTMLElement & {
  hass?: Hass;
};
panel.hass = hass;
document.body.append(panel);
