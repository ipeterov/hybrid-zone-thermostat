import "../src/panel";

import type { Hass, HassEntity, HouseConfig } from "../src/hass";

// A test sets `window.hztFixture` (via page.addInitScript) to choose what
// the fake backend holds; without one, the house is empty. Every websocket
// message the panel sends lands in `window.hztCalls`.
declare global {
  interface Window {
    hztFixture?: {
      config?: HouseConfig;
      states?: HassEntity[];
      error?: string;
    };
    hztCalls: { type: string; [key: string]: unknown }[];
  }
}

const fixture = window.hztFixture ?? {};
window.hztCalls = [];

let config: HouseConfig = fixture.config ?? {
  house: { outdoor_sensor: null },
  zones: [],
  room_units: [],
  central_units: [],
};

const hass: Hass = {
  states: Object.fromEntries(
    (fixture.states ?? []).map((entity) => [entity.entity_id, entity]),
  ),
  callWS<T>(message: { type: string; [key: string]: unknown }): Promise<T> {
    window.hztCalls.push(message);
    if (fixture.error) {
      return Promise.reject(new Error(fixture.error));
    }
    if (message.type === "hybrid_zone_thermostat/config") {
      return Promise.resolve(config as T);
    }
    if (message.type === "hybrid_zone_thermostat/config/save") {
      config = message.config as HouseConfig;
      return Promise.resolve(config as T);
    }
    return Promise.reject(new Error(`Unknown command ${message.type}`));
  },
};

const panel = document.createElement("hzt-panel") as HTMLElement & {
  hass?: Hass;
};
panel.hass = hass;
document.body.append(panel);
