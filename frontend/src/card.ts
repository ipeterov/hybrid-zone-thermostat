import { css, html, LitElement, nothing } from "lit";

import { friendlyName, type Hass, type HassEntity } from "./hass";
import {
  degrees,
  isZone,
  readZone,
  unitWord,
  wholeDegrees,
  type Zone,
  type ZoneUnit,
  zoneWord,
} from "./zone";

interface ZoneCardConfig {
  type: string;
  entity: string;
}

const STEP = 0.5;
const BAND_LOW = 16;
const BAND_HIGH = 30;

function ago(isoTime: string | undefined, now: number): string | undefined {
  if (!isoTime) {
    return undefined;
  }
  const seconds = Math.max(0, Math.round((now - Date.parse(isoTime)) / 1000));
  if (seconds < 60) {
    return `${seconds} s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60
    ? `${minutes} min ago`
    : `${Math.round(minutes / 60)} h ago`;
}

// The dashboard card for one zone (docs/design/dashboard-zone-card.html):
// the room against its target, what HZT decided and why, and its room
// units with the controls that stay the user's (fan, swing).
export class HztZoneCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    config: { state: true },
  };

  hass?: Hass;
  config?: ZoneCardConfig;

  static getStubConfig(hass: Hass): ZoneCardConfig {
    const zone = Object.values(hass.states).find((e) => isZone(e));
    return { type: "custom:hzt-zone-card", entity: zone?.entity_id ?? "" };
  }

  setConfig(config: ZoneCardConfig): void {
    if (!config.entity) {
      throw new Error("Set `entity` to a zone’s climate entity.");
    }
    this.config = config;
  }

  getCardSize(): number {
    return 6;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  // HA's conventions: a card opens the entity's more-info dialog, and
  // navigates by pushing history and announcing it.
  private moreInfo(entityId: string) {
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private navigate(path: string) {
    history.pushState(null, "", path);
    window.dispatchEvent(
      new CustomEvent("location-changed", { detail: { replace: false } }),
    );
  }

  // A click anywhere on the card that isn't on one of its controls opens
  // the zone's more-info, as tile and thermostat cards do.
  private onCardClick(event: MouseEvent, entityId: string) {
    const interactive = event
      .composedPath()
      .some(
        (node) =>
          node instanceof HTMLElement &&
          ["BUTTON", "SELECT", "A", "LABEL", "OPTION"].includes(node.tagName),
      );
    if (!interactive) {
      this.moreInfo(entityId);
    }
  }

  private settingsPath(zone: Zone): string {
    return `/climate-zones?zone=${encodeURIComponent(zone.id)}`;
  }

  private call(
    service: string,
    data: Record<string, unknown>,
    domain = "climate",
  ) {
    return this.hass?.callService(domain, service, data);
  }

  protected render() {
    if (!(this.hass && this.config)) {
      return nothing;
    }
    const entity = this.hass.states[this.config.entity];
    if (!isZone(entity)) {
      return html`<ha-card class="missing">
        <p role="alert">
          ${this.config.entity} isn’t a Hybrid Zone Thermostat zone.
        </p>
      </ha-card>`;
    }
    const zone = readZone(entity as HassEntity);
    const word = zoneWord(zone);
    return html`<ha-card @click=${(e: MouseEvent) => this.onCardClick(e, zone.entityId)}>
      <div class="head">
        <h2>
          <button class="link" @click=${() => this.moreInfo(zone.entityId)}>
            ${zone.name}
          </button>
        </h2>
        ${word ? html`<span class="chip ${zone.state ?? ""}">${word}</span>` : nothing}
        <button
          class="icon power ${zone.enabled ? "on" : ""}"
          aria-label=${zone.enabled ? `Turn ${zone.name} off` : `Turn ${zone.name} on`}
          aria-pressed=${zone.enabled ? "true" : "false"}
          @click=${() =>
            this.call(zone.enabled ? "turn_off" : "turn_on", {
              entity_id: zone.entityId,
            })}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M12 3v8M6.3 7.3a8 8 0 1 0 11.4 0" />
          </svg>
        </button>
        <a
          class="icon settings"
          href=${this.settingsPath(zone)}
          aria-label="${zone.name} settings"
          @click=${(e: MouseEvent) => {
            e.preventDefault();
            this.navigate(this.settingsPath(zone));
          }}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
            />
          </svg>
        </a>
      </div>
      ${this.renderNumbers(zone)} ${this.renderBand(zone)}
      ${
        zone.reason && zone.state !== "off"
          ? html`<p class="reason"><strong>Why:</strong> ${zone.reason}</p>`
          : nothing
      }
      ${
        zone.shadow
          ? html`<p class="small">
            Shadow mode: HZT decides but sends nothing to the units.
            <a
              href=${this.settingsPath(zone)}
              @click=${(e: MouseEvent) => {
                e.preventDefault();
                this.navigate(this.settingsPath(zone));
              }}
              >Go live in Climate zones</a
            >
          </p>`
          : nothing
      }
      ${this.renderUnits(zone)}
    </ha-card>`;
  }

  private renderNumbers(zone: Zone) {
    const sensor = zone.roomSensor
      ? this.hass?.states[zone.roomSensor]
      : undefined;
    const sensorName = zone.roomSensor
      ? friendlyName(this.hass as Hass, zone.roomSensor)
      : "No room sensor";
    const age = ago(sensor?.last_updated, Date.now());
    const target = zone.target;
    const glow = this.runningMode(zone);
    return html`<div class="numbers">
      <div class="room ${glow ? `glow ${glow}` : ""}">
        <span class="label">Room</span>
        <span class="big"
          >${zone.room === undefined ? "–" : zone.room.toFixed(1)}<span
            class="unit"
            >°C</span
          ></span
        >
        <span class="small"
          >${
            zone.roomSensor
              ? html`<button
                class="link"
                @click=${() => this.moreInfo(zone.roomSensor as string)}
              >
                ${sensorName}
              </button>`
              : sensorName
          }${age ? ` · ${age}` : ""}</span
        >
      </div>
      ${
        target === undefined
          ? nothing
          : html`<div class="target">
            <button
              class="step"
              aria-label="Lower the target"
              @click=${() =>
                this.call("set_temperature", {
                  entity_id: zone.entityId,
                  temperature: target - STEP,
                })}
            >
              −
            </button>
            <div class="target-value">
              <span class="label">Target</span>
              <span class="mid">${target.toFixed(1)}</span>
            </div>
            <button
              class="step"
              aria-label="Raise the target"
              @click=${() =>
                this.call("set_temperature", {
                  entity_id: zone.entityId,
                  temperature: target + STEP,
                })}
            >
              +
            </button>
          </div>`
      }
    </div>`;
  }

  // What the zone's units are actually doing, read from the devices
  // themselves: true in shadow mode too.
  private runningMode(zone: Zone): "heat" | "cool" | undefined {
    for (const unit of zone.units) {
      const action = this.hass?.states[unit.entity_id]?.attributes.hvac_action;
      if (action === "heating") {
        return "heat";
      }
      if (action === "cooling") {
        return "cool";
      }
    }
    return undefined;
  }

  // A sensor on the same device reporting a frequency, as an AC's
  // compressor does.
  private compressor(device: HassEntity): string | undefined {
    const deviceId = this.hass?.entities?.[device.entity_id]?.device_id;
    if (!(deviceId && this.hass)) {
      return undefined;
    }
    for (const [entityId, entry] of Object.entries(this.hass.entities ?? {})) {
      if (entry.device_id !== deviceId) {
        continue;
      }
      const state = this.hass.states[entityId];
      if (
        state?.attributes.device_class === "frequency" &&
        Number(state.state) > 0
      ) {
        return `${Number(state.state)} ${state.attributes.unit_of_measurement ?? "Hz"}`;
      }
    }
    return undefined;
  }

  // The device's own state, so the dashboard needs no separate tile.
  private deviceSummary(device: HassEntity | undefined): string {
    if (!device) {
      return "Not found in Home Assistant";
    }
    if (device.state === "unavailable") {
      return "Unavailable";
    }
    const a = device.attributes;
    const parts: string[] = [];
    const action =
      typeof a.hvac_action === "string" ? a.hvac_action : undefined;
    if (device.state === "off") {
      parts.push("Off");
    } else {
      parts.push(
        capitalize(action && action !== "off" ? action : device.state),
      );
      if (typeof a.temperature === "number") {
        parts.push(`set ${a.temperature} °C`);
      }
    }
    if (typeof a.current_temperature === "number") {
      parts.push(`reads ${a.current_temperature} °C`);
    }
    const compressor = this.compressor(device);
    if (compressor) {
      parts.push(`compressor ${compressor}`);
    }
    return parts.join(" · ");
  }

  // Heating below the target, idle up to target + band, cooling above.
  private renderBand(zone: Zone) {
    const target = zone.target;
    if (target === undefined || !zone.enabled) {
      return nothing;
    }
    const coolFrom = target + zone.idleBand;
    const room = zone.room;
    // A fixed scale, so changing the target moves its ticks, not the room.
    // Widened only when something falls outside it.
    const low = Math.floor(
      Math.min(BAND_LOW, target - 1, (room ?? target) - 1),
    );
    const high = Math.ceil(
      Math.max(BAND_HIGH, coolFrom + 1, (room ?? target) + 1),
    );
    const at = (t: number) =>
      `${(((Math.min(Math.max(t, low), high) - low) / (high - low)) * 100).toFixed(2)}%`;
    return html`<div
      class="band"
      role="img"
      aria-label="Heats below ${degrees(target)}, idle up to ${degrees(coolFrom)}, cools above${
        room === undefined ? "" : `; the room is ${degrees(room)}`
      }"
    >
      <div class="band-labels">
        <span class="heat-text" style="left:${at((low + target) / 2)}">Heating</span>
        <span class="muted" style="left:${at((target + coolFrom) / 2)}">Idle</span>
        <span class="cool-text" style="left:${at((coolFrom + high) / 2)}">Cooling</span>
      </div>
      <div class="band-track">
        <span class="seg heat" style="left:0;width:${at(target)}"></span>
        <span
          class="seg idle"
          style="left:${at(target)};right:calc(100% - ${at(coolFrom)})"
        ></span>
        <span class="seg cool" style="left:${at(coolFrom)};right:0"></span>
        <span class="tick" style="left:${at(target)}"></span>
        <span class="tick" style="left:${at(coolFrom)}"></span>
        ${room === undefined ? nothing : html`<span class="pin" style="left:${at(room)}"></span>`}
      </div>
      <div class="band-scale">
        <span style="left:0">${low}</span>
        <span class="strong" style="left:${at(target)}">${target.toFixed(1)}</span>
        <span class="strong" style="left:${at(coolFrom)}">${coolFrom.toFixed(1)}</span>
        <span style="right:0">${high}</span>
      </div>
    </div>`;
  }

  private renderUnits(zone: Zone) {
    if (zone.units.length === 0) {
      return html`<p class="small">
        No room units yet: add them on the Climate zones page.
      </p>`;
    }
    // The order that applies is the one for what the zone is doing; idle
    // or off, neither does, so units keep the order they were set up in.
    const direction = activeDirection(zone);
    const rankOf = (u: ZoneUnit) =>
      direction === "heat"
        ? u.heat_rank
        : direction === "cool"
          ? u.cool_rank
          : null;
    const units = direction
      ? [...zone.units].sort((a, b) => (rankOf(a) ?? 99) - (rankOf(b) ?? 99))
      : zone.units;
    let heading = "Room units";
    if (units.length === 1) {
      heading = "Room unit";
    } else if (direction) {
      heading = `Room units, in ${direction === "heat" ? "heating" : "cooling"} order`;
    }
    return html`<div class="units">
      <h3 class="eyebrow">${heading}</h3>
      ${units.map((unit) => this.renderUnit(zone, unit, rankOf(unit)))}
    </div>`;
  }

  private renderUnit(zone: Zone, unit: ZoneUnit, rank: number | null) {
    const device = this.hass?.states[unit.entity_id];
    const demand = zone.demands[unit.id];
    const word = unitWord(zone, unit);
    const hzt: string[] = [
      `HZT: ${word.charAt(0).toLowerCase()}${word.slice(1)}`,
    ];
    if (word === "Locked out") {
      const t =
        zone.state === "heating"
          ? unit.heat_lockout_below
          : unit.cool_lockout_below;
      if (t !== null) {
        hzt.push(`below ${wholeDegrees(t)} outdoor`);
      }
    }
    if (unit.duty) {
      hzt.push(unit.duty);
    }
    if (unit.note) {
      hzt.push(unit.note);
    }
    const fanModes = device?.attributes.fan_modes;
    const swingModes = device?.attributes.swing_modes;
    return html`<div class="unit-row">
      <span
        class="rank ${zone.units.length > 1 && rank ? "" : "dot"} ${demand?.mode ?? ""} ${
          word === "Locked out" ? "locked" : ""
        }"
        >${zone.units.length > 1 && rank ? rank : ""}</span
      >
      <div class="unit-text">
        <button class="link unit-name" @click=${() => this.moreInfo(unit.entity_id)}>
          ${unit.name}
        </button>
        <span class="small device">${this.deviceSummary(device)}</span>
        <span class="small">${hzt.join(" · ")}</span>
      </div>
      ${
        Array.isArray(fanModes) && device
          ? this.renderMode(
              unit,
              "Fan",
              "fan_mode",
              "set_fan_mode",
              device,
              fanModes,
            )
          : nothing
      }
      ${
        Array.isArray(swingModes) && device
          ? this.renderMode(
              unit,
              "Swing",
              "swing_mode",
              "set_swing_mode",
              device,
              swingModes,
            )
          : nothing
      }
    </div>`;
  }

  private renderMode(
    unit: ZoneUnit,
    label: string,
    attribute: string,
    service: string,
    device: HassEntity,
    modes: unknown[],
  ) {
    const current = device.attributes[attribute];
    return html`<label class="mode">
      ${label}
      <select
        aria-label="${unit.name} ${label.toLowerCase()}"
        ?disabled=${device.state === "unavailable"}
        @change=${(event: Event) =>
          this.call(service, {
            entity_id: unit.entity_id,
            [attribute]: (event.target as HTMLSelectElement).value,
          })}
      >
        ${modes.map(
          (
            mode,
          ) => html`<option value=${String(mode)} ?selected=${mode === current}>
            ${capitalize(String(mode))}
          </option>`,
        )}
      </select>
    </label>`;
  }

  static styles = css`
    :host {
      --hzt-text: var(--primary-text-color, #1c1f23);
      --hzt-muted: var(--secondary-text-color, #5f6368);
      --hzt-subtle: var(--secondary-background-color, #f1f3f4);
      --hzt-border: var(--divider-color, #e3e5e8);
      --hzt-card: var(--card-background-color, #fff);
      --hzt-heat: var(--state-climate-heat-color, #ff8100);
      --hzt-cool: var(--state-climate-cool-color, #2b7fd4);
      display: block;
    }
    ha-card {
      display: flex;
      flex-direction: column;
      gap: 16px;
      padding: 16px;
      box-sizing: border-box;
      color: var(--hzt-text);
      font-family: var(--ha-font-family-body, Roboto, system-ui, sans-serif);
      background: var(--ha-card-background, var(--hzt-card));
      border-radius: var(--ha-card-border-radius, 12px);
      border: var(--ha-card-border-width, 1px) solid
        var(--ha-card-border-color, var(--hzt-border));
    }
    h2 {
      margin: 0;
      flex: 1;
      font-size: 18px;
      font-weight: 500;
    }
    p {
      margin: 0;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .chip {
      border-radius: 999px;
      padding: 4px 12px;
      font-size: 13px;
      font-weight: 500;
      background: var(--hzt-subtle);
      white-space: nowrap;
    }
    .chip.heating {
      background: color-mix(in srgb, var(--hzt-heat) 18%, var(--hzt-card));
    }
    .chip.cooling {
      background: color-mix(in srgb, var(--hzt-cool) 18%, var(--hzt-card));
    }
    button {
      font: inherit;
      color: var(--hzt-text);
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .icon.power {
      width: 40px;
      height: 40px;
      flex: none;
      border-radius: 12px;
      border: 1px solid var(--hzt-border);
      background: none;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--hzt-muted);
    }
    .icon.settings {
      width: 40px;
      height: 40px;
      flex: none;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--hzt-muted);
    }
    .icon.settings:hover {
      background: var(--hzt-subtle);
    }
    .icon.settings circle,
    .icon.settings path {
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
    }
    ha-card {
      cursor: pointer;
    }
    button.link {
      border: 0;
      background: none;
      padding: 0;
      margin: 0;
      font: inherit;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }
    button.link:hover {
      text-decoration: underline;
    }
    a {
      color: var(--primary-color, #0277bd);
    }
    .room {
      isolation: isolate;
    }
    .room .big {
      position: relative;
    }
    /* A soft glow behind the room temperature while a unit is actually
       heating or cooling, as HA's own climate controls colour by action. */
    .room.glow .big::before {
      content: "";
      position: absolute;
      z-index: -1;
      left: 50%;
      top: 50%;
      width: 220px;
      height: 150px;
      transform: translate(-50%, -50%);
      background: radial-gradient(
        closest-side,
        var(--glow-color) 0%,
        transparent 100%
      );
      opacity: 0.4;
      pointer-events: none;
    }
    .room.glow.heat {
      --glow-color: var(--hzt-heat);
    }
    .room.glow.cool {
      --glow-color: var(--hzt-cool);
    }
    .unit-text .device {
      color: var(--hzt-text);
    }
    .icon.power.on {
      color: var(--hzt-text);
    }
    .icon.power path {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
    }
    .numbers {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px 24px;
      flex-wrap: wrap;
    }
    .room,
    .target-value {
      display: flex;
      flex-direction: column;
    }
    .label {
      font-size: 13px;
      color: var(--hzt-muted);
    }
    .big {
      font-size: 48px;
      line-height: 1.05;
    }
    .unit {
      font-size: 20px;
      color: var(--hzt-muted);
      margin-left: 2px;
    }
    .mid {
      font-size: 30px;
      font-weight: 500;
      line-height: 1.1;
    }
    .target {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .target-value {
      align-items: center;
      min-width: 80px;
    }
    .step {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      border: 0;
      background: var(--hzt-subtle);
      font-size: 22px;
    }
    .small {
      font-size: 13px;
      line-height: 1.45;
      color: var(--hzt-muted);
    }
    .reason {
      background: var(--hzt-subtle);
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 14px;
      line-height: 1.5;
    }
    .reason strong {
      font-weight: 500;
    }

    /* The band: everything slides to its new place. */
    .band .seg,
    .band .tick,
    .band .pin,
    .band-labels span,
    .band-scale span {
      transition:
        left 300ms ease,
        right 300ms ease,
        width 300ms ease;
    }
    @media (prefers-reduced-motion: reduce) {
      .band .seg,
      .band .tick,
      .band .pin,
      .band-labels span,
      .band-scale span {
        transition: none;
      }
    }
    .band {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .band-labels,
    .band-scale {
      position: relative;
      height: 18px;
      font-size: 12px;
    }
    .band-labels span,
    .band-scale span {
      position: absolute;
      top: 0;
      white-space: nowrap;
    }
    .band-labels span {
      transform: translateX(-50%);
      font-weight: 500;
    }
    .band-scale span {
      font-family: var(--ha-font-family-code, ui-monospace, monospace);
      font-size: 11px;
      color: var(--hzt-muted);
    }
    .band-scale span.strong {
      transform: translateX(-50%);
      color: var(--hzt-text);
    }
    .heat-text {
      color: color-mix(in srgb, var(--hzt-heat) 75%, var(--hzt-text));
    }
    .cool-text {
      color: color-mix(in srgb, var(--hzt-cool) 75%, var(--hzt-text));
    }
    .muted {
      color: var(--hzt-muted);
    }
    .band-track {
      position: relative;
      height: 16px;
    }
    .seg {
      position: absolute;
      top: 4px;
      height: 8px;
    }
    .seg.heat {
      background: color-mix(in srgb, var(--hzt-heat) 40%, var(--hzt-card));
      border-radius: 4px 0 0 4px;
    }
    .seg.idle {
      background: var(--hzt-subtle);
    }
    .seg.cool {
      background: color-mix(in srgb, var(--hzt-cool) 40%, var(--hzt-card));
      border-radius: 0 4px 4px 0;
    }
    .tick {
      position: absolute;
      top: 0;
      width: 2px;
      height: 16px;
      margin-left: -1px;
      background: var(--hzt-muted);
    }
    .pin {
      position: absolute;
      top: 0;
      width: 16px;
      height: 16px;
      margin-left: -8px;
      box-sizing: border-box;
      border-radius: 8px;
      background: var(--hzt-text);
      border: 3px solid var(--hzt-card);
      box-shadow: 0 0 0 1px var(--hzt-text);
    }

    /* Units */
    .units {
      display: flex;
      flex-direction: column;
    }
    .eyebrow {
      margin: 0 0 4px;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--hzt-muted);
    }
    .unit-row {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      padding: 10px 0;
      border-top: 1px solid var(--hzt-border);
    }
    .rank {
      width: 26px;
      height: 26px;
      flex: none;
      box-sizing: border-box;
      border-radius: 13px;
      border: 2px solid var(--hzt-border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      color: var(--hzt-muted);
    }
    .rank.heat {
      border: 0;
      background: var(--hzt-heat);
      color: #fff;
    }
    .rank.cool {
      border: 0;
      background: var(--hzt-cool);
      color: #fff;
    }
    .rank.locked {
      border-style: dashed;
    }
    /* One unit: no rank to show, just whether it's running. */
    .rank.dot {
      width: 12px;
      height: 12px;
      margin: 0 7px;
      border: 0;
      background: var(--hzt-border);
    }
    .rank.dot.heat {
      background: var(--hzt-heat);
    }
    .rank.dot.cool {
      background: var(--hzt-cool);
    }
    .unit-text {
      flex: 1 1 180px;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .unit-name {
      font-size: 15px;
      font-weight: 500;
    }
    .mode {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--hzt-muted);
    }
    .mode select {
      height: 36px;
      border-radius: 10px;
      border: 0;
      background: var(--hzt-subtle);
      color: var(--hzt-text);
      padding: 0 8px;
      font: inherit;
      font-size: 13px;
    }
    .missing p {
      font-size: 14px;
    }
  `;
}

function activeDirection(zone: Zone): "heat" | "cool" | undefined {
  if (zone.state === "heating") {
    return "heat";
  }
  if (zone.state === "cooling") {
    return "cool";
  }
  return undefined;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, " ");
}

customElements.define("hzt-zone-card", HztZoneCard);

// Lists the card in the dashboard's card picker.
declare global {
  interface Window {
    customCards?: { type: string; name: string; description: string }[];
  }
}
window.customCards ??= [];
window.customCards.push({
  type: "hzt-zone-card",
  name: "HZT zone",
  description:
    "One climate zone: the room against its target, what HZT decided and why, and its units.",
});
