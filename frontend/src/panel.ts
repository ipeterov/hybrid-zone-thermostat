import { html, LitElement, nothing } from "lit";

import {
  addRoomUnit,
  addZone,
  moveRoomUnit,
  removeRoomUnit,
  removeZone,
  setOutdoorSensor,
  unitsOf,
  updateRoomUnit,
  updateZone,
} from "./config";
import {
  areaName,
  DOMAIN,
  friendlyName,
  type Hass,
  type HassEntity,
  type HouseConfig,
  type RoomUnit,
  type Zone,
} from "./hass";
import { panelStyles } from "./panel-styles";
import { bandEdges, tenths } from "./zone";

// The Climate zones page (the canvas's "Settings, zones first"): the house
// is the page, each zone one card, each room unit a section of its zone.
// Nothing has a separate "create" screen: an add pill makes the thing in
// place, in an empty state that says what it needs, and filled in it's
// the same card's edit view. Settings off by default wait behind pills
// named for why someone would want them; a set one is a panel with ×.

// Must match the backend's defaults (storage.py) and control/protection.py.
const DEFAULT_MIN_RUN = 6;
const DEFAULT_MIN_REST = 4;
const DEFAULT_CYCLE = 10;
const DEFAULT_HEAT_LOCKOUT = -15;
const DEFAULT_COOL_LOCKOUT = 16;
const CHANGEOVER_MINUTES = 10;

const HEAT_LOCKOUTS = [-25, -20, -15, -10, -5, 0, 5, 10];
const COOL_LOCKOUTS = [10, 12, 14, 16, 18, 20, 22, 25];
const MINUTES = [0, 2, 3, 4, 5, 6, 8, 10, 15];
const CYCLES: [number, string][] = [
  [10, "10 min (most heaters)"],
  [20, "20 min"],
  [30, "30 min (slow heat, underfloor)"],
  [60, "60 min"],
];
const BANDS = [0.5, 1, 1.5, 2, 2.5, 3];

interface Demand {
  mode: "heat" | "cool" | null;
  level: number;
}

interface UnitStatus {
  available: boolean;
  heat_locked: boolean;
  cool_locked: boolean;
  note: string | null;
}

interface ZoneStatus {
  state?: string;
  shadow: boolean;
  room?: number;
  reason?: string;
  demands: Record<string, Demand>;
  units: Record<string, UnitStatus>;
}

const STATE_WORDS: Record<string, [shadow: string, live: string]> = {
  heating: ["Would heat", "Heating"],
  cooling: ["Would cool", "Cooling"],
  idle: ["Idle", "Idle"],
  off: ["Off", "Off"],
  fault: ["No room temperature", "No room temperature"],
  manual: ["Manual", "Manual"],
};

function isTemperatureSensor(entity: HassEntity): boolean {
  return (
    entity.entity_id.startsWith("sensor.") &&
    (entity.attributes.device_class === "temperature" ||
      entity.attributes.unit_of_measurement === "°C")
  );
}

function degrees(value: number): string {
  return `${value.toFixed(1).replace("-", "−")} °C`;
}

function wholeDegrees(value: number): string {
  return `${String(value).replace("-", "−")} °C`;
}

// Relays and plugs: switches, and lights, as many plugs are exposed.
function isSwitchEntity(entityId: string): boolean {
  return ["switch.", "light.", "input_boolean."].some((prefix) =>
    entityId.startsWith(prefix),
  );
}

// Panels shown though their setting is still at its default: opened from
// their pill, kept open until saved or closed.
type Opened =
  | "outdoor"
  | `heat-lockout:${string}`
  | `cool-lockout:${string}`
  | `rest:${string}`
  | `cycle:${string}`;

export class HztPanel extends LitElement {
  static properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    config: { state: true },
    error: { state: true },
    saveError: { state: true },
    opened: { state: true },
    addingUnit: { state: true },
    addingZone: { state: true },
    confirmLive: { state: true },
    focusZone: { state: true },
  };

  static styles = panelStyles;

  hass?: Hass;
  narrow = false;
  config?: HouseConfig;
  error?: string;
  saveError?: string;
  opened = new Set<Opened>();
  // The zone a new room unit is being added to, if any.
  addingUnit?: string;
  addingZone = false;
  // The zone whose "go live" is waiting for a yes.
  confirmLive?: string;
  // ?zone=: the zone the dashboard card's link asked for.
  focusZone?: string;

  private loading = false;
  private scrolledTo?: string;
  // Each zone's last status read with a state, for the moment a save's
  // reload leaves its entity without one.
  private readonly lastStatus = new Map<string, ZoneStatus>();

  connectedCallback(): void {
    super.connectedCallback();
    this.focusZone =
      new URLSearchParams(location.search).get("zone") ?? undefined;
  }

  protected updated(): void {
    if (this.hass && !this.config && !this.loading && !this.error) {
      this.loading = true;
      this.hass
        .callWS<HouseConfig>({ type: `${DOMAIN}/config` })
        .then((config) => {
          this.config = config;
        })
        .catch((error: unknown) => {
          this.error = messageOf(error);
        })
        .finally(() => {
          this.loading = false;
        });
    }
    if (this.focusZone && this.scrolledTo !== this.focusZone) {
      const card = this.renderRoot.querySelector(
        `[data-zone="${CSS.escape(this.focusZone)}"]`,
      );
      if (card) {
        this.scrolledTo = this.focusZone;
        card.scrollIntoView({ block: "start" });
      }
    }
  }

  private async save(config: HouseConfig): Promise<boolean> {
    if (!this.hass) {
      return false;
    }
    try {
      this.config = await this.hass.callWS<HouseConfig>({
        type: `${DOMAIN}/config/save`,
        config,
      });
      this.saveError = undefined;
      return true;
    } catch (error) {
      this.saveError = messageOf(error);
      return false;
    }
  }

  private open(key: Opened) {
    this.opened = new Set([...this.opened, key]);
  }

  private close(key: Opened) {
    const next = new Set(this.opened);
    next.delete(key);
    this.opened = next;
  }

  private status(zoneId: string): ZoneStatus {
    const entity = Object.values(this.hass?.states ?? {}).find(
      (e) =>
        e.entity_id.startsWith("climate.") &&
        e.attributes.hzt_zone_id === zoneId,
    );
    const a = entity?.attributes ?? {};
    if (typeof a.zone_state !== "string") {
      // Saving reloads the integration, and for a moment its entities are
      // unavailable: show the last status rather than flash "Starting"
      // and lose the reason. Only a brand-new room has none to show.
      const last = this.lastStatus.get(zoneId);
      if (last) {
        return last;
      }
    }
    const status: ZoneStatus = {
      state: typeof a.zone_state === "string" ? a.zone_state : undefined,
      shadow: a.shadow === true,
      room:
        typeof a.current_temperature === "number"
          ? a.current_temperature
          : undefined,
      reason: typeof a.reason === "string" ? a.reason : undefined,
      demands:
        typeof a.demands === "object" && a.demands
          ? (a.demands as Record<string, Demand>)
          : {},
      units: Array.isArray(a.units)
        ? Object.fromEntries(
            (a.units as (UnitStatus & { id: string })[]).map((u) => [u.id, u]),
          )
        : {},
    };
    if (status.state) {
      this.lastStatus.set(zoneId, status);
    }
    return status;
  }

  private outdoor(config: HouseConfig): number | undefined {
    const id = config.house.outdoor_sensor;
    const value = id ? Number(this.hass?.states[id]?.state) : Number.NaN;
    return Number.isFinite(value) ? value : undefined;
  }

  // ---- The page ----------------------------------------------------------

  protected render() {
    return html`
      <header class="topbar">
        ${
          this.narrow
            ? html`<button
              class="icon menu"
              aria-label="Open the sidebar"
              @click=${() =>
                this.dispatchEvent(
                  new CustomEvent("hass-toggle-menu", {
                    bubbles: true,
                    composed: true,
                  }),
                )}
            >
              <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </button>`
            : nothing
        }
        <h1>Climate zones</h1>
      </header>
      ${this.renderBody()}
    `;
  }

  private renderBody() {
    if (this.error) {
      return html`<main class="page">
        <p class="alert" role="alert">Couldn’t load the zones: ${this.error}</p>
      </main>`;
    }
    if (!(this.config && this.hass)) {
      return nothing;
    }
    const config = this.config;
    return html`<main class="page">
      ${
        this.saveError
          ? html`<p class="alert" role="alert">Couldn’t save: ${this.saveError}</p>`
          : nothing
      }
      ${this.renderHouse(config)}
      ${config.zones.map((zone) => this.renderZone(config, zone))}
      ${this.renderAddZone(config)}
    </main>`;
  }

  // ---- The house: what every zone shares --------------------------------

  private renderHouse(config: HouseConfig) {
    const sensor = config.house.outdoor_sensor;
    const showOutdoor = sensor !== null || this.opened.has("outdoor");
    return html`<section class="house" aria-labelledby="house-title">
      <h2 id="house-title">Your house</h2>
      ${
        config.zones.length === 0
          ? html`<p class="lead">
            HZT keeps each room within a band around its target, using
            whatever heats and cools it: ACs, radiators, heaters on smart
            plugs. Start with one room.
          </p>`
          : nothing
      }
      ${showOutdoor ? this.renderOutdoor(config) : nothing}
      ${
        // The house's extras are for its units: none before there's a room.
        showOutdoor || config.zones.length === 0
          ? nothing
          : html`<div class="pills">
            ${this.pill("Use the outdoor temperature", () => this.open("outdoor"))}
          </div>`
      }
    </section>`;
  }

  private renderOutdoor(config: HouseConfig) {
    const sensor = config.house.outdoor_sensor;
    const limited = config.room_units.filter(
      (u) =>
        (u.can_heat && u.heat_lockout_below !== null) ||
        (u.can_cool && u.cool_lockout_below !== null),
    );
    let upshot: string;
    if (sensor === null) {
      upshot = "Pick the sensor that reads the outdoor temperature.";
    } else if (limited.length === 0) {
      upshot =
        "Lets a unit stop heating or cooling in some weather. No unit uses it yet.";
    } else {
      upshot = `Lets a unit stop heating or cooling in some weather. ${limited
        .map((u) => this.lockoutSummary(u))
        .join(" ")}`;
    }
    return this.extra(
      "Use the outdoor temperature",
      () => {
        this.close("outdoor");
        if (sensor !== null) {
          // Lockouts can't work without it: say so rather than keep stale
          // limits that silently stop applying.
          this.save(setOutdoorSensor(config, null));
        }
      },
      html`<label class="inline">
          Read from
          <select
            @change=${(event: Event) =>
              this.save(
                setOutdoorSensor(config, selectValue(event.target) || null),
              ).then(() => this.close("outdoor"))}
          >
            ${this.temperatureOptions(sensor, "Choose a sensor")}
          </select>
        </label>
        <p class="small">
          ${upshot}${
            sensor !== null && limited.length > 0
              ? " Without it, those limits stop applying."
              : ""
          }
        </p>`,
    );
  }

  private lockoutSummary(unit: RoomUnit): string {
    const parts: string[] = [];
    if (unit.can_heat && unit.heat_lockout_below !== null) {
      parts.push(
        `stops heating below ${wholeDegrees(unit.heat_lockout_below)}`,
      );
    }
    if (unit.can_cool && unit.cool_lockout_below !== null) {
      parts.push(
        `stops cooling below ${wholeDegrees(unit.cool_lockout_below)}`,
      );
    }
    return `${unit.name} ${parts.join(" and ")}.`;
  }

  // ---- Zones -------------------------------------------------------------

  private renderAddZone(config: HouseConfig) {
    if (this.addingZone) {
      const add = async (event: Event) => {
        event.preventDefault();
        const data = new FormData(event.target as HTMLFormElement);
        const name = String(data.get("name") ?? "").trim();
        if (!name) {
          return;
        }
        const next = addZone(config, name, null);
        if (await this.save(next)) {
          this.addingZone = false;
        }
      };
      return html`<form class="card new" @submit=${add}>
        <label class="field">
          What’s the room called?
          <input name="name" required placeholder="Bedroom" autofocus />
        </label>
        <p class="small">
          Anything with one target temperature: a room, or an open-plan space.
        </p>
        <div class="actions">
          <button type="submit" class="primary">Add room</button>
          <button
            type="button"
            class="text"
            @click=${() => {
              this.addingZone = false;
            }}
          >
            Cancel
          </button>
        </div>
      </form>`;
    }
    return html`<div class="pills">
      ${this.pill(
        config.zones.length === 0 ? "Control a room" : "Control another room",
        () => {
          this.addingZone = true;
        },
      )}
    </div>`;
  }

  private renderZone(config: HouseConfig, zone: Zone) {
    const units = unitsOf(config, zone.id);
    const status = this.status(zone.id);
    const focused = this.focusZone === zone.id;
    const empty = units.length === 0 && zone.room_sensor === null;
    return html`<article
      class="card zone ${focused ? "focused" : ""}"
      data-zone=${zone.id}
      aria-labelledby="zone-${zone.id}"
    >
      ${this.renderZoneHead(config, zone, units, status, empty)}
      ${empty ? this.renderZoneEmpty(config, zone) : this.renderZoneRoom(config, zone)}
      ${empty ? nothing : this.renderOrders(config, zone, units)}
      ${units.map((unit) => this.renderUnit(config, zone, unit, units))}
      ${this.addingUnit === zone.id ? this.renderAddUnit(config, zone) : nothing}
      <div class="section foot">
        ${
          empty || this.addingUnit === zone.id
            ? nothing
            : this.pill(
                units.length === 0
                  ? "Add what heats or cools it"
                  : units.length === 1
                    ? "Help it with a second heater or cooler"
                    : "Help it with another heater or cooler",
                () => {
                  this.addingUnit = zone.id;
                },
              )
        }
        <button
          class="text quiet end"
          @click=${() => this.save(removeZone(config, zone.id))}
        >
          Remove room
        </button>
      </div>
    </article>`;
  }

  private renderZoneHead(
    config: HouseConfig,
    zone: Zone,
    units: RoomUnit[],
    status: ZoneStatus,
    empty: boolean,
  ) {
    const words = status.state ? STATE_WORDS[status.state] : undefined;
    const word = words ? words[status.shadow ? 0 : 1] : status.state;
    const room = status.room === undefined ? "" : ` · ${degrees(status.room)}`;
    return html`<div class="zone-head">
      <div class="zone-title">
        <h3 id="zone-${zone.id}">${zone.name}</h3>
        <span class="small"
          >${empty ? "Not set up yet" : `${word ?? "Starting"}${room}`}</span
        >
        ${
          !empty && status.reason
            ? html`<span class="small reason">${status.reason}</span>`
            : nothing
        }
      </div>
      ${empty ? nothing : this.renderMode(config, zone, units)}
    </div>`;
  }

  // Live or shadow: what HZT does with this zone's units. Quiet, since it's
  // set once; going live asks first.
  private renderMode(config: HouseConfig, zone: Zone, units: RoomUnit[]) {
    const names = units.map((u) => u.name).join(" and ") || "its units";
    if (!zone.shadow) {
      return html`<p class="mode">
        Live: HZT drives ${names} ·
        <button
          class="text link"
          @click=${() => this.save(updateZone(config, zone.id, { shadow: true }))}
        >
          Use shadow mode
        </button>
      </p>`;
    }
    if (this.confirmLive === zone.id) {
      return html`<div class="mode confirm" role="group" aria-label="Go live">
        <p>
          <strong>Hand ${names} to HZT?</strong> It will set their mode and
          setpoint from now on. Turn off anything else that controls them
          first, such as another thermostat or an automation, or the two will
          fight. If someone changes them by hand, HZT leaves the room alone for
          two hours.
        </p>
        <div class="actions">
          <button
            class="primary"
            @click=${async () => {
              if (
                await this.save(updateZone(config, zone.id, { shadow: false }))
              ) {
                this.confirmLive = undefined;
              }
            }}
          >
            Go live
          </button>
          <button
            class="text"
            @click=${() => {
              this.confirmLive = undefined;
            }}
          >
            Cancel
          </button>
        </div>
      </div>`;
    }
    return html`<p class="mode">
      Shadow: HZT decides but sends nothing ·
      <button
        class="text link"
        ?disabled=${units.length === 0}
        @click=${() => {
          this.confirmLive = zone.id;
        }}
      >
        Go live…
      </button>
    </p>`;
  }

  private renderZoneEmpty(config: HouseConfig, zone: Zone) {
    return html`<div class="section empty-state">
      <svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true">
        <path d="M14 14.8V4a2 2 0 1 0-4 0v10.8a4 4 0 1 0 4 0z" />
      </svg>
      <p class="empty-title">Two things and HZT can look after ${zone.name}</p>
      <p class="small">
        A sensor that reads the room, and whatever heats or cools it: an AC, a
        radiator’s valve, a heater on a smart plug. It starts in shadow mode,
        so nothing moves until you say.
      </p>
      <div class="empty-actions">
        <label class="field">
          Reads the room from
          <select @change=${(event: Event) => this.setSensor(config, zone, event)}>
            ${this.temperatureOptions(null, "Choose a sensor")}
          </select>
        </label>
        ${
          this.addingUnit === zone.id
            ? nothing
            : html`<button
              class="secondary"
              @click=${() => {
                this.addingUnit = zone.id;
              }}
            >
              Add what heats or cools it
            </button>`
        }
      </div>
    </div>`;
  }

  private setSensor(config: HouseConfig, zone: Zone, event: Event) {
    this.save(
      updateZone(config, zone.id, {
        room_sensor: selectValue(event.target) || null,
      }),
    );
  }

  // The room's sensor, and the band it's kept in.
  private renderZoneRoom(config: HouseConfig, zone: Zone) {
    const { heatBelow, coolAbove } = bandEdges(zone.target, zone.idle_band);
    return html`<div class="section room">
      <label class="field">
        Reads the room from
        <select @change=${(event: Event) => this.setSensor(config, zone, event)}>
          ${this.temperatureOptions(zone.room_sensor, "No sensor")}
        </select>
        ${
          zone.room_sensor
            ? nothing
            : html`<small class="warn"
              >Without one, HZT can’t tell how warm the room is and keeps every
              unit off.</small
            >`
        }
      </label>
      <div class="field">
        <span>Keeps it between</span>
        <strong class="band-value"
          >${tenths(heatBelow)} – ${tenths(coolAbove)} °C</strong
        >
        <div class="band-row">
          <label class="inline">
            Target
            <input
              type="number"
              min="5"
              max="35"
              step="0.1"
              .value=${String(zone.target)}
              aria-label="Target"
              @change=${(event: Event) => {
                const value = Number((event.target as HTMLInputElement).value);
                if (Number.isFinite(value) && value >= 5 && value <= 35) {
                  this.save(
                    updateZone(config, zone.id, {
                      target: Math.round(value * 10) / 10,
                    }),
                  );
                }
              }}
            />
            °C
          </label>
          <label class="inline">
            Idle band
            <select
              aria-label="Idle band"
              @change=${(event: Event) =>
                this.save(
                  updateZone(config, zone.id, {
                    idle_band: Number(selectValue(event.target)),
                  }),
                )}
            >
              ${[...new Set([...BANDS, zone.idle_band])]
                .sort((a, b) => a - b)
                .map(
                  (band) => html`<option
                    value=${band}
                    ?selected=${band === zone.idle_band}
                  >
                    ±${tenths(band / 2)} °C
                  </option>`,
                )}
            </select>
          </label>
        </div>
        <small
          >Heats below ${tenths(heatBelow)}, cools above ${tenths(coolAbove)};
          between them nothing runs. The target is also set on the room’s
          card.</small
        >
      </div>
    </div>`;
  }

  // An order means something only with two units for a direction; then
  // it's here, with the units' order to change.
  private renderOrders(config: HouseConfig, zone: Zone, units: RoomUnit[]) {
    const heaters = units.filter((u) => u.can_heat);
    const coolers = units.filter((u) => u.can_cool);
    if (heaters.length < 2 && coolers.length < 2) {
      return nothing;
    }
    return html`<div class="section orders">
      ${heaters.length >= 2 ? this.renderOrder(config, zone, heaters, "heat") : nothing}
      ${coolers.length >= 2 ? this.renderOrder(config, zone, coolers, "cool") : nothing}
      <p class="small">
        The first runs first; the next joins when it can’t keep up. One that
        can’t run right now (locked out, unavailable) is skipped.
      </p>
    </div>`;
  }

  private renderOrder(
    config: HouseConfig,
    zone: Zone,
    units: RoomUnit[],
    mode: "heat" | "cool",
  ) {
    const demands = this.status(zone.id).demands;
    const label = mode === "heat" ? "Heating order" : "Cooling order";
    return html`<div class="order-col">
      <h4>${label}</h4>
      <ol class="order" aria-label=${label}>
        ${units.map(
          (unit, index) => html`<li>
            <span class="rank ${demands[unit.id]?.mode === mode ? mode : ""}"
              >${index + 1}</span
            >
            <span class="order-name">${unit.name}</span>
            <button
              class="icon small-icon"
              aria-label="Move ${unit.name} up"
              ?disabled=${index === 0}
              @click=${() => this.moveWithin(config, units, index, -1)}
            >
              ↑
            </button>
            <button
              class="icon small-icon"
              aria-label="Move ${unit.name} down"
              ?disabled=${index === units.length - 1}
              @click=${() => this.moveWithin(config, units, index, 1)}
            >
              ↓
            </button>
          </li>`,
        )}
      </ol>
    </div>`;
  }

  // Moves a unit past its neighbour in this list, skipping units of the
  // zone that aren't in it (a cooler in the heating list, say).
  private moveWithin(
    config: HouseConfig,
    list: RoomUnit[],
    index: number,
    step: -1 | 1,
  ) {
    const unit = list[index];
    const neighbour = list[index + step];
    if (!(unit && neighbour)) {
      return;
    }
    let next = config;
    const all = unitsOf(config, unit.zone_id);
    const distance = all.indexOf(neighbour) - all.indexOf(unit);
    for (let i = 0; i < Math.abs(distance); i++) {
      next = moveRoomUnit(next, unit.id, step);
    }
    this.save(next);
  }

  // ---- Room units ----------------------------------------------------------

  private unitWord(unit: RoomUnit): string {
    const status = this.status(unit.zone_id);
    const demand = status.demands[unit.id];
    const unitStatus = status.units[unit.id];
    if (this.hass?.states[unit.entity_id]?.state === "unavailable") {
      return "unavailable";
    }
    if (demand?.mode) {
      const verb = demand.mode === "heat" ? "heat" : "cool";
      return status.shadow ? `would ${verb}` : `${verb}ing`;
    }
    if (
      (status.state === "heating" && unitStatus?.heat_locked) ||
      (status.state === "cooling" && unitStatus?.cool_locked)
    ) {
      return "locked out";
    }
    if (status.state === "heating") {
      return unit.can_heat ? "standby" : "idle, cools only";
    }
    if (status.state === "cooling") {
      return unit.can_cool ? "standby" : "idle, heats only";
    }
    return status.state === "manual" ? "manual" : "idle";
  }

  // What it does for this room, in a few words.
  private unitRole(unit: RoomUnit, units: RoomUnit[]): string {
    const heaters = units.filter((u) => u.can_heat);
    const coolers = units.filter((u) => u.can_cool);
    if (unit.can_heat && unit.can_cool) {
      return heaters.length === 1 && coolers.length === 1
        ? "Heats and cools this room"
        : "Heats and cools";
    }
    if (unit.can_heat) {
      return heaters.length === 1 ? "Does all the heating" : "Heats";
    }
    if (unit.can_cool) {
      return coolers.length === 1 ? "Does all the cooling" : "Cools";
    }
    return "Not used: neither heats nor cools";
  }

  private renderUnit(
    config: HouseConfig,
    zone: Zone,
    unit: RoomUnit,
    units: RoomUnit[],
  ) {
    const status = this.status(zone.id).units[unit.id];
    const change = (changes: Partial<RoomUnit>) =>
      this.save(updateRoomUnit(config, unit.id, changes));
    const word = this.unitWord(unit);
    const switched = isSwitchEntity(unit.entity_id);

    const heatLockout =
      unit.can_heat &&
      (unit.heat_lockout_below !== null ||
        this.opened.has(`heat-lockout:${unit.id}`));
    const coolLockout =
      unit.can_cool &&
      (unit.cool_lockout_below !== null ||
        this.opened.has(`cool-lockout:${unit.id}`));
    const rest =
      unit.min_run !== DEFAULT_MIN_RUN ||
      unit.min_rest !== DEFAULT_MIN_REST ||
      this.opened.has(`rest:${unit.id}`);
    const cycle =
      switched &&
      (unit.cycle_minutes !== DEFAULT_CYCLE ||
        this.opened.has(`cycle:${unit.id}`));

    const pills = [
      unit.can_heat && !heatLockout
        ? this.pill("Stop it heating in the cold", () => {
            this.open(`heat-lockout:${unit.id}`);
            change({ heat_lockout_below: DEFAULT_HEAT_LOCKOUT });
          })
        : nothing,
      unit.can_cool && !coolLockout
        ? this.pill("Stop it cooling in the cold", () => {
            this.open(`cool-lockout:${unit.id}`);
            change({ cool_lockout_below: DEFAULT_COOL_LOCKOUT });
          })
        : nothing,
      switched && !cycle
        ? this.pill("Switch it on longer cycles", () =>
            this.open(`cycle:${unit.id}`),
          )
        : nothing,
      rest
        ? nothing
        : this.pill("Let it rest longer between runs", () =>
            this.open(`rest:${unit.id}`),
          ),
    ];

    return html`<section class="section unit" aria-label=${unit.name}>
      <div class="unit-head">
        <span class="unit-name">${unit.name}</span>
        <span class="small"
          >${this.unitRole(unit, units)} · ${capitalize(word)}</span
        >
        <button
          class="text quiet end"
          @click=${() => this.save(removeRoomUnit(config, unit.id))}
        >
          Remove
        </button>
      </div>
      ${
        status?.note
          ? html`<p class="small note">Now: ${status.note}.</p>`
          : nothing
      }
      ${
        switched
          ? // A relay is on or off: on powers one thing, which heats or
            // cools. So it's one choice, never both.
            html`<div
              class="checks"
              role="radiogroup"
              aria-label="What ${unit.name} powers"
            >
              <label class="check">
                <input
                  type="radio"
                  name="does-${unit.id}"
                  .checked=${unit.can_heat}
                  @change=${() => change({ can_heat: true, can_cool: false })}
                />
                Heats
              </label>
              <label class="check">
                <input
                  type="radio"
                  name="does-${unit.id}"
                  .checked=${unit.can_cool}
                  @change=${() => change({ can_heat: false, can_cool: true })}
                />
                Cools
              </label>
              <span class="small mono">${unit.entity_id}</span>
            </div>`
          : html`<div class="checks">
              <label class="check">
                <input
                  type="checkbox"
                  .checked=${unit.can_heat}
                  @change=${(event: Event) =>
                    change({
                      can_heat: (event.target as HTMLInputElement).checked,
                    })}
                />
                Heats
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  .checked=${unit.can_cool}
                  @change=${(event: Event) =>
                    change({
                      can_cool: (event.target as HTMLInputElement).checked,
                    })}
                />
                Cools
              </label>
              <span class="small mono">${unit.entity_id}</span>
            </div>`
      }
      ${
        switched && unit.can_cool
          ? html`<p class="small">
            HZT switches its power on to cool: a fan, or a window AC on a plug
            that cools whenever it has power.
          </p>`
          : nothing
      }
      ${
        switched && !unit.can_cool
          ? html`<p class="small">
            HZT only switches its power. Set the heater’s own thermostat to its
            maximum so it doesn’t switch itself off first, and make sure the
            relay or plug is rated for the heater’s power.
          </p>`
          : nothing
      }
      ${heatLockout ? this.renderLockout(config, zone, unit, units, "heat") : nothing}
      ${coolLockout ? this.renderLockout(config, zone, unit, units, "cool") : nothing}
      ${cycle ? this.renderCycle(unit, change) : nothing}
      ${rest ? this.renderRest(unit, change) : nothing}
      <div class="pills">${pills}</div>
    </section>`;
  }

  private renderLockout(
    config: HouseConfig,
    zone: Zone,
    unit: RoomUnit,
    units: RoomUnit[],
    mode: "heat" | "cool",
  ) {
    const key: Opened = `${mode}-lockout:${unit.id}`;
    const field = mode === "heat" ? "heat_lockout_below" : "cool_lockout_below";
    const threshold =
      unit[field] ??
      (mode === "heat" ? DEFAULT_HEAT_LOCKOUT : DEFAULT_COOL_LOCKOUT);
    const choices = mode === "heat" ? HEAT_LOCKOUTS : COOL_LOCKOUTS;
    const verb = mode === "heat" ? "heat" : "cool";
    const next = units.find(
      (u) => u !== unit && (mode === "heat" ? u.can_heat : u.can_cool),
    );
    const outdoor = this.outdoor(config);
    const status = this.status(zone.id).units[unit.id];
    const locked = mode === "heat" ? status?.heat_locked : status?.cool_locked;
    const takeover = next
      ? `${next.name} takes over the ${verb}ing`
      : `nothing ${verb}s ${zone.name}`;
    let upshot = `Below ${wholeDegrees(threshold)}, ${takeover}.`;
    if (config.house.outdoor_sensor === null) {
      upshot = `${upshot} It needs to know the outdoor temperature first.`;
    } else if (outdoor !== undefined) {
      upshot = `${upshot} It’s ${degrees(outdoor)} outdoors, so it ${
        locked ? `can’t ${verb} now` : `may ${verb} now`
      }.`;
    }
    return this.extra(
      `Stop it ${verb}ing in the cold`,
      () => {
        this.close(key);
        this.save(updateRoomUnit(config, unit.id, { [field]: null }));
      },
      html`<label class="inline">
          Below
          <select
            @change=${(event: Event) =>
              this.save(
                updateRoomUnit(config, unit.id, {
                  [field]: Number(selectValue(event.target)),
                }),
              )}
          >
            ${choices.map(
              (t) => html`<option value=${t} ?selected=${t === threshold}>
                ${wholeDegrees(t)}
              </option>`,
            )}
          </select>
          outdoors, it doesn’t ${verb}.
        </label>
        ${
          config.house.outdoor_sensor === null
            ? html`<label class="inline">
              Outdoor temperature from
              <select
                @change=${(event: Event) =>
                  this.save(
                    setOutdoorSensor(config, selectValue(event.target) || null),
                  )}
              >
                ${this.temperatureOptions(null, "Choose a sensor")}
              </select>
            </label>`
            : nothing
        }
        <p class="small">${upshot}</p>`,
    );
  }

  private renderRest(
    unit: RoomUnit,
    change: (changes: Partial<RoomUnit>) => Promise<boolean>,
  ) {
    const key: Opened = `rest:${unit.id}`;
    const minutes = (field: "min_run" | "min_rest", label: string) =>
      html`<label class="inline">
        ${label}
        <select
          @change=${(event: Event) =>
            change({ [field]: Number(selectValue(event.target)) })}
        >
          ${[...new Set([...MINUTES, unit[field]])]
            .sort((a, b) => a - b)
            .map(
              (m) => html`<option value=${m} ?selected=${m === unit[field]}>
                ${m} min
              </option>`,
            )}
        </select>
      </label>`;
    return this.extra(
      "Let it rest longer between runs",
      () => {
        this.close(key);
        change({ min_run: DEFAULT_MIN_RUN, min_rest: DEFAULT_MIN_REST });
      },
      html`<div class="row">
          ${minutes("min_run", "Runs at least")}
          ${minutes("min_rest", "Rests at least")}
        </div>
        <p class="small">
          Once started, it runs at least ${unit.min_run} min; once stopped, it
          waits at least ${unit.min_rest} min, so it doesn’t short-cycle.${
            unit.can_heat && unit.can_cool
              ? ` Switching between heating and cooling waits at least ${CHANGEOVER_MINUTES} min.`
              : ""
          } Closing this puts back ${DEFAULT_MIN_RUN} and ${DEFAULT_MIN_REST} min.
        </p>`,
    );
  }

  private renderCycle(
    unit: RoomUnit,
    change: (changes: Partial<RoomUnit>) => Promise<boolean>,
  ) {
    const key: Opened = `cycle:${unit.id}`;
    const cycle = unit.cycle_minutes;
    const example = Math.max(0.4 * cycle, unit.min_run);
    const exampleText =
      cycle - example < unit.min_rest
        ? "on the whole time"
        : `on ${Number(example.toFixed(1))} min of every ${cycle}`;
    return this.extra(
      "Switch it on longer cycles",
      () => {
        this.close(key);
        change({ cycle_minutes: DEFAULT_CYCLE });
      },
      html`<label class="inline">
          Cycle
          <select
            aria-label="Cycle"
            @change=${(event: Event) =>
              change({ cycle_minutes: Number(selectValue(event.target)) })}
          >
            ${CYCLES.map(
              ([minutes, label]) =>
                html`<option value=${minutes} ?selected=${minutes === cycle}>
                  ${label}
                </option>`,
            )}
          </select>
        </label>
        <p class="small">
          HZT switches it on for part of every ${cycle} minutes: at 40 % demand
          it’s ${exampleText}; at full demand, the whole time. Longer cycles
          suit slow heat such as underfloor.
        </p>`,
    );
  }

  // The new unit's section, in place: pick the device, and it's a unit.
  private renderAddUnit(config: HouseConfig, zone: Zone) {
    const used = new Set(config.room_units.map((u) => u.entity_id));
    const free = Object.values(this.hass?.states ?? {})
      .filter(
        (entity) =>
          entity.attributes.hzt_zone_id === undefined &&
          !used.has(entity.entity_id) &&
          // Not a device's settings ("Network LED", "Turbo mode"), nor
          // one HA hides (switch_as_x hides the switch it wraps).
          !this.hass?.entities?.[entity.entity_id]?.entity_category &&
          !this.hass?.entities?.[entity.entity_id]?.hidden,
      )
      .sort((a, b) =>
        friendlyName(this.hass as Hass, a.entity_id).localeCompare(
          friendlyName(this.hass as Hass, b.entity_id),
        ),
      );
    const climates = free.filter((e) => e.entity_id.startsWith("climate."));
    const switches = free.filter((e) => isSwitchEntity(e.entity_id));
    const add = async (event: Event) => {
      const entityId = selectValue(event.target);
      if (!(entityId && this.hass)) {
        return;
      }
      const modes = this.hass.states[entityId]?.attributes.hvac_modes;
      const hvacModes = Array.isArray(modes) ? modes : [];
      const switched = isSwitchEntity(entityId);
      const next = addRoomUnit(config, {
        name: friendlyName(this.hass, entityId),
        entity_id: entityId,
        zone_id: zone.id,
        can_heat:
          switched || hvacModes.includes("heat") || hvacModes.length === 0,
        can_cool: !switched && hvacModes.includes("cool"),
      });
      if (await this.save(next)) {
        this.addingUnit = undefined;
      }
    };
    const option = (entity: HassEntity) => {
      const area = areaName(this.hass as Hass, entity.entity_id);
      const name = friendlyName(this.hass as Hass, entity.entity_id);
      return html`<option value=${entity.entity_id}>
        ${area ? `${name} · ${area}` : name}
      </option>`;
    };
    return html`<section class="section unit adding" aria-label="New room unit">
      <label class="field">
        What heats or cools ${zone.name}?
        <select @change=${add}>
          <option value="">Choose a device</option>
          ${
            climates.length
              ? html`<optgroup label="ACs, heat pumps, thermostats and TRVs">
                ${climates.map(option)}
              </optgroup>`
              : nothing
          }
          ${
            switches.length
              ? html`<optgroup label="Relays, smart plugs and switched lights">
                ${switches.map(option)}
              </optgroup>`
              : nothing
          }
        </select>
      </label>
      <p class="small">
        An AC, heat pump or TRV: HZT sets its mode and setpoint, and reads
        whether it heats, cools or both from its modes. A heater on a relay or
        smart plug: HZT switches its power on and off, for longer or shorter as
        the room needs. It joins the end of the room’s order.
      </p>
      <div class="actions">
        <button
          class="text"
          @click=${() => {
            this.addingUnit = undefined;
          }}
        >
          Cancel
        </button>
      </div>
    </section>`;
  }

  // ---- Building blocks -----------------------------------------------------

  // An add-or-enable action, named for why someone would want it.
  private pill(label: string, onClick: () => void) {
    return html`<button class="pill" @click=${onClick}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
      ${label}
    </button>`;
  }

  // A setting that's on, with its own × to turn it off again. (Not named
  // `panel`: HA sets a `panel` property on every sidebar page element.)
  private extra(title: string, onClose: () => void, body: unknown) {
    return html`<div class="panel" role="group" aria-label=${title}>
      <div class="panel-head">
        <span class="panel-title">${title}</span>
        <button
          class="icon"
          aria-label="Turn off: ${title.toLowerCase()}"
          @click=${onClose}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div class="panel-body">${body}</div>
    </div>`;
  }

  private temperatureOptions(selected: string | null, none: string) {
    const sensors = Object.values(this.hass?.states ?? {})
      .filter(isTemperatureSensor)
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    return html`
      <option value="" ?selected=${selected === null}>${none}</option>
      ${sensors.map((entity) => {
        const value = Number(entity.state);
        const reading = Number.isFinite(value) ? ` · ${degrees(value)}` : "";
        return html`<option
          value=${entity.entity_id}
          ?selected=${entity.entity_id === selected}
        >
          ${friendlyName(this.hass as Hass, entity.entity_id)}${reading}
        </option>`;
      })}
    `;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function selectValue(target: EventTarget | null): string {
  return target instanceof HTMLSelectElement ? target.value : "";
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

customElements.define("hzt-panel", HztPanel);
