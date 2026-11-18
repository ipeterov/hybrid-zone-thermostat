import { css, html, LitElement, nothing, svg } from "lit";

import { friendlyName, type Hass, type HassEntity } from "./hass";
import {
  bandEdges,
  degrees,
  isZone,
  readZone,
  tenths,
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

// The zone's own limits (climate.py: target step and range; the
// set_idle_band service's range).
const STEP = 0.5;
const MIN_TARGET = 5;
const MAX_TARGET = 35;
const MIN_BAND = 0.5;
const MAX_BAND = 5;

// The band's scale, fixed so that changing the target moves its handles,
// not the room. Widened only when something falls outside it.
const BAND_LOW = 16;
const BAND_HIGH = 30;

const HISTORY_HOURS = 24;
const HISTORY_REFRESH_MS = 5 * 60_000;
// How long a value the card sent is shown before HA confirms it.
const PENDING_MS = 5000;

interface HistoryPoint {
  time: number;
  room?: number;
  target?: number;
  band?: number;
  state?: string;
}

// When a room unit's device was actually heating or cooling.
type UnitActivity = { time: number; mode: "heat" | "cool" | null }[];

// What a device row says it's doing: a climate entity's action (its mode
// when it reports no action), a switch's or light's on.
function deviceMode(
  unit: ZoneUnit,
  state: string | undefined,
  attributes: Record<string, unknown>,
): "heat" | "cool" | null {
  if (unit.kind === "switch") {
    return state === "on" ? "heat" : null;
  }
  const action = attributes.hvac_action;
  if (typeof action === "string") {
    return action === "heating" ? "heat" : action === "cooling" ? "cool" : null;
  }
  return state === "heat" ? "heat" : state === "cool" ? "cool" : null;
}

// The band's three handles: the target, and the idle band's two edges,
// which move together, symmetric about the target.
type Handle = "target" | "low" | "high";

interface Drag {
  handle: Handle;
  target: number;
  band: number;
  // The scale, frozen while dragging so it doesn't move under the finger.
  low: number;
  high: number;
  // Degrees between where the handle was grabbed and its value, so it
  // doesn't jump to the pointer (an edge's label hangs beside its edge).
  grab: number;
}

interface Settings {
  target: number;
  band: number;
}

function clock(time: number): string {
  return new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

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
// the room against its target and band, the last day, what HZT decided and
// why, and its room units with the controls that stay the user's.
export class HztZoneCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    config: { state: true },
    history: { state: true },
    unitHistory: { state: true },
    drag: { state: true },
    pending: { state: true },
  };

  hass?: Hass;
  config?: ZoneCardConfig;
  history?: HistoryPoint[];
  unitHistory: Record<string, UnitActivity> = {};
  drag?: Drag;
  // What the card last sent, shown until HA's state catches up.
  pending?: Settings & { until: number };

  private historyTimer?: number;
  private historyKey?: string;

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
    return 8;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.historyTimer);
    this.historyTimer = undefined;
    this.historyKey = undefined;
  }

  private get zone(): Zone | undefined {
    const entity = this.config && this.hass?.states[this.config.entity];
    return isZone(entity) ? readZone(entity as HassEntity) : undefined;
  }

  protected willUpdate(): void {
    const zone = this.zone;
    if (this.pending && zone) {
      const confirmed =
        zone.target === this.pending.target &&
        zone.idleBand === this.pending.band;
      if (confirmed || Date.now() > this.pending.until) {
        this.pending = undefined;
      }
    }
  }

  protected updated(): void {
    // The history is fetched when the card appears, every few minutes,
    // and again once a new target or band is in HA's state.
    const zone = this.zone;
    if (!(zone && this.isConnected)) {
      return;
    }
    const key = `${zone.entityId}|${zone.target}|${zone.idleBand}`;
    if (key !== this.historyKey) {
      this.historyKey = key;
      this.loadHistory();
    }
    this.historyTimer ??= window.setInterval(
      () => this.loadHistory(),
      HISTORY_REFRESH_MS,
    );
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

  // The zone's last 24 hours from the recorder: room, target, band, state,
  // and what each room unit's device did.
  private async loadHistory() {
    const zone = this.zone;
    if (!(this.hass && zone)) {
      return;
    }
    const entityId = zone.entityId;
    // The room line comes from the room sensor, whose history is usually
    // longer than the zone's; the rest from the zone.
    const sensor = zone.roomSensor;
    const devices = zone.units.map((u) => u.entity_id);
    const start = new Date(Date.now() - HISTORY_HOURS * 3600_000);
    try {
      const result = await this.hass.callWS<
        Record<
          string,
          { s?: string; a?: Record<string, unknown>; lu: number }[]
        >
      >({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        entity_ids: [entityId, ...(sensor ? [sensor] : []), ...devices],
        minimal_response: false,
        no_attributes: false,
        significant_changes_only: false,
      });
      let last: Record<string, unknown> = {};
      const number = (value: unknown) =>
        typeof value === "number" ? value : undefined;
      const zonePoints: HistoryPoint[] = (result[entityId] ?? []).map((row) => {
        last = row.a ?? last;
        return {
          time: row.lu * 1000,
          room: sensor ? undefined : number(last.current_temperature),
          target: number(last.temperature),
          band: number(last.idle_band),
          state: typeof last.zone_state === "string" ? last.zone_state : "idle",
        };
      });
      const roomPoints: HistoryPoint[] = sensor
        ? (result[sensor] ?? []).flatMap((row) => {
            const value = Number(row.s);
            return Number.isFinite(value)
              ? [{ time: row.lu * 1000, room: value }]
              : [];
          })
        : [];
      this.history = [...zonePoints, ...roomPoints].sort(
        (a, b) => a.time - b.time,
      );
      this.unitHistory = Object.fromEntries(
        zone.units.map((unit) => {
          let attributes: Record<string, unknown> = {};
          let state: string | undefined;
          return [
            unit.id,
            (result[unit.entity_id] ?? []).map((row) => {
              attributes = row.a ?? attributes;
              state = row.s ?? state;
              return {
                time: row.lu * 1000,
                mode: deviceMode(unit, state, attributes),
              };
            }),
          ];
        }),
      );
    } catch {
      this.history = [];
      this.unitHistory = {};
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

  // ---- Target and band ---------------------------------------------------

  // What the band shows: the drag in progress, else what was just sent,
  // else HA's state.
  private settings(zone: Zone): Settings | undefined {
    if (this.drag) {
      return { target: this.drag.target, band: this.drag.band };
    }
    if (this.pending) {
      return { target: this.pending.target, band: this.pending.band };
    }
    return zone.target === undefined
      ? undefined
      : { target: zone.target, band: zone.idleBand };
  }

  private scale(zone: Zone, { target, band }: Settings) {
    if (this.drag) {
      return { low: this.drag.low, high: this.drag.high };
    }
    const room = zone.room ?? target;
    return {
      low: Math.floor(Math.min(BAND_LOW, target - band / 2 - 1, room - 1)),
      high: Math.ceil(Math.max(BAND_HIGH, target + band / 2 + 1, room + 1)),
    };
  }

  private commit(zone: Zone, { target, band }: Settings) {
    const changedTarget = target !== zone.target;
    const changedBand = band !== zone.idleBand;
    if (!(changedTarget || changedBand)) {
      return;
    }
    this.pending = { target, band, until: Date.now() + PENDING_MS };
    if (changedTarget) {
      this.call("set_temperature", {
        entity_id: zone.entityId,
        temperature: target,
      });
    }
    if (changedBand) {
      this.call(
        "set_idle_band",
        { entity_id: zone.entityId, idle_band: band },
        "hybrid_zone_thermostat",
      );
    }
  }

  // Where a handle would put things with the pointer at `t` degrees.
  private dragTo(drag: Drag, t: number): Settings {
    if (drag.handle === "target") {
      const half = drag.band / 2;
      return {
        target: clamp(
          Math.round(t / STEP) * STEP,
          Math.max(MIN_TARGET, drag.low + half),
          Math.min(MAX_TARGET, drag.high - half),
        ),
        band: drag.band,
      };
    }
    // An edge: the band widens or narrows around the target, in half
    // degrees, so each edge moves in quarters.
    const room = 2 * Math.min(drag.target - drag.low, drag.high - drag.target);
    return {
      target: drag.target,
      band: clamp(
        Math.round((2 * Math.abs(t - drag.target)) / STEP) * STEP,
        MIN_BAND,
        Math.min(MAX_BAND, room),
      ),
    };
  }

  private startDrag(event: PointerEvent, handle: Handle) {
    const zone = this.zone;
    const settings = zone && this.settings(zone);
    if (!(zone && settings) || event.button !== 0) {
      return;
    }
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    (event.currentTarget as HTMLElement).focus();
    const scale = this.scale(zone, settings);
    const { heatBelow, coolAbove } = bandEdges(settings.target, settings.band);
    const value = { target: settings.target, low: heatBelow, high: coolAbove }[
      handle
    ];
    const pointer = this.pointerDegrees(event, scale.low, scale.high);
    this.drag = {
      handle,
      ...settings,
      ...scale,
      grab: pointer === undefined ? 0 : pointer - value,
    };
  }

  private pointerDegrees(event: PointerEvent, low: number, high: number) {
    const track = this.renderRoot.querySelector(".band-track");
    if (!track) {
      return undefined;
    }
    const rect = track.getBoundingClientRect();
    return low + ((event.clientX - rect.left) / rect.width) * (high - low);
  }

  private moveDrag(event: PointerEvent) {
    const drag = this.drag;
    const pointer = drag && this.pointerDegrees(event, drag.low, drag.high);
    if (!(drag && pointer !== undefined)) {
      return;
    }
    const next = this.dragTo(drag, pointer - drag.grab);
    if (next.target !== drag.target || next.band !== drag.band) {
      this.drag = { ...drag, ...next };
    }
  }

  private endDrag(event: PointerEvent) {
    const drag = this.drag;
    const zone = this.zone;
    this.drag = undefined;
    if (drag && zone && event.type === "pointerup") {
      this.commit(zone, drag);
    }
  }

  // Arrow keys step a handle; for an edge, outward widens the band.
  private onHandleKey(event: KeyboardEvent, handle: Handle) {
    const zone = this.zone;
    const settings = zone && this.settings(zone);
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[
      event.key
    ];
    if (!(zone && settings && step)) {
      return;
    }
    event.preventDefault();
    if (handle === "target") {
      this.commit(zone, {
        ...settings,
        target: clamp(settings.target + step * STEP, MIN_TARGET, MAX_TARGET),
      });
    } else {
      const outward = handle === "high" ? step : -step;
      this.commit(zone, {
        ...settings,
        band: clamp(settings.band + outward * STEP, MIN_BAND, MAX_BAND),
      });
    }
  }

  // ---- Rendering ---------------------------------------------------------

  protected render() {
    if (!(this.hass && this.config)) {
      return nothing;
    }
    const zone = this.zone;
    if (!zone) {
      return html`<ha-card class="missing">
        <p role="alert">
          ${this.config.entity} isn’t a Hybrid Zone Thermostat zone.
        </p>
      </ha-card>`;
    }
    const glow = this.runningMode(zone);
    return html`<ha-card class=${glow ?? ""}>
      <div class="glow-clip" aria-hidden="true">
        <div class="aurora one ${glow ? "on" : ""}"></div>
        <div class="aurora two ${glow ? "on" : ""}"></div>
      </div>
      ${this.renderHead(zone)} ${this.renderNumbers(zone)}
      ${this.renderBand(zone)} ${this.renderHistory(zone)}
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

  private renderHead(zone: Zone) {
    const word = zoneWord(zone);
    return html`<div class="head">
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
    </div>`;
  }

  private renderNumbers(zone: Zone) {
    const sensor = zone.roomSensor
      ? this.hass?.states[zone.roomSensor]
      : undefined;
    const sensorName = zone.roomSensor
      ? friendlyName(this.hass as Hass, zone.roomSensor)
      : "No room sensor";
    const age = ago(sensor?.last_updated, Date.now());
    const settings = this.settings(zone);
    return html`<div class="numbers">
      <div class="room">
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
        settings === undefined
          ? nothing
          : html`<div class="target">
            <button
              class="step"
              aria-label="Lower the target"
              ?disabled=${settings.target <= MIN_TARGET}
              @click=${() =>
                this.commit(zone, {
                  ...settings,
                  target: settings.target - STEP,
                })}
            >
              −
            </button>
            <div class="target-value">
              <span class="label">Target</span>
              <span class="mid">${settings.target.toFixed(1)}</span>
            </div>
            <button
              class="step"
              aria-label="Raise the target"
              ?disabled=${settings.target >= MAX_TARGET}
              @click=${() =>
                this.commit(zone, {
                  ...settings,
                  target: settings.target + STEP,
                })}
            >
              +
            </button>
          </div>`
      }
    </div>`;
  }

  // Heating below the band, idle across it, cooling above; the band is
  // centred on the target. The target and both edges can be dragged.
  private renderBand(zone: Zone) {
    const settings = this.settings(zone);
    if (settings === undefined || !zone.enabled) {
      return nothing;
    }
    const { target, band } = settings;
    const { heatBelow, coolAbove } = bandEdges(target, band);
    const { low, high } = this.scale(zone, settings);
    const room = zone.room;
    const at = (t: number) =>
      `${((clamp(t, low, high) - low) / (high - low)) * 100}%`;
    const active = this.drag?.handle;
    const edges = [
      {
        which: "low" as const,
        value: heatBelow,
        label: "Heating starts below",
        text: `Heats below ${degrees(heatBelow)}`,
      },
      {
        which: "high" as const,
        value: coolAbove,
        label: "Cooling starts above",
        text: `Cools above ${degrees(coolAbove)}`,
      },
    ];
    return html`<div
      class="band ${this.drag ? "dragging" : ""}"
      @pointermove=${this.moveDrag}
      @pointerup=${this.endDrag}
      @pointercancel=${this.endDrag}
    >
      <div
        class="band-track"
        role="img"
        aria-label="Heats below ${degrees(heatBelow)}, idle up to ${degrees(coolAbove)}, cools above${
          room === undefined ? "" : `; the room is ${degrees(room)}`
        }"
      >
        <span class="seg heat" style="left:0;width:${at(heatBelow)}"></span>
        <span
          class="seg idle"
          style="left:${at(heatBelow)};right:calc(100% - ${at(coolAbove)})"
        ></span>
        <span class="seg cool" style="left:${at(coolAbove)};right:0"></span>
        <span class="tick" style="left:${at(heatBelow)}"></span>
        <span class="tick" style="left:${at(coolAbove)}"></span>
        <span
          class="knob ${active === "target" ? "active" : ""}"
          style="left:${at(target)}"
          role="slider"
          tabindex="0"
          aria-label="Target"
          aria-valuemin=${MIN_TARGET}
          aria-valuemax=${MAX_TARGET}
          aria-valuenow=${target}
          aria-valuetext="Target ${degrees(target)}"
          @pointerdown=${(e: PointerEvent) => this.startDrag(e, "target")}
          @keydown=${(e: KeyboardEvent) => this.onHandleKey(e, "target")}
        >
          <span class="knob-face"></span>
          <span class="bubble">${target.toFixed(1)}</span>
        </span>
        ${
          room === undefined
            ? nothing
            : html`<span class="pin" style="left:${at(room)}"></span>`
        }
      </div>
      <div class="band-scale">
        ${edges.map(
          (edge) => html`<span
            class="edge ${edge.which} ${active === edge.which ? "active" : ""}"
            style="--at:${at(edge.value)}"
            role="slider"
            tabindex="0"
            aria-label=${edge.label}
            aria-valuenow=${edge.value}
            aria-valuetext=${edge.text}
            @pointerdown=${(e: PointerEvent) => this.startDrag(e, edge.which)}
            @keydown=${(e: KeyboardEvent) => this.onHandleKey(e, edge.which)}
            >${edge.which === "low" ? "Heats below" : "Cools above"}
            <strong>${tenths(edge.value)}</strong></span
          >`,
        )}
      </div>
    </div>`;
  }

  // The last day: the room against the band as it was, and when HZT
  // heated or cooled.
  private renderHistory(zone: Zone) {
    const points = this.history;
    if (points === undefined) {
      return nothing;
    }
    const now = Date.now();
    const from = now - HISTORY_HOURS * 3600_000;
    const rooms = points.filter((p) => p.room !== undefined);
    if (zone.room !== undefined) {
      rooms.push({ time: now, room: zone.room });
    }
    if (rooms.length < 2) {
      return html`<p class="small">
        The last ${HISTORY_HOURS} hours show here once there’s some history.
      </p>`;
    }
    // Each zone row holds until the next, the last until now.
    const zoneRows = points.filter((p) => p.state !== undefined);
    const spans = zoneRows.map((p, i) => ({
      start: Math.max(p.time, from),
      end: zoneRows[i + 1]?.time ?? now,
      ...p,
    }));
    const temps = [
      ...rooms.map((p) => p.room as number),
      ...spans.flatMap((s) =>
        s.target === undefined
          ? []
          : [s.target - (s.band ?? 0) / 2, s.target + (s.band ?? 0) / 2],
      ),
    ];
    const low = Math.floor(Math.min(...temps) - 0.3);
    const high = Math.ceil(Math.max(...temps) + 0.3);
    const width = 600;
    const height = 104;
    const x = (time: number) =>
      ((Math.max(time, from) - from) / (now - from)) * width;
    const y = (value: number) =>
      height - ((value - low) / (high - low)) * height;

    // The band as one shape, so it has no seams: along its upper edge,
    // then back along its lower one, stepping where it changed.
    const set = spans.filter(
      (s): s is typeof s & { target: number; band: number } =>
        s.target !== undefined && s.band !== undefined,
    );
    const edgePath = (side: 1 | -1, list: typeof set) =>
      list
        .map((s) => {
          const level = y(s.target + (side * s.band) / 2);
          const [a, b] = side === 1 ? [s.start, s.end] : [s.end, s.start];
          return `L${x(a)} ${level} L${x(b)} ${level}`;
        })
        .join(" ");
    const bandPath = set.length
      ? `M${edgePath(1, set).slice(1)} ${edgePath(-1, [...set].reverse())} Z`
      : "";
    const targetPath = set.length
      ? `M${set
          .map(
            (s) => `${x(s.start)} ${y(s.target)} L${x(s.end)} ${y(s.target)}`,
          )
          .join(" L")}`
      : "";
    const roomPath = rooms
      .map((p, i) => `${i ? "L" : "M"}${x(p.time)} ${y(p.room as number)}`)
      .join(" ");
    // The temperature axis: whole degrees, a label every degree or two.
    const every = high - low > 6 ? 2 : 1;
    const ticks: number[] = [];
    for (let t = Math.ceil(low / every) * every; t <= high; t += every) {
      ticks.push(t);
    }
    return html`<section class="history">
      <div class="plot">
        <svg
          class="chart"
          viewBox="0 0 ${width} ${height}"
          preserveAspectRatio="none"
          role="img"
          aria-label="Room temperature against the idle band over the last ${HISTORY_HOURS} hours"
        >
          ${ticks.map(
            (t) =>
              svg`<line class="h-grid" x1="0" x2=${width} y1=${y(t)} y2=${y(t)}></line>`,
          )}
          <path class="h-idle" d=${bandPath}></path>
          <path class="h-target" d=${targetPath}></path>
          <path class="h-room" d=${roomPath}></path>
        </svg>
        ${ticks.map(
          (t) =>
            html`<span class="y-label" style="top:${(y(t) / height) * 100}%"
              >${t}°</span
            >`,
        )}
      </div>
      ${this.renderLanes(zone, from, now)}
      <div class="chart-scale">
        <span>${HISTORY_HOURS} h ago</span>
        <span>now</span>
      </div>
      <p class="legend">
        <span><span class="swatch room"></span>room</span>
        <span><span class="swatch idle"></span>idle band</span>
        <span><span class="swatch heat"></span>heating</span>
        <span><span class="swatch cool"></span>cooling</span>
      </p>
    </section>`;
  }

  // One lane per room unit under the chart, on the same time axis: when
  // its device was actually heating or cooling (shadow mode included).
  private renderLanes(zone: Zone, from: number, now: number) {
    const x = (time: number) =>
      ((Math.max(time, from) - from) / (now - from)) * 100;
    return zone.units.map((unit) => {
      const rows = this.unitHistory[unit.id] ?? [];
      const live = deviceMode(
        unit,
        this.hass?.states[unit.entity_id]?.state,
        this.hass?.states[unit.entity_id]?.attributes ?? {},
      );
      // Merged runs, the last until now (as the device is now).
      const runs: { mode: "heat" | "cool"; start: number; end: number }[] = [];
      const changes = [...rows, { time: now, mode: live }];
      changes.forEach((row, i) => {
        const end = changes[i + 1]?.time ?? now;
        const last = runs.at(-1);
        if (!row.mode || end <= from) {
          return;
        }
        if (last && last.mode === row.mode && last.end >= row.time) {
          last.end = end;
        } else {
          runs.push({ mode: row.mode, start: Math.max(row.time, from), end });
        }
      });
      return html`<div class="lane">
        <span class="lane-name">${unit.name}</span>
        <div
          class="lane-track"
          role="img"
          aria-label="${unit.name}: ${
            runs.length
              ? runs
                  .map(
                    (r) =>
                      `${r.mode === "heat" ? "heating" : "cooling"} ${clock(r.start)}–${r.end >= now ? "now" : clock(r.end)}`,
                  )
                  .join(", ")
              : `didn’t run in the last ${HISTORY_HOURS} hours`
          }"
        >
          ${runs.map(
            (r) =>
              html`<span
                class="run ${r.mode}"
                style="left:${x(r.start)}%;width:${Math.max(0.4, x(r.end) - x(r.start))}%"
              ></span>`,
          )}
        </div>
      </div>`;
    });
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
    .icon.power.on {
      color: var(--hzt-text);
    }
    .icon.power path {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
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
    /* The aurora: two overlapping glows behind the top of the card while
       a unit is actually heating or cooling, with no edge to read as a
       shape (the canvas's "zone card glow options", C). */
    ha-card {
      position: relative;
      overflow: hidden;
      isolation: isolate;
    }
    /* Our own clip, the card's exact size and shape. */
    .glow-clip {
      position: absolute;
      inset: 0;
      z-index: -1;
      overflow: hidden;
      border-radius: inherit;
      contain: paint;
      pointer-events: none;
    }
    .aurora {
      position: absolute;
      top: -60px;
      left: -60px;
      right: -60px;
      height: 380px;
      pointer-events: none;
      opacity: 0;
      transition: opacity 600ms ease;
    }
    .aurora.on {
      opacity: 1;
    }
    /* No filter: blur. WebKit (the HA app on Apple devices) doesn't clip
       blurred layers inside a rounded box, so the softness comes from the
       gradients' long falloff instead. */
    .aurora.one {
      background: radial-gradient(
        60% 75% at 18% 40%,
        color-mix(in srgb, var(--glow) 34%, transparent) 0%,
        color-mix(in srgb, var(--glow) 16%, transparent) 40%,
        transparent 80%
      );
    }
    .aurora.two {
      background: radial-gradient(
        50% 65% at 52% 24%,
        color-mix(in srgb, var(--glow-light) 14%, transparent) 0%,
        color-mix(in srgb, var(--glow-light) 6%, transparent) 45%,
        transparent 80%
      );
    }
    ha-card.heat {
      --glow: var(--hzt-heat);
      --glow-light: #ffbe5a;
    }
    ha-card.cool {
      --glow: var(--hzt-cool);
      --glow-light: #50c8ff;
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
      font-variant-numeric: tabular-nums;
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

    /* The band. Everything slides to its new place; while a handle is
       held, quickly, so it glides from step to step under the finger. */
    .band {
      display: flex;
      flex-direction: column;
      gap: 2px;
      user-select: none;
      -webkit-user-select: none;
    }
    .band .seg,
    .band .tick,
    .band .pin,
    .band .knob,
    .band-scale .edge {
      transition:
        left 300ms ease,
        right 300ms ease,
        width 300ms ease;
    }
    .band.dragging .seg,
    .band.dragging .tick,
    .band.dragging .knob,
    .band.dragging .edge {
      transition-duration: 110ms;
      transition-timing-function: ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      .band .seg,
      .band .tick,
      .band .pin,
      .band .knob,
      .band-scale .edge,
      .knob-face,
      .bubble {
        transition: none !important;
      }
    }
    .band-track {
      position: relative;
      height: 28px;
    }
    .seg {
      position: absolute;
      top: 10px;
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
      top: 6px;
      width: 2px;
      height: 16px;
      margin-left: -1px;
      background: var(--hzt-muted);
    }
    /* The room: a dot, under the target's ring when they meet. */
    .pin {
      position: absolute;
      top: 9px;
      width: 10px;
      height: 10px;
      margin-left: -5px;
      border-radius: 5px;
      background: var(--hzt-text);
      pointer-events: none;
    }
    /* The target: a ring to grab, with a 44 px hit area. */
    .knob {
      position: absolute;
      top: -8px;
      width: 44px;
      height: 44px;
      margin-left: -22px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
      touch-action: none;
      outline: none;
      z-index: 1;
    }
    .knob.active {
      cursor: grabbing;
    }
    .knob-face {
      width: 22px;
      height: 22px;
      box-sizing: border-box;
      border-radius: 50%;
      border: 3px solid var(--hzt-text);
      background: transparent;
      box-shadow: 0 0 0 3px var(--hzt-card);
      transition:
        transform 160ms ease,
        box-shadow 160ms ease;
    }
    .knob:hover .knob-face,
    .knob:focus-visible .knob-face {
      box-shadow:
        0 0 0 3px var(--hzt-card),
        0 0 0 9px color-mix(in srgb, var(--hzt-text) 14%, transparent);
    }
    .knob.active .knob-face {
      transform: scale(1.25);
      box-shadow:
        0 0 0 3px var(--hzt-card),
        0 0 0 10px color-mix(in srgb, var(--hzt-text) 18%, transparent);
    }
    .bubble {
      position: absolute;
      bottom: 40px;
      left: 50%;
      padding: 3px 8px;
      border-radius: 8px;
      background: var(--hzt-text);
      color: var(--hzt-card);
      font-size: 13px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transform: translate(-50%, 6px) scale(0.9);
      transition:
        opacity 140ms ease,
        transform 140ms ease;
    }
    .knob.active .bubble {
      opacity: 1;
      transform: translate(-50%, 0) scale(1);
    }
    /* The band's edges, as handles below it that say the rule: the lower
       one hangs left of its edge and the upper one right, so they never
       overlap, and both stay inside the card. */
    .band-scale {
      --edge-width: 128px;
      position: relative;
      height: 32px;
    }
    .edge {
      position: absolute;
      top: 2px;
      width: var(--edge-width);
      height: 28px;
      box-sizing: border-box;
      padding: 0 10px;
      display: flex;
      align-items: center;
      gap: 4px;
      border-radius: 8px;
      font-size: 12px;
      color: var(--hzt-muted);
      cursor: ew-resize;
      touch-action: none;
      outline: none;
      white-space: nowrap;
    }
    .edge strong {
      font-size: 13px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      color: var(--hzt-text);
    }
    .edge.low {
      left: clamp(
        0px,
        calc(var(--at) - var(--edge-width)),
        calc(100% - 2 * var(--edge-width))
      );
      justify-content: flex-end;
      border-top-right-radius: 0;
      background: color-mix(in srgb, var(--hzt-heat) 16%, var(--hzt-card));
    }
    .edge.high {
      left: clamp(
        var(--edge-width),
        var(--at),
        calc(100% - var(--edge-width))
      );
      border-top-left-radius: 0;
      background: color-mix(in srgb, var(--hzt-cool) 16%, var(--hzt-card));
    }
    .edge.low:hover,
    .edge.low:focus-visible,
    .edge.low.active {
      background: color-mix(in srgb, var(--hzt-heat) 30%, var(--hzt-card));
    }
    .edge.high:hover,
    .edge.high:focus-visible,
    .edge.high.active {
      background: color-mix(in srgb, var(--hzt-cool) 30%, var(--hzt-card));
    }

    /* History: the chart and the unit lanes share one time axis, inset
       by the temperature axis's labels. */
    .history {
      --axis: 30px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .plot {
      position: relative;
      padding-left: var(--axis);
    }
    .chart {
      width: 100%;
      height: 104px;
      display: block;
      overflow: visible;
    }
    .h-grid {
      stroke: var(--hzt-border);
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .y-label {
      position: absolute;
      left: 0;
      transform: translateY(-50%);
      font-size: 11px;
      line-height: 1;
      color: var(--hzt-muted);
      font-variant-numeric: tabular-nums;
    }
    .lane {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding-left: var(--axis);
    }
    .lane-name {
      font-size: 11px;
      color: var(--hzt-muted);
    }
    .lane-track {
      position: relative;
      height: 6px;
      border-radius: 3px;
      background: var(--hzt-subtle);
      overflow: hidden;
    }
    .run {
      position: absolute;
      top: 0;
      bottom: 0;
      border-radius: 3px;
    }
    .run.heat {
      background: var(--hzt-heat);
    }
    .run.cool {
      background: var(--hzt-cool);
    }
    .h-idle {
      fill: color-mix(in srgb, var(--hzt-text) 9%, transparent);
    }
    .h-room {
      fill: none;
      stroke: var(--hzt-text);
      stroke-width: 2;
      stroke-linejoin: round;
      vector-effect: non-scaling-stroke;
    }
    .h-target {
      fill: none;
      stroke: var(--hzt-muted);
      stroke-width: 1;
      stroke-dasharray: 3 4;
      vector-effect: non-scaling-stroke;
    }
    .chart-scale {
      display: flex;
      justify-content: space-between;
      padding-left: var(--axis);
      font-size: 11px;
      color: var(--hzt-muted);
    }
    .legend {
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      font-size: 12px;
      color: var(--hzt-muted);
    }
    .legend > span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .swatch {
      width: 14px;
      height: 8px;
      border-radius: 2px;
    }
    .swatch.room {
      height: 2px;
      background: var(--hzt-text);
    }
    .swatch.idle {
      background: color-mix(in srgb, var(--hzt-text) 14%, transparent);
    }
    .swatch.heat {
      height: 4px;
      background: var(--hzt-heat);
    }
    .swatch.cool {
      height: 4px;
      background: var(--hzt-cool);
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
    .unit-text .device {
      color: var(--hzt-text);
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
    "One climate zone: the room against its target and band, its last day, what HZT decided and why, and its units.",
});
