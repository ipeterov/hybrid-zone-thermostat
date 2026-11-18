import { html, LitElement, nothing, svg } from "lit";

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

// Map geometry, in px: a column each for central units, room units and
// zones, a row per room unit (docs/design/panel-system-map.html). Columns
// share the width the map has; below MAP_THREE_COLUMNS the central-units
// column, only a hint for now, is dropped.
const MAP_TOP = 32;
const MAP_ROW = 75;
const MAP_NODE = 56;
const MAP_MIN_WIDTH = 280;
const MAP_THREE_COLUMNS = 640;

// Must match the backend's control/protection.py.
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

interface Column {
  x: number;
  w: number;
}

interface Geometry {
  width: number;
  central?: Column;
  unit: Column;
  zone: Column;
}

function geometry(available: number): Geometry {
  const width = Math.max(available, MAP_MIN_WIDTH);
  const three = width >= MAP_THREE_COLUMNS;
  const gap = three ? 80 : 36;
  const count = three ? 3 : 2;
  const w = Math.min(240, (width - gap * (count - 1)) / count);
  const columns = Array.from({ length: count }, (_, i) => ({
    x: i * (w + gap),
    w,
  }));
  return three
    ? {
        width,
        central: columns[0],
        unit: columns[1] as Column,
        zone: columns[2] as Column,
      }
    : { width, unit: columns[0] as Column, zone: columns[1] as Column };
}

type Aside =
  | { kind: "zone" }
  | { kind: "new-zone" }
  | { kind: "new-unit" }
  | { kind: "unit"; unitId: string };

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
  heating: ["would heat", "heating"],
  cooling: ["would cool", "cooling"],
  idle: ["idle", "idle"],
  off: ["off", "off"],
  fault: ["no room temperature", "no room temperature"],
  manual: ["manual", "manual"],
};

function stateWord(status: ZoneStatus): string | undefined {
  if (!status.state) {
    return undefined;
  }
  const words = STATE_WORDS[status.state];
  return words ? words[status.shadow ? 0 : 1] : status.state;
}

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

// The Climate zones sidebar page. HA sets `hass` (and `narrow`, `panel`)
// on it, and sets `hass` again on every state change.
export class HztPanel extends LitElement {
  static properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    config: { state: true },
    error: { state: true },
    saveError: { state: true },
    selected: { state: true },
    aside: { state: true },
    mapWidth: { state: true },
    confirmLive: { state: true },
  };

  static styles = panelStyles;

  hass?: Hass;
  narrow = false;
  config?: HouseConfig;
  error?: string;
  saveError?: string;
  selected?: string;
  aside: Aside = { kind: "zone" };
  mapWidth = 860;
  confirmLive = false;

  private loading = false;
  private observed?: Element;
  private readonly resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width;
    if (width && Math.abs(width - this.mapWidth) > 1) {
      this.mapWidth = width;
    }
  });

  connectedCallback(): void {
    super.connectedCallback();
    // The zone card's settings link opens its zone: /climate-zones?zone=…
    const zone = new URLSearchParams(location.search).get("zone");
    if (zone) {
      this.selected = zone;
      this.aside = { kind: "zone" };
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver.disconnect();
    this.observed = undefined;
  }

  protected updated(): void {
    const mapBox = this.renderRoot.querySelector(".map-scroll");
    if (mapBox && mapBox !== this.observed) {
      this.resizeObserver.disconnect();
      this.resizeObserver.observe(mapBox);
      this.observed = mapBox;
    }
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

  private show(aside: Aside): void {
    this.aside = aside;
    this.confirmLive = false;
  }

  private selectedZone(config: HouseConfig): Zone | undefined {
    return (
      config.zones.find((zone) => zone.id === this.selected) ?? config.zones[0]
    );
  }

  private status(zoneId: string): ZoneStatus {
    const entity = Object.values(this.hass?.states ?? {}).find(
      (e) =>
        e.entity_id.startsWith("climate.") &&
        e.attributes.hzt_zone_id === zoneId,
    );
    const a = entity?.attributes ?? {};
    return {
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
  }

  private outdoor(config: HouseConfig): number | undefined {
    const id = config.house.outdoor_sensor;
    const value = id ? Number(this.hass?.states[id]?.state) : Number.NaN;
    return Number.isFinite(value) ? value : undefined;
  }

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
      return html`<div class="page">
        <p class="alert" role="alert">Couldn’t load the zones: ${this.error}</p>
      </div>`;
    }
    if (!(this.config && this.hass)) {
      return nothing;
    }
    const config = this.config;
    const zone = this.selectedZone(config);
    return html`<div class="page">
      ${
        this.saveError
          ? html`<p class="alert wide" role="alert">
            Couldn’t save: ${this.saveError}
          </p>`
          : nothing
      }
      <div class="main">
        ${this.renderMapCard(config, zone)} ${this.renderOutdoor(config)}
      </div>
      <aside class="card side">${this.renderAside(config, zone)}</aside>
    </div>`;
  }

  // ---- The system map ------------------------------------------------

  private renderMapCard(config: HouseConfig, selected: Zone | undefined) {
    return html`<section class="card">
      <div class="card-head">
        <h2>What heats and cools what</h2>
        <button
          class="pill"
          ?disabled=${!selected}
          @click=${() => this.show({ kind: "new-unit" })}
        >
          + Room unit
        </button>
        <button class="pill" @click=${() => this.show({ kind: "new-zone" })}>
          + Zone
        </button>
      </div>
      ${
        config.zones.length === 0
          ? html`<p class="empty">
            No zones yet. A zone is what has one target temperature: a room,
            or an open-plan space.
          </p>`
          : this.renderMap(config, selected)
      }
    </section>`;
  }

  private renderMap(config: HouseConfig, selected: Zone | undefined) {
    const g = geometry(this.mapWidth);
    // Rows: each zone's units in order; a zone without units takes a row.
    const unitY = new Map<string, number>();
    const zoneY = new Map<string, number>();
    let row = 0;
    for (const zone of config.zones) {
      const units = unitsOf(config, zone.id);
      const first = row;
      for (const unit of units) {
        unitY.set(unit.id, MAP_TOP + row * MAP_ROW);
        row++;
      }
      if (units.length === 0) {
        row++;
      }
      const middle = (first + Math.max(row - 1, first)) / 2;
      zoneY.set(zone.id, MAP_TOP + middle * MAP_ROW);
    }
    const height = MAP_TOP + row * MAP_ROW;

    const lines = config.room_units.map((unit) => {
      const from = (unitY.get(unit.id) ?? 0) + MAP_NODE / 2;
      const to = (zoneY.get(unit.zone_id) ?? 0) + MAP_NODE / 2;
      const x1 = g.unit.x + g.unit.w;
      const x2 = g.zone.x;
      const mid = (x1 + x2) / 2;
      const mode = this.status(unit.zone_id).demands[unit.id]?.mode;
      return svg`<path
        d="M${x1} ${from} C${mid} ${from} ${mid} ${to} ${x2} ${to}"
        class="line ${mode ?? ""}"
      ></path>`;
    });

    return html`<div class="map-scroll">
      <div class="map" style="width:${g.width}px;height:${height}px">
        ${
          g.central
            ? html`<span class="col-label" style="left:${g.central.x}px"
              >Central units</span
            >`
            : nothing
        }
        <span class="col-label" style="left:${g.unit.x}px">Room units</span>
        <span class="col-label" style="left:${g.zone.x}px">Zones</span>
        <svg
          width=${g.width}
          height=${height}
          class="lines"
          aria-hidden="true"
        >
          ${lines}
        </svg>
        ${
          g.central
            ? html`<p
              class="node hint"
              style="left:${g.central.x}px;top:${MAP_TOP}px;width:${g.central.w}px"
            >
              Boilers and multi-split outdoor units will go here.
            </p>`
            : nothing
        }
        ${config.room_units.map((unit) =>
          this.renderUnitNode(config, unit, g.unit, unitY.get(unit.id) ?? 0),
        )}
        ${config.zones.map((zone) =>
          this.renderZoneNode(
            zone,
            g.zone,
            zoneY.get(zone.id) ?? 0,
            zone === selected && this.aside.kind === "zone",
          ),
        )}
      </div>
    </div>`;
  }

  private unitWord(unit: RoomUnit): string {
    const status = this.status(unit.zone_id);
    const demand = status.demands[unit.id];
    const unitStatus = status.units[unit.id];
    const available =
      this.hass?.states[unit.entity_id]?.state !== "unavailable";
    if (!available) {
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
    if (status.state === "heating" || status.state === "cooling") {
      return "standby";
    }
    return status.state === "manual" ? "manual" : "idle";
  }

  private renderUnitNode(
    config: HouseConfig,
    unit: RoomUnit,
    column: Column,
    top: number,
  ) {
    const demand = this.status(unit.zone_id).demands[unit.id];
    const rank = unitsOf(config, unit.zone_id).indexOf(unit) + 1;
    const word = this.unitWord(unit);
    const selected =
      this.aside.kind === "unit" && this.aside.unitId === unit.id;
    return html`<button
      class="node unit ${demand?.mode ?? ""} ${
        word === "unavailable" || word === "locked out" ? "gone" : ""
      } ${selected ? "selected" : ""}"
      style="left:${column.x}px;top:${top}px;width:${column.w}px"
      aria-pressed=${selected ? "true" : "false"}
      @click=${() => {
        this.selected = unit.zone_id;
        this.show({ kind: "unit", unitId: unit.id });
      }}
    >
      <span class="node-name">${unit.name}</span>
      <span class="node-sub">${capitalize(word)} · #${rank}</span>
    </button>`;
  }

  private renderZoneNode(
    zone: Zone,
    column: Column,
    top: number,
    selected: boolean,
  ) {
    const status = this.status(zone.id);
    const room = status.room === undefined ? "–" : status.room.toFixed(1);
    const word = stateWord(status);
    return html`<button
      class="node zone ${selected ? "selected" : ""}"
      style="left:${column.x}px;top:${top}px;width:${column.w}px"
      aria-pressed=${selected ? "true" : "false"}
      @click=${() => {
        this.selected = zone.id;
        this.show({ kind: "zone" });
      }}
    >
      <span class="node-name">${zone.name}</span>
      <span class="node-sub"
        >${room} → ${zone.target.toFixed(1)}${word ? ` · ${word}` : ""}</span
      >
    </button>`;
  }

  // ---- Outdoor temperature and lockouts --------------------------------

  private temperatureOptions(selected: string | null) {
    const sensors = Object.values(this.hass?.states ?? {})
      .filter(isTemperatureSensor)
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    return html`
      <option value="" ?selected=${selected === null}>None</option>
      ${sensors.map(
        (entity) => html`<option
          value=${entity.entity_id}
          ?selected=${entity.entity_id === selected}
        >
          ${friendlyName(this.hass as Hass, entity.entity_id)}
        </option>`,
      )}
    `;
  }

  private renderOutdoor(config: HouseConfig) {
    const outdoor = this.outdoor(config);
    const sensor = config.house.outdoor_sensor;
    return html`<section class="card" aria-labelledby="outdoor-title">
      <h2 id="outdoor-title">Outdoor temperature</h2>
      <label class="field narrow">
        Sensor
        <select
          @change=${(event: Event) =>
            this.save(
              setOutdoorSensor(config, selectValue(event.target) || null),
            )}
        >
          ${this.temperatureOptions(sensor)}
        </select>
      </label>
      ${
        sensor === null
          ? html`<p class="small">
            Used for lockouts: below a temperature you choose, a unit stops
            heating or cooling and the next one takes over. Without a sensor,
            lockouts are off and every unit may run whatever the weather.
          </p>`
          : this.renderLockoutChart(config, outdoor)
      }
    </section>`;
  }

  private renderLockoutChart(config: HouseConfig, outdoor: number | undefined) {
    const units = config.room_units;
    const thresholds = units.flatMap((u) =>
      [u.heat_lockout_below, u.cool_lockout_below].filter(
        (t): t is number => t !== null,
      ),
    );
    const low = Math.min(-20, ...thresholds.map((t) => t - 5));
    const high = 35;
    const at = (t: number) =>
      `${(((Math.min(Math.max(t, low), high) - low) / (high - low)) * 100).toFixed(2)}%`;
    const lockedNow = units.filter((u) => {
      const s = this.status(u.zone_id).units[u.id];
      return s?.heat_locked || s?.cool_locked;
    });
    const anyLockout = thresholds.length > 0;
    let summary: string;
    if (outdoor === undefined) {
      summary =
        "The sensor has no reading, so lockouts are off until it reports again.";
    } else if (lockedNow.length > 0) {
      summary = lockedNow
        .map((u) => {
          const s = this.status(u.zone_id).units[u.id];
          const what = s?.heat_locked ? "heat" : "cool";
          return `${u.name} can’t ${what} now.`;
        })
        .join(" ");
    } else if (anyLockout) {
      summary = "Every unit may run at this temperature.";
    } else {
      summary =
        "No unit has a lockout, so every unit may run whatever the weather. Select a room unit on the map to set one.";
    }
    return html`
      <p class="small">
        ${outdoor === undefined ? nothing : html`It’s ${degrees(outdoor)} now. `}${summary}
      </p>
      ${
        units.length === 0
          ? nothing
          : html`<div class="chart" role="img" aria-label="Which units may run at which outdoor temperature">
            ${units.map(
              (u) => html`<span class="chart-label">${u.name}</span>
                <span class="chart-track">
                  ${
                    u.can_heat
                      ? html`<span
                        class="bar heat"
                        style="left:${at(u.heat_lockout_below ?? low)};right:0"
                      ></span>`
                      : nothing
                  }
                  ${
                    u.can_cool
                      ? html`<span
                        class="bar cool"
                        style="left:${at(u.cool_lockout_below ?? low)};right:0"
                      ></span>`
                      : nothing
                  }
                  ${
                    outdoor === undefined
                      ? nothing
                      : html`<span class="now" style="left:${at(outdoor)}"></span>`
                  }
                </span>`,
            )}
            <span></span>
            <span class="chart-axis">
              <span style="left:0">${wholeDegrees(low)}</span>
              <span style="left:${at(0)}">0 °C</span>
              <span style="right:0">${wholeDegrees(high)}</span>
            </span>
          </div>
          <p class="legend">
            <span><span class="swatch heat"></span>may heat</span>
            <span><span class="swatch cool"></span>may cool</span>
            <span><span class="swatch now"></span>now</span>
          </p>`
      }
    `;
  }

  // ---- The side panel --------------------------------------------------

  private renderAside(config: HouseConfig, zone: Zone | undefined) {
    if (this.aside.kind === "new-zone" || !zone) {
      return this.renderNewZone(config, Boolean(zone));
    }
    if (this.aside.kind === "new-unit") {
      return this.renderNewUnit(config, zone);
    }
    if (this.aside.kind === "unit") {
      const unitId = this.aside.unitId;
      const unit = config.room_units.find((u) => u.id === unitId);
      if (unit) {
        return this.renderUnit(config, unit);
      }
    }
    return this.renderZoneDetails(config, zone);
  }

  private renderZoneDetails(config: HouseConfig, zone: Zone) {
    const status = this.status(zone.id);
    const word = stateWord(status);
    const units = unitsOf(config, zone.id);
    const coolFrom = (zone.target + zone.idle_band).toFixed(1);
    return html`<div class="side-head">
        <span class="eyebrow">Zone</span>
        <div class="title-row">
          <h2 class="big">${zone.name}</h2>
          ${word ? html`<span class="chip ${status.state}">${capitalize(word)}</span>` : nothing}
        </div>
      </div>
      ${
        status.reason
          ? html`<p class="reason"><strong>Why:</strong> ${status.reason}</p>`
          : nothing
      }
      ${this.renderLive(config, zone, units)}
      <div class="facts">
        <label class="fact full">
          <span>Room sensor</span>
          <select
            @change=${(event: Event) =>
              this.save(
                updateZone(config, zone.id, {
                  room_sensor: selectValue(event.target) || null,
                }),
              )}
          >
            ${this.temperatureOptions(zone.room_sensor)}
          </select>
          <small
            >${
              zone.room_sensor
                ? "What the zone’s temperature is read from."
                : "Without one, HZT can’t tell the room’s temperature and keeps every unit off."
            }</small
          >
        </label>
        <label class="fact">
          <span>Idle band</span>
          <select
            @change=${(event: Event) =>
              this.save(
                updateZone(config, zone.id, {
                  idle_band: Number(selectValue(event.target)),
                }),
              )}
          >
            ${[0.5, 1, 1.5, 2, 2.5, 3].map(
              (band) =>
                html`<option
                  value=${band}
                  ?selected=${band === zone.idle_band}
                >
                  +${band.toFixed(1)} °C
                </option>`,
            )}
          </select>
          <small>Heats below ${zone.target.toFixed(1)}, cools above ${coolFrom}</small>
        </label>
        <div class="fact">
          <span>Target</span>
          <strong>${zone.target.toFixed(1)} °C</strong>
          <small>Set on its thermostat</small>
        </div>
      </div>

      ${this.renderOrders(config, zone, units)}
      <div class="side-actions">
        <button class="pill" @click=${() => this.show({ kind: "new-unit" })}>
          + Room unit
        </button>
        <button
          class="text danger"
          @click=${async () => {
            if (await this.save(removeZone(config, zone.id))) {
              this.selected = undefined;
            }
          }}
        >
          Remove zone
        </button>
      </div>`;
  }

  private renderLive(config: HouseConfig, zone: Zone, units: RoomUnit[]) {
    const names = units.map((u) => u.name).join(" and ") || "its units";
    if (!zone.shadow) {
      return html`<div class="mode live">
        <p>
          <strong>Live.</strong> HZT sets ${names}’s mode and setpoint. If
          someone changes them by hand, HZT leaves the zone alone for two
          hours.
        </p>
        <button
          class="pill"
          @click=${() => this.save(updateZone(config, zone.id, { shadow: true }))}
        >
          Back to shadow mode
        </button>
      </div>`;
    }
    if (this.confirmLive) {
      return html`<div class="mode confirm">
        <p>
          <strong>Hand ${names} to HZT?</strong> It will set their mode and
          setpoint from now on. Turn off anything else that controls them
          first, such as another thermostat or an automation, or the two will
          fight.
        </p>
        <div class="side-actions start">
          <button
            class="primary"
            @click=${async () => {
              if (
                await this.save(updateZone(config, zone.id, { shadow: false }))
              ) {
                this.confirmLive = false;
              }
            }}
          >
            Go live
          </button>
          <button
            class="pill"
            @click=${() => {
              this.confirmLive = false;
            }}
          >
            Cancel
          </button>
        </div>
      </div>`;
    }
    return html`<div class="mode">
      <p>
        <strong>Shadow mode.</strong> HZT decides but sends nothing, so you can
        compare its decisions with what runs now.
      </p>
      <button
        class="pill"
        ?disabled=${units.length === 0}
        @click=${() => {
          this.confirmLive = true;
        }}
      >
        Go live…
      </button>
    </div>`;
  }

  private renderOrders(config: HouseConfig, zone: Zone, units: RoomUnit[]) {
    const heaters = units.filter((u) => u.can_heat);
    const coolers = units.filter((u) => u.can_cool);
    const only = heaters[0];
    // One unit doing both: one line, not two identical ones.
    if (
      only &&
      heaters.length === 1 &&
      coolers.length === 1 &&
      coolers[0] === only
    ) {
      const mode = this.status(zone.id).demands[only.id]?.mode ?? "";
      return html`<h3 class="eyebrow">Heating and cooling</h3>
        <button
          class="row single"
          @click=${() => this.show({ kind: "unit", unitId: only.id })}
        >
          <span class="rank ${mode}"></span>
          <span class="order-text">
            <span class="order-name">${only.name}</span>
            <span class="order-rule">Does all the heating and cooling.</span>
          </span>
        </button>`;
    }
    return html`<h3 class="eyebrow">Heating</h3>
      ${this.renderOrder(config, zone, heaters, "heat")}
      <h3 class="eyebrow">Cooling</h3>
      ${this.renderOrder(config, zone, coolers, "cool")}`;
  }

  private renderOrder(
    config: HouseConfig,
    zone: Zone,
    units: RoomUnit[],
    mode: "heat" | "cool",
  ) {
    const verb = mode === "heat" ? "heats" : "cools";
    if (units.length === 0) {
      return html`<p class="small">Nothing in ${zone.name} ${verb}.</p>`;
    }
    const demands = this.status(zone.id).demands;
    if (units.length === 1) {
      const unit = units[0] as RoomUnit;
      return html`<button
        class="row single"
        @click=${() => this.show({ kind: "unit", unitId: unit.id })}
      >
        <span class="rank ${demands[unit.id]?.mode === mode ? mode : ""}"></span>
        <span class="order-text">
          <span class="order-name">${unit.name}</span>
          <span class="order-rule"
            >Does all the ${mode === "heat" ? "heating" : "cooling"}.</span
          >
        </span>
      </button>`;
    }
    return html`<ol class="order" aria-label="${capitalize(mode)}ing order">
      ${units.map((unit, index) => {
        const running = demands[unit.id]?.mode === mode;
        let rule: string;
        if (index === 0) {
          rule = "First choice";
        } else {
          rule = `Joins when ${index === 1 ? "#1" : `#1–${index}`} can’t keep up`;
        }
        return html`<li>
          <span class="rank ${running ? mode : ""}">${index + 1}</span>
          <button
            class="order-text link"
            @click=${() => this.show({ kind: "unit", unitId: unit.id })}
          >
            <span class="order-name">${unit.name}</span>
            <span class="order-rule">${rule}</span>
          </button>
          <button
            class="icon"
            aria-label="Move ${unit.name} up"
            ?disabled=${index === 0}
            @click=${() => this.moveWithin(config, units, index, -1)}
          >
            ↑
          </button>
          <button
            class="icon"
            aria-label="Move ${unit.name} down"
            ?disabled=${index === units.length - 1}
            @click=${() => this.moveWithin(config, units, index, 1)}
          >
            ↓
          </button>
        </li>`;
      })}
    </ol>
    <p class="small">
      A unit that can’t run right now (locked out, unavailable) is skipped; the
      next one moves up.
    </p>`;
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

  // ---- One room unit ----------------------------------------------------

  private renderUnit(config: HouseConfig, unit: RoomUnit) {
    const zone = config.zones.find((z) => z.id === unit.zone_id);
    const zoneName = zone?.name ?? "";
    const status = this.status(unit.zone_id).units[unit.id];
    const outdoor = this.outdoor(config);
    const hasSensor = config.house.outdoor_sensor !== null;
    const siblings = unitsOf(config, unit.zone_id);
    const nextHeater = siblings.find((u) => u !== unit && u.can_heat);
    const nextCooler = siblings.find((u) => u !== unit && u.can_cool);
    const change = (changes: Partial<RoomUnit>) =>
      this.save(updateRoomUnit(config, unit.id, changes));

    const lockoutUpshot = (
      mode: "heat" | "cool",
      threshold: number | null,
      next: RoomUnit | undefined,
      locked: boolean | undefined,
    ) => {
      const verb = mode === "heat" ? "heats" : "cools";
      if (!hasSensor) {
        return "Needs an outdoor sensor: choose one under the map.";
      }
      if (threshold === null) {
        return `${unit.name} ${verb} whatever the weather.`;
      }
      const takeover = next
        ? `${next.name} takes over the ${mode === "heat" ? "heating" : "cooling"}`
        : `nothing ${verb} ${zoneName}`;
      const now =
        outdoor === undefined
          ? ""
          : ` It’s ${degrees(outdoor)} now${locked ? ", so it’s locked out" : ""}.`;
      return `Below ${wholeDegrees(threshold)}, ${takeover}.${now}`;
    };

    return html`<div class="side-head">
        <button class="text back" @click=${() => this.show({ kind: "zone" })}>
          ← ${zoneName}
        </button>
        <div class="title-row">
          <h2 class="big">${unit.name}</h2>
          <span class="chip">${capitalize(this.unitWord(unit))}</span>
        </div>
        <span class="small mono">${unit.entity_id}</span>
      </div>
      ${
        status?.note
          ? html`<p class="reason"><strong>Now:</strong> ${status.note}.</p>`
          : nothing
      }

      <h3 class="eyebrow">What it does</h3>
      <div class="checks">
        <label class="check">
          <input
            type="checkbox"
            .checked=${unit.can_heat}
            @change=${(event: Event) =>
              change({ can_heat: (event.target as HTMLInputElement).checked })}
          />
          Heats
        </label>
        <label class="check">
          <input
            type="checkbox"
            .checked=${unit.can_cool}
            @change=${(event: Event) =>
              change({ can_cool: (event.target as HTMLInputElement).checked })}
          />
          Cools
        </label>
      </div>
      <p class="small">
        ${
          unit.can_heat || unit.can_cool
            ? `HZT uses it to ${[unit.can_heat ? "heat" : "", unit.can_cool ? "cool" : ""].filter(Boolean).join(" and ")} ${zoneName}.`
            : `HZT doesn’t use it at all.`
        }
      </p>

      ${isSwitchEntity(unit.entity_id) ? this.renderSwitching(unit, change) : nothing}

      <h3 class="eyebrow">Outdoor lockouts</h3>
      ${
        unit.can_heat
          ? html`<label class="field">
            Stop heating below
            <select
              ?disabled=${!hasSensor}
              @change=${(event: Event) =>
                change({ heat_lockout_below: numberOrNull(event.target) })}
            >
              <option value="" ?selected=${unit.heat_lockout_below === null}>
                Never
              </option>
              ${HEAT_LOCKOUTS.map(
                (t) => html`<option
                  value=${t}
                  ?selected=${t === unit.heat_lockout_below}
                >
                  ${wholeDegrees(t)}
                </option>`,
              )}
            </select>
            <small
              >${lockoutUpshot(
                "heat",
                unit.heat_lockout_below,
                nextHeater,
                status?.heat_locked,
              )}</small
            >
          </label>`
          : nothing
      }
      ${
        unit.can_cool
          ? html`<label class="field">
            Stop cooling below
            <select
              ?disabled=${!hasSensor}
              @change=${(event: Event) =>
                change({ cool_lockout_below: numberOrNull(event.target) })}
            >
              <option value="" ?selected=${unit.cool_lockout_below === null}>
                Never
              </option>
              ${COOL_LOCKOUTS.map(
                (t) => html`<option
                  value=${t}
                  ?selected=${t === unit.cool_lockout_below}
                >
                  ${wholeDegrees(t)}
                </option>`,
              )}
            </select>
            <small
              >${lockoutUpshot(
                "cool",
                unit.cool_lockout_below,
                nextCooler,
                status?.cool_locked,
              )}</small
            >
          </label>`
          : nothing
      }
      ${
        unit.can_heat || unit.can_cool
          ? nothing
          : html`<p class="small">Turn on heating or cooling to set these.</p>`
      }

      <h3 class="eyebrow">Equipment protection</h3>
      <div class="facts">
        <label class="fact">
          <span>Runs at least</span>
          <select
            @change=${(event: Event) =>
              change({ min_run: Number(selectValue(event.target)) })}
          >
            ${MINUTES.map(
              (m) =>
                html`<option value=${m} ?selected=${m === unit.min_run}>
                  ${m} min
                </option>`,
            )}
          </select>
        </label>
        <label class="fact">
          <span>Rests at least</span>
          <select
            @change=${(event: Event) =>
              change({ min_rest: Number(selectValue(event.target)) })}
          >
            ${MINUTES.map(
              (m) =>
                html`<option value=${m} ?selected=${m === unit.min_rest}>
                  ${m} min
                </option>`,
            )}
          </select>
        </label>
      </div>
      <p class="small">
        Once started, it runs at least ${unit.min_run} min; once stopped, it
        waits at least ${unit.min_rest} min before starting again, so it
        doesn’t short-cycle.${
          unit.can_heat && unit.can_cool
            ? ` Switching between heating and cooling waits at least ${CHANGEOVER_MINUTES} min.`
            : ""
        }
      </p>

      <div class="side-actions">
        <button class="pill" @click=${() => this.show({ kind: "zone" })}>
          Done
        </button>
        <button
          class="text danger"
          @click=${async () => {
            if (await this.save(removeRoomUnit(config, unit.id))) {
              this.show({ kind: "zone" });
            }
          }}
        >
          Remove from ${zoneName}
        </button>
      </div>`;
  }

  private renderSwitching(
    unit: RoomUnit,
    change: (changes: Partial<RoomUnit>) => Promise<boolean>,
  ) {
    const cycle = unit.cycle_minutes;
    const example = Math.max(0.4 * cycle, unit.min_run);
    const exampleText =
      cycle - example < unit.min_rest
        ? "on the whole time"
        : `on ${Number(example.toFixed(1))} min of every ${cycle}`;
    return html`<h3 class="eyebrow">Switched on and off</h3>
      <label class="field">
        Cycle
        <select
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
        <small
          >HZT switches it on for part of every ${cycle} minutes: at 40 %
          demand it’s ${exampleText}; at full demand, the whole time. Longer
          cycles suit slow heat such as underfloor.</small
        >
      </label>
      <p class="note-box">
        HZT only switches its power. Set the heater’s own thermostat to its
        maximum so it doesn’t switch itself off first, and make sure the relay
        or plug is rated for the heater’s power.
      </p>`;
  }

  // ---- Adding things ---------------------------------------------------

  private renderNewZone(config: HouseConfig, canCancel: boolean) {
    const add = async (event: Event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const data = new FormData(form);
      const name = String(data.get("name") ?? "").trim();
      if (!name) {
        return;
      }
      const sensor = String(data.get("room_sensor") ?? "") || null;
      const next = addZone(config, name, sensor);
      if (await this.save(next)) {
        this.selected = next.zones.at(-1)?.id;
        this.show({ kind: "zone" });
      }
    };
    return html`<form class="side-form" @submit=${add}>
      <h2 class="big">New zone</h2>
      <p class="small">
        Something with one target temperature: a room, or an open-plan space.
        It starts in shadow mode, deciding but sending nothing.
      </p>
      <label class="field">
        Name
        <input name="name" required placeholder="Living room" />
      </label>
      <label class="field">
        Room temperature
        <select name="room_sensor">
          ${this.temperatureOptions(null)}
        </select>
        <small>The sensor that tells HZT how warm the room is.</small>
      </label>
      <div class="side-actions start">
        <button type="submit" class="primary">Add zone</button>
        ${
          canCancel
            ? html`<button
              type="button"
              class="pill"
              @click=${() => this.show({ kind: "zone" })}
            >
              Cancel
            </button>`
            : nothing
        }
      </div>
    </form>`;
  }

  private renderNewUnit(config: HouseConfig, zone: Zone) {
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
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const entityId = new FormData(form).get("entity_id");
      if (typeof entityId !== "string" || !entityId || !this.hass) {
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
        const added = next.room_units.at(-1);
        // A switch can't say what it does: confirm it on its own page.
        this.show(
          switched && added
            ? { kind: "unit", unitId: added.id }
            : { kind: "zone" },
        );
      }
    };
    const option = (entity: HassEntity) => {
      const area = areaName(this.hass as Hass, entity.entity_id);
      const name = friendlyName(this.hass as Hass, entity.entity_id);
      return html`<option value=${entity.entity_id}>
        ${area ? `${name} · ${area}` : name}
      </option>`;
    };
    return html`<form class="side-form" @submit=${add}>
      <button
        type="button"
        class="text back"
        @click=${() => this.show({ kind: "zone" })}
      >
        ← ${zone.name}
      </button>
      <h2 class="big">New room unit</h2>
      <p class="small">
        A device that heats or cools ${zone.name}. It joins the end of the
        zone’s order.
      </p>
      <label class="field">
        Device
        <select name="entity_id" required>
          <option value="">Choose one</option>
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
      <ul class="small hints">
        <li>
          <strong>An AC, heat pump or TRV</strong> (a climate entity): HZT sets
          its mode and setpoint. Whether it heats, cools or both is read from
          its modes.
        </li>
        <li>
          <strong>A heater on a relay or smart plug</strong> (a switch, or a
          light, as many plugs show up): HZT switches its power on and off, for
          longer or shorter as the room needs.
        </li>
      </ul>
      <div class="side-actions start">
        <button type="submit" class="primary">Add unit</button>
        <button
          type="button"
          class="pill"
          @click=${() => this.show({ kind: "zone" })}
        >
          Cancel
        </button>
      </div>
    </form>`;
  }
}

// Relays and plugs: switches, and lights, as many plugs are exposed.
function isSwitchEntity(entityId: string): boolean {
  return ["switch.", "light.", "input_boolean."].some((prefix) =>
    entityId.startsWith(prefix),
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function selectValue(target: EventTarget | null): string {
  return target instanceof HTMLSelectElement ? target.value : "";
}

function numberOrNull(target: EventTarget | null): number | null {
  const value = selectValue(target);
  return value === "" ? null : Number(value);
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
