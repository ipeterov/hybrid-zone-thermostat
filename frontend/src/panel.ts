import { html, LitElement, nothing, svg } from "lit";

import {
  addRoomUnit,
  addZone,
  moveRoomUnit,
  removeRoomUnit,
  removeZone,
  setOutdoorSensor,
  unitsOf,
  updateZone,
} from "./config";
import {
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

type Aside = { kind: "zone" } | { kind: "new-zone" } | { kind: "new-unit" };

interface Demand {
  mode: "heat" | "cool" | null;
  level: number;
}

interface ZoneStatus {
  state?: string;
  shadow: boolean;
  room?: number;
  reason?: string;
  demands: Record<string, Demand>;
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

  private loading = false;
  private observed?: Element;
  private resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width;
    if (width && Math.abs(width - this.mapWidth) > 1) {
      this.mapWidth = width;
    }
  });

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
    };
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
        ${this.renderMapCard(config, zone)} ${this.renderHouse(config)}
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
          @click=${() => {
            this.aside = { kind: "new-unit" };
          }}
        >
          + Room unit
        </button>
        <button
          class="pill"
          @click=${() => {
            this.aside = { kind: "new-zone" };
          }}
        >
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
            zone === selected,
          ),
        )}
      </div>
    </div>`;
  }

  private renderUnitNode(
    config: HouseConfig,
    unit: RoomUnit,
    column: Column,
    top: number,
  ) {
    const status = this.status(unit.zone_id);
    const demand = status.demands[unit.id];
    const rank = unitsOf(config, unit.zone_id).indexOf(unit) + 1;
    const available =
      this.hass?.states[unit.entity_id]?.state !== "unavailable";
    let word = "idle";
    if (!available) {
      word = "unavailable";
    } else if (demand?.mode) {
      const verb = demand.mode === "heat" ? "heat" : "cool";
      word = status.shadow ? `would ${verb}` : `${verb}ing`;
    } else if (status.state === "heating" || status.state === "cooling") {
      word = "standby";
    }
    return html`<div
      class="node unit ${demand?.mode ?? ""} ${available ? "" : "gone"}"
      style="left:${column.x}px;top:${top}px;width:${column.w}px"
    >
      <span class="node-name">${unit.name}</span>
      <span class="node-sub">${capitalize(word)} · #${rank}</span>
    </div>`;
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
        this.aside = { kind: "zone" };
      }}
    >
      <span class="node-name">${zone.name}</span>
      <span class="node-sub"
        >${room} → ${zone.target.toFixed(1)}${word ? ` · ${word}` : ""}</span
      >
    </button>`;
  }

  // ---- House-wide settings -------------------------------------------

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

  private renderHouse(config: HouseConfig) {
    return html`<section class="card">
      <h2>House</h2>
      <label class="field narrow">
        Outdoor temperature
        <select
          @change=${(event: Event) =>
            this.save(
              setOutdoorSensor(config, selectValue(event.target) || null),
            )}
        >
          ${this.temperatureOptions(config.house.outdoor_sensor)}
        </select>
      </label>
    </section>`;
  }

  // ---- The side panel --------------------------------------------------

  private renderAside(config: HouseConfig, zone: Zone | undefined) {
    if (this.aside.kind === "new-zone" || !zone) {
      return this.renderNewZone(config, Boolean(zone));
    }
    if (this.aside.kind === "new-unit") {
      return this.renderNewUnit(config, zone);
    }
    return this.renderZoneDetails(config, zone);
  }

  private renderZoneDetails(config: HouseConfig, zone: Zone) {
    const status = this.status(zone.id);
    const word = stateWord(status);
    const units = unitsOf(config, zone.id);
    const heating = units.filter((u) => u.can_heat);
    const cooling = units.filter((u) => u.can_cool);
    const coolFrom = (zone.target + zone.idle_band).toFixed(1);
    return html`<div class="side-head">
        <span class="eyebrow">Selected zone</span>
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
      ${
        status.shadow
          ? html`<p class="small">
            Shadow mode: HZT decides but sends nothing to the units yet.
          </p>`
          : nothing
      }
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
          <small>Cools above ${coolFrom} °C</small>
        </label>
        <div class="fact">
          <span>Target</span>
          <strong>${zone.target.toFixed(1)} °C</strong>
          <small>Set on its thermostat</small>
        </div>
      </div>

      <h3 class="eyebrow">Heating order</h3>
      ${this.renderOrder(config, zone, heating, "heat")}
      <h3 class="eyebrow">Cooling order</h3>
      ${this.renderOrder(config, zone, cooling, "cool")}
      <p class="small">
        A unit that can’t run right now is skipped; the next one moves up.
      </p>
      <div class="side-actions">
        <button
          class="pill"
          @click=${() => {
            this.aside = { kind: "new-unit" };
          }}
        >
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

  private renderOrder(
    config: HouseConfig,
    zone: Zone,
    units: RoomUnit[],
    mode: "heat" | "cool",
  ) {
    if (units.length === 0) {
      return html`<p class="small">
        No unit here ${mode === "heat" ? "heats" : "cools"}.
      </p>`;
    }
    const demands = this.status(zone.id).demands;
    return html`<ol class="order" aria-label="${capitalize(mode)}ing order">
      ${units.map((unit, index) => {
        const running = demands[unit.id]?.mode === mode;
        let rule: string;
        if (index === 0) {
          rule =
            mode === "heat"
              ? "Runs whenever the room is below target"
              : "Runs whenever the room is above the idle band";
        } else {
          rule = `Joins when ${index === 1 ? "#1" : `#1–${index}`} can’t keep up`;
        }
        return html`<li>
          <span class="rank ${running ? mode : ""}">${index + 1}</span>
          <span class="order-text">
            <span class="order-name">${unit.name}</span>
            <span class="order-rule">${rule}</span>
          </span>
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
          <button
            class="icon danger"
            aria-label="Remove ${unit.name}"
            @click=${() => this.save(removeRoomUnit(config, unit.id))}
          >
            ✕
          </button>
        </li>`;
      })}
    </ol>`;
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
        this.aside = { kind: "zone" };
      }
    };
    return html`<form class="side-form" @submit=${add}>
      <h2 class="big">New zone</h2>
      <p class="small">
        Something with one target temperature: a room, or an open-plan space.
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
      </label>
      <div class="side-actions">
        <button type="submit" class="primary">Add zone</button>
        ${
          canCancel
            ? html`<button
              type="button"
              class="pill"
              @click=${() => {
                this.aside = { kind: "zone" };
              }}
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
    const candidates = Object.values(this.hass?.states ?? {})
      .filter(
        (entity) =>
          entity.entity_id.startsWith("climate.") &&
          entity.attributes.hzt_zone_id === undefined &&
          !used.has(entity.entity_id),
      )
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    const add = async (event: Event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const entityId = new FormData(form).get("entity_id");
      if (typeof entityId !== "string" || !entityId || !this.hass) {
        return;
      }
      const modes = this.hass.states[entityId]?.attributes.hvac_modes;
      const hvacModes = Array.isArray(modes) ? modes : [];
      const saved = await this.save(
        addRoomUnit(config, {
          name: friendlyName(this.hass, entityId),
          entity_id: entityId,
          zone_id: zone.id,
          can_heat: hvacModes.includes("heat") || hvacModes.length === 0,
          can_cool: hvacModes.includes("cool"),
        }),
      );
      if (saved) {
        this.aside = { kind: "zone" };
      }
    };
    return html`<form class="side-form" @submit=${add}>
      <span class="eyebrow">${zone.name}</span>
      <h2 class="big">New room unit</h2>
      <p class="small">
        Whether it heats, cools or both is read from its modes. It joins the
        end of the zone’s order.
      </p>
      <label class="field">
        Climate entity
        <select name="entity_id" required>
          <option value="">Choose one</option>
          ${candidates.map(
            (entity) =>
              html`<option value=${entity.entity_id}>
                ${friendlyName(this.hass as Hass, entity.entity_id)}
              </option>`,
          )}
        </select>
      </label>
      <div class="side-actions">
        <button type="submit" class="primary">Add unit</button>
        <button
          type="button"
          class="pill"
          @click=${() => {
            this.aside = { kind: "zone" };
          }}
        >
          Cancel
        </button>
      </div>
    </form>`;
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
