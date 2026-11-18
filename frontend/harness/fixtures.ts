// Houses the harness can show: tests pass one through window.hztFixture,
// and a person opens one with ?fixture=<name> to look at the panel.

import type { HassEntity, HouseConfig } from "../src/hass";

export interface Fixture {
  config?: HouseConfig;
  states?: HassEntity[];
  error?: string;
}

function temperature(id: string, name: string, value: string): HassEntity {
  return {
    entity_id: id,
    state: value,
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

function zoneStatus(
  id: string,
  zoneId: string,
  attributes: Record<string, unknown>,
): HassEntity {
  return {
    entity_id: id,
    state: "heat_cool",
    attributes: { hzt_zone_id: zoneId, shadow: true, ...attributes },
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
  climate("climate.living_room_hisense_ac", "Hisense AC", [
    "cool",
    "heat",
    "fan_only",
    "dry",
  ]),
  climate("climate.living_room_trv", "Living room radiator", ["heat"]),
  climate("climate.bedroom_trv", "Bedroom radiator", ["heat"]),
  climate("climate.entryway_trv", "Entryway radiator", ["heat"]),
];

const LIVING_ROOM_ZONE = {
  id: "living_room",
  name: "Living room",
  room_sensor: "sensor.co2_monitor_temperature",
  target: 22,
  idle_band: 1.5,
  enabled: true,
  heating_order: ["hisense_ac", "living_room_radiator"],
  cooling_order: ["hisense_ac"],
};

export const LIVING_ROOM: HouseConfig = {
  house: { outdoor_sensor: "sensor.outdoor_temperature" },
  zones: [LIVING_ROOM_ZONE],
  room_units: [
    {
      id: "hisense_ac",
      name: "Hisense AC",
      entity_id: "climate.living_room_hisense_ac",
      zone_id: "living_room",
      can_heat: true,
      can_cool: true,
    },
    {
      id: "living_room_radiator",
      name: "Living room radiator",
      entity_id: "climate.living_room_trv",
      zone_id: "living_room",
      can_heat: true,
      can_cool: false,
    },
  ],
  central_units: [],
};

const LIVING_ROOM_STATUS = zoneStatus("climate.living_room", "living_room", {
  zone_state: "heating",
  current_temperature: 21.4,
  temperature: 22,
  reason: "0.6 °C below 22.0, demand 30%: #1 Hisense AC.",
  demands: {
    hisense_ac: { mode: "heat", level: 0.6 },
    living_room_radiator: { mode: null, level: 0 },
  },
});

export const HOUSE: HouseConfig = {
  house: { outdoor_sensor: "sensor.outdoor_temperature" },
  zones: [
    LIVING_ROOM_ZONE,
    {
      id: "bedroom",
      name: "Bedroom",
      room_sensor: "sensor.bedroom_temperature",
      target: 20,
      idle_band: 1.5,
      enabled: true,
      heating_order: ["bedroom_radiator"],
      cooling_order: [],
    },
    {
      id: "entryway",
      name: "Entryway",
      room_sensor: "sensor.entryway_temperature",
      target: 18,
      idle_band: 1.5,
      enabled: false,
      heating_order: ["entryway_radiator"],
      cooling_order: [],
    },
  ],
  room_units: [
    ...LIVING_ROOM.room_units,
    {
      id: "bedroom_radiator",
      name: "Bedroom radiator",
      entity_id: "climate.bedroom_trv",
      zone_id: "bedroom",
      can_heat: true,
      can_cool: false,
    },
    {
      id: "entryway_radiator",
      name: "Entryway radiator",
      entity_id: "climate.entryway_trv",
      zone_id: "entryway",
      can_heat: true,
      can_cool: false,
    },
  ],
  central_units: [],
};

export const FIXTURES: Record<string, Fixture> = {
  empty: { states: DEVICES },
  "living-room": {
    config: LIVING_ROOM,
    states: [...DEVICES, LIVING_ROOM_STATUS],
  },
  house: {
    config: HOUSE,
    states: [
      ...DEVICES,
      LIVING_ROOM_STATUS,
      zoneStatus("climate.bedroom", "bedroom", {
        zone_state: "idle",
        current_temperature: 19.8,
        temperature: 20,
        reason: "19.8 °C is between 20.0 and 21.5: nothing needs to run.",
        demands: { bedroom_radiator: { mode: null, level: 0 } },
      }),
      zoneStatus("climate.entryway", "entryway", {
        zone_state: "off",
        current_temperature: 16.1,
        temperature: 18,
        reason: "Zone is off.",
        demands: { entryway_radiator: { mode: null, level: 0 } },
      }),
    ],
  },
};
