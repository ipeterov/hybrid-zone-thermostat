// Pure edits of the house config. Each returns a new config; the panel
// saves it. Kept out of the element so the rules are in one place.

import type { HouseConfig, RoomUnit, Zone } from "./hass";

export function slug(name: string, taken: Iterable<string>): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "zone";
  const used = new Set(taken);
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) {
    candidate = `${base}_${n}`;
  }
  return candidate;
}

// A zone's units in its order. One order per zone for now: heating and
// cooling orders are this list, filtered to the units that can.
export function unitsOf(config: HouseConfig, zoneId: string): RoomUnit[] {
  return config.room_units.filter((unit) => unit.zone_id === zoneId);
}

function withOrders(config: HouseConfig): HouseConfig {
  return {
    ...config,
    zones: config.zones.map((zone) => {
      const units = unitsOf(config, zone.id);
      return {
        ...zone,
        heating_order: units.filter((u) => u.can_heat).map((u) => u.id),
        cooling_order: units.filter((u) => u.can_cool).map((u) => u.id),
      };
    }),
  };
}

export function setOutdoorSensor(
  config: HouseConfig,
  entityId: string | null,
): HouseConfig {
  return { ...config, house: { ...config.house, outdoor_sensor: entityId } };
}

export function addZone(
  config: HouseConfig,
  name: string,
  roomSensor: string | null,
): HouseConfig {
  const zone: Zone = {
    id: slug(
      name,
      config.zones.map((z) => z.id),
    ),
    name,
    room_sensor: roomSensor,
    target: 21,
    idle_band: 1.5,
    enabled: true,
    heating_order: [],
    cooling_order: [],
  };
  return { ...config, zones: [...config.zones, zone] };
}

export function removeZone(config: HouseConfig, zoneId: string): HouseConfig {
  return {
    ...config,
    zones: config.zones.filter((zone) => zone.id !== zoneId),
    room_units: config.room_units.filter((unit) => unit.zone_id !== zoneId),
  };
}

export function updateZone(
  config: HouseConfig,
  zoneId: string,
  changes: Partial<Omit<Zone, "id">>,
): HouseConfig {
  return {
    ...config,
    zones: config.zones.map((zone) =>
      zone.id === zoneId ? { ...zone, ...changes } : zone,
    ),
  };
}

export function addRoomUnit(
  config: HouseConfig,
  unit: Omit<RoomUnit, "id">,
): HouseConfig {
  const id = slug(
    unit.name,
    config.room_units.map((u) => u.id),
  );
  return withOrders({
    ...config,
    room_units: [...config.room_units, { ...unit, id }],
  });
}

export function removeRoomUnit(
  config: HouseConfig,
  unitId: string,
): HouseConfig {
  return withOrders({
    ...config,
    room_units: config.room_units.filter((unit) => unit.id !== unitId),
  });
}

// Moves a unit one place earlier (-1) or later (+1) among its zone's units.
export function moveRoomUnit(
  config: HouseConfig,
  unitId: string,
  step: -1 | 1,
): HouseConfig {
  const unit = config.room_units.find((u) => u.id === unitId);
  if (!unit) {
    return config;
  }
  const siblings = unitsOf(config, unit.zone_id);
  const from = siblings.indexOf(unit);
  const to = from + step;
  const other = siblings[to];
  if (!other) {
    return config;
  }
  const units = [...config.room_units];
  const a = units.indexOf(unit);
  const b = units.indexOf(other);
  units[a] = other;
  units[b] = unit;
  return withOrders({ ...config, room_units: units });
}
