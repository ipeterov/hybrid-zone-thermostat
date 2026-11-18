// The slice of Home Assistant's frontend `hass` object we use. HA doesn't
// publish types for it, so this grows as the panel needs more.

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

export interface Hass {
  states: Record<string, HassEntity>;
  callWS<T>(message: { type: string; [key: string]: unknown }): Promise<T>;
}

// The stored config (custom_components/.../storage.py), as the backend
// sends it.
export interface HouseConfig {
  house: { outdoor_sensor: string | null };
  zones: Zone[];
  room_units: RoomUnit[];
  central_units: unknown[];
}

export interface Zone {
  id: string;
  name: string;
  room_sensor: string | null;
  target: number;
  idle_band: number;
  enabled: boolean;
  heating_order: string[];
  cooling_order: string[];
}

export interface RoomUnit {
  id: string;
  name: string;
  entity_id: string;
  zone_id: string;
  can_heat: boolean;
  can_cool: boolean;
}

export const DOMAIN = "hybrid_zone_thermostat";

export function friendlyName(hass: Hass, entityId: string): string {
  const name = hass.states[entityId]?.attributes.friendly_name;
  return typeof name === "string" ? name : entityId;
}
