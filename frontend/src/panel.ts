import { css, html, LitElement, nothing } from "lit";

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
  type Zone,
} from "./hass";

const SHADOW_VERBS: Record<string, string> = {
  heating: "Would heat",
  cooling: "Would cool",
  idle: "Idle",
  off: "Off",
  fault: "Fault",
  manual: "Manual",
};

const ACTIVE_VERBS: Record<string, string> = {
  ...SHADOW_VERBS,
  heating: "Heating",
  cooling: "Cooling",
};

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
  };

  hass?: Hass;
  narrow = false;
  config?: HouseConfig;
  error?: string;
  saveError?: string;

  private loading = false;

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
  }

  private async save(config: HouseConfig): Promise<void> {
    if (!this.hass) {
      return;
    }
    try {
      this.config = await this.hass.callWS<HouseConfig>({
        type: `${DOMAIN}/config/save`,
        config,
      });
      this.saveError = undefined;
    } catch (error) {
      this.saveError = messageOf(error);
    }
  }

  protected render() {
    return html`
      <header><h1>Climate zones</h1></header>
      <main>${this.renderBody()}</main>
    `;
  }

  private renderBody() {
    if (this.error) {
      return html`<p role="alert">Couldn’t load the zones: ${this.error}</p>`;
    }
    if (!(this.config && this.hass)) {
      return nothing;
    }
    const config = this.config;
    return html`
      ${
        this.saveError
          ? html`<p role="alert">Couldn’t save: ${this.saveError}</p>`
          : nothing
      }
      ${this.renderHouse(config)}
      ${
        config.zones.length === 0
          ? html`<p class="empty">No zones yet.</p>`
          : config.zones.map((zone) => this.renderZone(config, zone))
      }
      ${this.renderAddZone(config)}
    `;
  }

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
      <label class="field">
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

  private zoneStatus(zoneId: string): HassEntity | undefined {
    return Object.values(this.hass?.states ?? {}).find(
      (entity) =>
        entity.entity_id.startsWith("climate.") &&
        entity.attributes.hzt_zone_id === zoneId,
    );
  }

  private renderZone(config: HouseConfig, zone: Zone) {
    const status = this.zoneStatus(zone.id);
    const zoneState = status?.attributes.zone_state;
    const shadow = status?.attributes.shadow === true;
    const verbs = shadow ? SHADOW_VERBS : ACTIVE_VERBS;
    const room = status?.attributes.current_temperature;
    const units = unitsOf(config, zone.id);
    return html`<section class="card" aria-label=${zone.name}>
      <div class="zone-head">
        <h2>${zone.name}</h2>
        ${
          typeof zoneState === "string"
            ? html`<span class="chip">${verbs[zoneState] ?? zoneState}</span>`
            : nothing
        }
        <button
          class="text danger"
          @click=${() => this.save(removeZone(config, zone.id))}
        >
          Remove zone
        </button>
      </div>
      <p class="numbers">
        ${typeof room === "number" ? html`Room ${room.toFixed(1)} °C · ` : nothing}
        Target ${zone.target.toFixed(1)} °C
      </p>
      ${
        typeof status?.attributes.reason === "string"
          ? html`<p class="reason">
            <strong>Why:</strong> ${status.attributes.reason}
          </p>`
          : nothing
      }
      ${shadow ? html`<p class="note">Shadow mode: HZT decides but sends nothing to the units.</p>` : nothing}
      <label class="field">
        Room temperature
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
      <h3>Room units, in order</h3>
      ${
        units.length === 0
          ? html`<p class="empty">No room units yet.</p>`
          : html`<ol class="units">
            ${units.map(
              (unit, index) => html`<li>
                <span class="rank">${index + 1}</span>
                <span class="unit-name">
                  ${unit.name}
                  <small
                    >${[
                      unit.can_heat ? "heats" : "",
                      unit.can_cool ? "cools" : "",
                    ]
                      .filter(Boolean)
                      .join(" and ")}
                    · ${unit.entity_id}</small
                  >
                </span>
                <button
                  aria-label="Move ${unit.name} up"
                  ?disabled=${index === 0}
                  @click=${() => this.save(moveRoomUnit(config, unit.id, -1))}
                >
                  ↑
                </button>
                <button
                  aria-label="Move ${unit.name} down"
                  ?disabled=${index === units.length - 1}
                  @click=${() => this.save(moveRoomUnit(config, unit.id, 1))}
                >
                  ↓
                </button>
                <button
                  class="text danger"
                  @click=${() => this.save(removeRoomUnit(config, unit.id))}
                >
                  Remove
                </button>
              </li>`,
            )}
          </ol>`
      }
      ${this.renderAddUnit(config, zone)}
    </section>`;
  }

  private renderAddUnit(config: HouseConfig, zone: Zone) {
    const used = new Set(config.room_units.map((u) => u.entity_id));
    const candidates = Object.values(this.hass?.states ?? {})
      .filter(
        (entity) =>
          entity.entity_id.startsWith("climate.") &&
          entity.attributes.hzt_zone_id === undefined &&
          !used.has(entity.entity_id),
      )
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    const add = (event: Event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const entityId = new FormData(form).get("entity_id");
      if (typeof entityId !== "string" || !entityId || !this.hass) {
        return;
      }
      const modes = this.hass.states[entityId]?.attributes.hvac_modes;
      const hvacModes = Array.isArray(modes) ? modes : [];
      this.save(
        addRoomUnit(config, {
          name: friendlyName(this.hass, entityId),
          entity_id: entityId,
          zone_id: zone.id,
          can_heat: hvacModes.includes("heat") || hvacModes.length === 0,
          can_cool: hvacModes.includes("cool"),
        }),
      );
      form.reset();
    };
    return html`<form class="add" @submit=${add}>
      <label class="field">
        Add a room unit
        <select name="entity_id" required>
          <option value="">Choose a climate entity</option>
          ${candidates.map(
            (entity) =>
              html`<option value=${entity.entity_id}>
                ${friendlyName(this.hass as Hass, entity.entity_id)}
              </option>`,
          )}
        </select>
      </label>
      <button type="submit">Add unit</button>
    </form>`;
  }

  private renderAddZone(config: HouseConfig) {
    const add = (event: Event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      const data = new FormData(form);
      const name = String(data.get("name") ?? "").trim();
      if (!name) {
        return;
      }
      const sensor = String(data.get("room_sensor") ?? "") || null;
      this.save(addZone(config, name, sensor));
      form.reset();
    };
    return html`<form class="card add" @submit=${add}>
      <h2>New zone</h2>
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
      <button type="submit">Add zone</button>
    </form>`;
  }

  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      background: var(--primary-background-color, #f4f5f7);
      color: var(--primary-text-color, #1c1f23);
      font-family: var(--ha-font-family-body, Roboto, system-ui, sans-serif);
    }
    header {
      display: flex;
      align-items: center;
      min-height: 56px;
      padding: 0 24px;
      background: var(--card-background-color, #fff);
      border-bottom: 1px solid var(--divider-color, #e3e5e8);
    }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 500;
    }
    main {
      max-width: 880px;
      margin: 0 auto;
      padding: 24px 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card {
      background: var(--card-background-color, #fff);
      border: 1px solid var(--divider-color, #e3e5e8);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    h2 {
      margin: 0;
      font-size: 17px;
      font-weight: 500;
    }
    h3 {
      margin: 8px 0 0;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--secondary-text-color, #5f6368);
    }
    p {
      margin: 0;
    }
    .zone-head {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .zone-head h2 {
      flex: 1;
    }
    .chip {
      background: var(--secondary-background-color, #eceff1);
      border-radius: 999px;
      padding: 4px 12px;
      font-size: 13px;
      font-weight: 500;
    }
    .numbers {
      font-size: 15px;
    }
    .reason {
      background: var(--secondary-background-color, #f8f9fa);
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 14px;
      line-height: 1.5;
    }
    .reason strong {
      font-weight: 500;
    }
    .note,
    .empty {
      font-size: 13px;
      color: var(--secondary-text-color, #5f6368);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 13px;
      color: var(--secondary-text-color, #5f6368);
      flex: 1 1 240px;
    }
    select,
    input {
      height: 44px;
      border-radius: 8px;
      border: 1px solid var(--divider-color, #c4c7cc);
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color, #1c1f23);
      padding: 0 10px;
      font: inherit;
      font-size: 15px;
    }
    form.add {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 12px;
    }
    form.card.add h2 {
      flex-basis: 100%;
    }
    button {
      min-height: 44px;
      min-width: 44px;
      border-radius: 22px;
      border: 1px solid var(--divider-color, #c4c7cc);
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color, #1c1f23);
      padding: 0 16px;
      font: inherit;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }
    button[type="submit"] {
      background: var(--primary-color, #0277bd);
      border-color: transparent;
      color: var(--text-primary-color, #fff);
    }
    button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    button.text {
      border-color: transparent;
      background: none;
      padding: 0 8px;
    }
    button.danger {
      color: var(--error-color, #b00020);
    }
    .units {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
    }
    .units li {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0;
      border-top: 1px solid var(--divider-color, #eceef1);
    }
    .rank {
      width: 28px;
      height: 28px;
      flex: none;
      border-radius: 14px;
      border: 2px solid var(--divider-color, #c4c7cc);
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 700;
    }
    .unit-name {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      font-size: 15px;
      font-weight: 500;
    }
    .unit-name small {
      font-size: 12px;
      font-weight: 400;
      color: var(--secondary-text-color, #5f6368);
      overflow-wrap: anywhere;
    }
  `;
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
