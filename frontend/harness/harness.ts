import "../src/panel";
import "../src/card";

import type { Hass, HassEntity, HouseConfig } from "../src/hass";
import { DEVICE_OF, FIXTURES, type Fixture } from "./fixtures";

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

let states: Record<string, HassEntity> = Object.fromEntries(
  (fixture.states ?? []).map((entity) => [entity.entity_id, entity]),
);

// Elements showing `hass`; each gets a new object when states change, as
// HA does, so Lit re-renders.
const views: (HTMLElement & { hass?: Hass })[] = [];

function setAttribute(entityId: string, changes: Record<string, unknown>) {
  const entity = states[entityId];
  if (!entity) {
    return;
  }
  states = {
    ...states,
    [entityId]: { ...entity, attributes: { ...entity.attributes, ...changes } },
  };
  const next = makeHass();
  for (const view of views) {
    view.hass = next;
  }
}

function makeHass(): Hass {
  return {
    states,
    entities: Object.fromEntries(
      Object.entries(DEVICE_OF).map(([entityId, device]) => [
        entityId,
        { device_id: device },
      ]),
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
    callService(domain, service, data = {}) {
      window.hztCalls.push({ type: "call_service", domain, service, data });
      const entityId = String(data.entity_id ?? "");
      if (service === "set_temperature") {
        setAttribute(entityId, { temperature: data.temperature });
      } else if (service === "set_fan_mode") {
        setAttribute(entityId, { fan_mode: data.fan_mode });
      } else if (service === "set_swing_mode") {
        setAttribute(entityId, { swing_mode: data.swing_mode });
      }
      return Promise.resolve();
    },
  };
}

const hass = makeHass();

// What HA's frontend would do with these: open a dialog, change page.
document.addEventListener("hass-more-info", (event) => {
  window.hztCalls.push({
    type: "more-info",
    entityId: (event as CustomEvent).detail.entityId,
  });
});
window.addEventListener("location-changed", () => {
  window.hztCalls.push({
    type: "navigate",
    path: location.pathname + location.search,
  });
});

if (params.get("view") === "card") {
  // Every zone's card, laid out like a dashboard section.
  const grid = document.createElement("div");
  grid.className = "dashboard";
  for (const entity of Object.values(states)) {
    if (typeof entity.attributes.hzt_zone_id !== "string") {
      continue;
    }
    const card = document.createElement("hzt-zone-card") as HTMLElement & {
      hass?: Hass;
      setConfig(config: { type: string; entity: string }): void;
    };
    card.setConfig({ type: "custom:hzt-zone-card", entity: entity.entity_id });
    card.hass = hass;
    views.push(card);
    grid.append(card);
  }
  document.body.append(grid);
} else {
  const panel = document.createElement("hzt-panel") as HTMLElement & {
    hass?: Hass;
    narrow?: boolean;
  };
  panel.hass = hass;
  views.push(panel);
  // HA hides its sidebar, and calls the panel narrow, below 870 px.
  const narrowQuery = window.matchMedia("(max-width: 870px)");
  panel.narrow = narrowQuery.matches;
  narrowQuery.addEventListener("change", (event) => {
    panel.narrow = event.matches;
  });
  document.body.append(panel);
}
