import "../src/panel";
import "../src/card";

import type { Hass, HassEntity, HouseConfig } from "../src/hass";
import {
  AREA_OF,
  AREAS,
  CATEGORY_OF,
  DEVICE_OF,
  FIXTURES,
  type Fixture,
} from "./fixtures";

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

// A day of a zone's history: the room drifting up through the afternoon,
// cooling for a while, then settling. Compressed rows, as HA sends them.
function fakeHistory(entityIds: string[]) {
  const now = Date.now() / 1000;
  const result: Record<string, unknown[]> = {};
  for (const entityId of entityIds) {
    if (typeof states[entityId]?.attributes.hzt_zone_id !== "string") {
      continue; // a sensor: filled in from its zone below
    }
    const attributes = states[entityId]?.attributes ?? {};
    const target = Number(attributes.temperature ?? 22);
    const band = Number(attributes.idle_band ?? 1.5);
    const rows = [];
    for (let i = 0; i <= 96; i++) {
      const hours = 24 - i / 4;
      const room = target + 0.6 + 1.8 * Math.sin((i / 96) * Math.PI * 1.6);
      const zoneState =
        room > target + band / 2
          ? "cooling"
          : room < target - band / 2
            ? "heating"
            : "idle";
      rows.push({
        s: "heat_cool",
        a: {
          current_temperature: Math.round(room * 10) / 10,
          temperature: target,
          idle_band: band,
          zone_state: zoneState,
        },
        lu: now - hours * 3600,
      });
    }
    result[entityId] = rows;
    // Its units' devices: the first in each order runs with the zone, the
    // second joins only in the last stretch of heating.
    const units = (attributes.units ?? []) as {
      entity_id: string;
      kind: string;
      heat_rank: number | null;
      cool_rank: number | null;
    }[];
    for (const unit of units) {
      result[unit.entity_id] = rows.map((row, i) => {
        const zoneState = row.a.zone_state;
        const runs =
          (zoneState === "heating" &&
            (unit.heat_rank === 1 || (unit.heat_rank === 2 && i > 90))) ||
          (zoneState === "cooling" && unit.cool_rank === 1);
        if (unit.kind === "switch") {
          return { s: runs ? "on" : "off", a: {}, lu: row.lu };
        }
        const action = runs ? zoneState : "idle";
        return { s: "heat_cool", a: { hvac_action: action }, lu: row.lu };
      });
    }
    // The room sensor, if the zone has one: the same curve as its state.
    const sensor = states[entityId]?.attributes.room_sensor;
    if (typeof sensor === "string") {
      result[sensor] = rows.map((row) => ({
        s: String(row.a.current_temperature),
        lu: row.lu,
      }));
    }
  }
  return result;
}

function makeHass(): Hass {
  return {
    states,
    entities: Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(DEVICE_OF),
          ...Object.keys(CATEGORY_OF),
          ...Object.keys(AREA_OF),
        ]),
      ].map((entityId) => [
        entityId,
        {
          device_id: DEVICE_OF[entityId] ?? null,
          area_id: AREA_OF[entityId] ?? null,
          entity_category: CATEGORY_OF[entityId] ?? null,
        },
      ]),
    ),
    areas: AREAS,
    callWS<T>(message: { type: string; [key: string]: unknown }): Promise<T> {
      window.hztCalls.push(message);
      if (fixture.error) {
        return Promise.reject(new Error(fixture.error));
      }
      if (message.type === "hybrid_zone_thermostat/config") {
        return Promise.resolve(config as T);
      }
      if (message.type === "history/history_during_period") {
        return Promise.resolve(
          fakeHistory(message.entity_ids as string[]) as T,
        );
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
      } else if (service === "set_idle_band") {
        setAttribute(entityId, { idle_band: data.idle_band });
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
