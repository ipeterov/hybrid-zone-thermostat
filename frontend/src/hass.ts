// The slice of Home Assistant's frontend `hass` object we use. HA doesn't
// publish types for it, so this grows as the panel needs more.

export interface Hass {
  callWS<T>(message: { type: string; [key: string]: unknown }): Promise<T>;
}

export interface HouseConfig {
  zones: Zone[];
  room_units: unknown[];
  central_units: unknown[];
}

export interface Zone {
  id: string;
  name: string;
}

export const DOMAIN = "hybrid_zone_thermostat";
