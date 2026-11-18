import "../src/panel";

import type { Hass, HouseConfig } from "../src/hass";
import { FIXTURES, type Fixture } from "./fixtures";

// A test sets `window.hztFixture` (via page.addInitScript) to choose what
// the fake backend holds; a person opens ?fixture=<name> (fixtures.ts).
// Without either, the house is empty. Every websocket message the panel
// sends lands in `window.hztCalls`.
declare global {
  interface Window {
    hztFixture?: Fixture;
    hztCalls: { type: string; [key: string]: unknown }[];
  }
}

const params = new URLSearchParams(location.search);
const named = params.get("fixture");

// HA's default dark theme's variables, so the panel can be seen as it is
// on a dark HA (?theme=dark). Light uses the panel's own fallbacks.
if (params.get("theme") === "dark") {
  const dark: Record<string, string> = {
    "--primary-background-color": "#111111",
    "--card-background-color": "#1c1c1c",
    "--secondary-background-color": "#282828",
    "--primary-text-color": "#e1e1e1",
    "--secondary-text-color": "#9b9b9b",
    "--divider-color": "rgba(225, 225, 225, 0.12)",
    "--primary-color": "#03a9f4",
    "--error-color": "#ef5350",
  };
  for (const [name, value] of Object.entries(dark)) {
    document.documentElement.style.setProperty(name, value);
  }
  document.body.style.background = dark["--primary-background-color"] ?? "";
}

const fixture = window.hztFixture ?? FIXTURES[named ?? "empty"] ?? {};
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
