// Houses the harness can show: tests pass one through window.hztFixture,
// and a person opens one with ?fixture=<name> to look at the panel.

import type { HassEntity, HouseConfig, RoomUnit, Zone } from "../src/hass";

export interface Fixture {
  config?: HouseConfig;
  states?: HassEntity[];
  error?: string;
}

function temperature(id: string, name: string, value: string): HassEntity {
  return {
    entity_id: id,
    state: value,
    last_updated: new Date(Date.now() - 40_000).toISOString(),
    attributes: {
      friendly_name: name,
      device_class: "temperature",
      unit_of_measurement: "°C",
    },
  };
}

function climate(id: string, name: string, modes: string[]): HassEntity {
  return {
    entity_id: id,
    state: "off",
    attributes: { friendly_name: name, hvac_modes: ["off", ...modes] },
  };
}

function zone(fields: Partial<Zone> & Pick<Zone, "id" | "name">): Zone {
  return {
    room_sensor: null,
    target: 21,
    idle_band: 1.5,
    enabled: true,
    shadow: true,
    heating_order: [],
    cooling_order: [],
    ...fields,
  };
}

function unit(
  fields: Partial<RoomUnit> &
    Pick<RoomUnit, "id" | "name" | "entity_id" | "zone_id">,
): RoomUnit {
  return {
    can_heat: true,
    can_cool: false,
    heat_lockout_below: null,
    cool_lockout_below: null,
    min_run: 6,
    min_rest: 4,
    ...fields,
  };
}

interface StatusFields {
  zone_state: string;
  current_temperature?: number;
  temperature: number;
  reason: string;
  shadow?: boolean;
  demands: Record<string, { mode: string | null; level: number }>;
  units?: Record<string, Record<string, unknown>>;
}

// A zone's climate entity as HZT would publish it for `config`.
function zoneStatus(
  config: HouseConfig,
  zoneId: string,
  fields: StatusFields,
): HassEntity {
  const zoneConfig = config.zones.find((z) => z.id === zoneId) as Zone;
  const units = config.room_units
    .filter((u) => u.zone_id === zoneId)
    .map((u) => ({
      id: u.id,
      name: u.name,
      entity_id: u.entity_id,
      heat_rank: zoneConfig.heating_order.indexOf(u.id) + 1 || null,
      cool_rank: zoneConfig.cooling_order.indexOf(u.id) + 1 || null,
      available: true,
      heat_locked: false,
      cool_locked: false,
      heat_lockout_below: u.heat_lockout_below,
      cool_lockout_below: u.cool_lockout_below,
      note: null,
      ...fields.units?.[u.id],
    }));
  const { units: _ignored, ...rest } = fields;
  return {
    entity_id: `climate.${zoneId}`,
    state: zoneConfig.enabled ? "heat_cool" : "off",
    attributes: {
      friendly_name: zoneConfig.name,
      hzt_zone_id: zoneId,
      shadow: zoneConfig.shadow,
      idle_band: zoneConfig.idle_band,
      room_sensor: zoneConfig.room_sensor,
      ...rest,
      units,
    },
  };
}

export const DEVICES: HassEntity[] = [
  temperature(
    "sensor.co2_monitor_temperature",
    "CO2 Monitor Temperature",
    "21.4",
  ),
  temperature("sensor.outdoor_temperature", "Outdoor temperature", "7.2"),
  temperature("sensor.bedroom_temperature", "Bedroom temperature", "19.8"),
  temperature("sensor.entryway_temperature", "Entryway temperature", "16.1"),
  {
    entity_id: "sensor.co2_monitor_co2",
    state: "640",
    attributes: {
      friendly_name: "CO2 Monitor CO2",
      device_class: "carbon_dioxide",
    },
  },
  {
    ...climate("climate.living_room_hisense_ac", "Hisense AC", [
      "cool",
      "heat",
      "fan_only",
      "dry",
    ]),
    attributes: {
      friendly_name: "Hisense AC",
      hvac_modes: ["off", "cool", "heat", "fan_only", "dry"],
      fan_modes: ["auto", "low", "medium", "high", "quiet"],
      swing_modes: ["off", "both", "vertical", "horizontal"],
      fan_mode: "auto",
      swing_mode: "vertical",
      temperature: 23,
      current_temperature: 24,
    },
  },
  climate("climate.living_room_trv", "Living room radiator", ["heat"]),
  climate("climate.bedroom_trv", "Bedroom radiator", ["heat"]),
  climate("climate.entryway_trv", "Entryway radiator", ["heat"]),
];

const HISENSE = unit({
  id: "hisense_ac",
  name: "Hisense AC",
  entity_id: "climate.living_room_hisense_ac",
  zone_id: "living_room",
  can_cool: true,
  heat_lockout_below: -15,
});

const LIVING_ROOM_RADIATOR = unit({
  id: "living_room_radiator",
  name: "Living room radiator",
  entity_id: "climate.living_room_trv",
  zone_id: "living_room",
});

const LIVING_ROOM_ZONE = zone({
  id: "living_room",
  name: "Living room",
  room_sensor: "sensor.co2_monitor_temperature",
  target: 22,
  heating_order: ["hisense_ac", "living_room_radiator"],
  cooling_order: ["hisense_ac"],
});

export const LIVING_ROOM: HouseConfig = {
  house: { outdoor_sensor: "sensor.outdoor_temperature" },
  zones: [LIVING_ROOM_ZONE],
  room_units: [HISENSE, LIVING_ROOM_RADIATOR],
  central_units: [],
};

const LIVING_ROOM_STATUS = zoneStatus(LIVING_ROOM, "living_room", {
  zone_state: "heating",
  current_temperature: 21.4,
  temperature: 22,
  reason: "0.6 °C below 22.0, demand 30%: #1 Hisense AC.",
  demands: {
    hisense_ac: { mode: "heat", level: 0.6 },
    living_room_radiator: { mode: null, level: 0 },
  },
});

// The owner's house today: one zone, one AC.
export const JUST_THE_AC: HouseConfig = {
  house: { outdoor_sensor: "sensor.outdoor_temperature" },
  zones: [{ ...LIVING_ROOM_ZONE, target: 23, heating_order: ["hisense_ac"] }],
  room_units: [{ ...HISENSE, heat_lockout_below: null }],
  central_units: [],
};

const JUST_THE_AC_STATUS = zoneStatus(JUST_THE_AC, "living_room", {
  zone_state: "cooling",
  current_temperature: 27.6,
  temperature: 23,
  reason: "3.1 °C above 24.5, demand 100%: #1 Hisense AC.",
  demands: { hisense_ac: { mode: "cool", level: 1 } },
});

export const HOUSE: HouseConfig = {
  house: { outdoor_sensor: "sensor.outdoor_temperature" },
  zones: [
    LIVING_ROOM_ZONE,
    zone({
      id: "bedroom",
      name: "Bedroom",
      room_sensor: "sensor.bedroom_temperature",
      target: 20,
      heating_order: ["bedroom_radiator"],
    }),
    zone({
      id: "entryway",
      name: "Entryway",
      room_sensor: "sensor.entryway_temperature",
      target: 18,
      enabled: false,
      heating_order: ["entryway_radiator"],
    }),
  ],
  room_units: [
    HISENSE,
    LIVING_ROOM_RADIATOR,
    unit({
      id: "bedroom_radiator",
      name: "Bedroom radiator",
      entity_id: "climate.bedroom_trv",
      zone_id: "bedroom",
    }),
    unit({
      id: "entryway_radiator",
      name: "Entryway radiator",
      entity_id: "climate.entryway_trv",
      zone_id: "entryway",
    }),
  ],
  central_units: [],
};

const HOUSE_STATES = [
  ...DEVICES,
  LIVING_ROOM_STATUS,
  zoneStatus(HOUSE, "bedroom", {
    zone_state: "idle",
    current_temperature: 19.8,
    temperature: 20,
    reason: "19.8 °C is between 20.0 and 21.5: nothing needs to run.",
    demands: { bedroom_radiator: { mode: null, level: 0 } },
  }),
  zoneStatus(HOUSE, "entryway", {
    zone_state: "off",
    current_temperature: 16.1,
    temperature: 18,
    reason: "Zone is off.",
    demands: { entryway_radiator: { mode: null, level: 0 } },
  }),
];

export const FIXTURES: Record<string, Fixture> = {
  empty: { states: DEVICES },
  "just-the-ac": {
    config: JUST_THE_AC,
    states: [...DEVICES, JUST_THE_AC_STATUS],
  },
  "living-room": {
    config: LIVING_ROOM,
    states: [...DEVICES, LIVING_ROOM_STATUS],
  },
  live: {
    config: {
      ...JUST_THE_AC,
      zones: JUST_THE_AC.zones.map((z) => ({ ...z, shadow: false })),
    },
    states: [
      ...DEVICES,
      {
        ...JUST_THE_AC_STATUS,
        attributes: { ...JUST_THE_AC_STATUS.attributes, shadow: false },
      },
    ],
  },
  "locked-out": {
    config: LIVING_ROOM,
    states: [
      ...DEVICES.map((e) =>
        e.entity_id === "sensor.outdoor_temperature"
          ? { ...e, state: "-18" }
          : e,
      ),
      zoneStatus(LIVING_ROOM, "living_room", {
        zone_state: "heating",
        current_temperature: 20.9,
        temperature: 22,
        reason: "1.1 °C below 22.0, demand 55%: #1 Living room radiator.",
        demands: {
          hisense_ac: { mode: null, level: 0 },
          living_room_radiator: { mode: "heat", level: 0.55 },
        },
        units: { hisense_ac: { heat_locked: true } },
      }),
    ],
  },
  "no-outdoor-sensor": {
    config: { ...JUST_THE_AC, house: { outdoor_sensor: null } },
    states: [...DEVICES, JUST_THE_AC_STATUS],
  },
  house: { config: HOUSE, states: HOUSE_STATES },
};
