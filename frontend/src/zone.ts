// Reading a zone's climate entity: everything HZT puts on it for the card
// and the panel (custom_components/.../climate.py, extra_state_attributes).

import type { HassEntity } from "./hass";

export interface ZoneUnit {
  id: string;
  name: string;
  entity_id: string;
  heat_rank: number | null;
  cool_rank: number | null;
  available: boolean;
  heat_locked: boolean;
  cool_locked: boolean;
  heat_lockout_below: number | null;
  cool_lockout_below: number | null;
  note: string | null;
}

export interface Demand {
  mode: "heat" | "cool" | null;
  level: number;
}

export interface Zone {
  id: string;
  entityId: string;
  name: string;
  enabled: boolean;
  state?: string;
  shadow: boolean;
  room?: number;
  target?: number;
  idleBand: number;
  roomSensor: string | null;
  reason?: string;
  units: ZoneUnit[];
  demands: Record<string, Demand>;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function readZone(entity: HassEntity): Zone {
  const a = entity.attributes;
  const name = a.friendly_name;
  return {
    id: typeof a.hzt_zone_id === "string" ? a.hzt_zone_id : "",
    entityId: entity.entity_id,
    name: typeof name === "string" ? name : entity.entity_id,
    enabled: entity.state !== "off",
    state: typeof a.zone_state === "string" ? a.zone_state : undefined,
    shadow: a.shadow === true,
    room: num(a.current_temperature),
    target: num(a.temperature),
    idleBand: num(a.idle_band) ?? 1.5,
    roomSensor: typeof a.room_sensor === "string" ? a.room_sensor : null,
    reason: typeof a.reason === "string" ? a.reason : undefined,
    units: Array.isArray(a.units) ? (a.units as ZoneUnit[]) : [],
    demands:
      typeof a.demands === "object" && a.demands
        ? (a.demands as Record<string, Demand>)
        : {},
  };
}

export function isZone(entity: HassEntity | undefined): entity is HassEntity {
  if (!entity) {
    return false;
  }
  return (
    entity.entity_id.startsWith("climate.") &&
    typeof entity.attributes.hzt_zone_id === "string"
  );
}

// The zone's state in a few words, honest about shadow mode.
export function zoneWord(zone: Zone): string | undefined {
  switch (zone.state) {
    case "heating":
      return zone.shadow ? "Would heat" : "Heating";
    case "cooling":
      return zone.shadow ? "Would cool" : "Cooling";
    case "idle":
      return "Idle · in band";
    case "off":
      return "Off";
    case "fault":
      return "No room temperature";
    case "manual":
      return "Manual";
    default:
      return zone.state;
  }
}

// What one unit is doing, in a few words.
export function unitWord(zone: Zone, unit: ZoneUnit): string {
  const demand = zone.demands[unit.id];
  if (!unit.available) {
    return "Unavailable";
  }
  if (demand?.mode) {
    const verb = demand.mode;
    return zone.shadow
      ? `Would ${verb}`
      : `${verb === "heat" ? "Heating" : "Cooling"}`;
  }
  if (zone.state === "heating" && unit.heat_locked) {
    return "Locked out";
  }
  if (zone.state === "cooling" && unit.cool_locked) {
    return "Locked out";
  }
  if (zone.state === "heating" || zone.state === "cooling") {
    return "Standby";
  }
  if (zone.state === "manual") {
    return "Manual";
  }
  return zone.state === "off" ? "Off" : "Idle";
}

export function degrees(value: number): string {
  return `${value.toFixed(1).replace("-", "−")} °C`;
}

export function wholeDegrees(value: number): string {
  return `${String(value).replace("-", "−")} °C`;
}
