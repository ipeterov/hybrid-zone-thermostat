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

// What − and + change the target by. Dragging sets it to a tenth.
const STEP = 0.5;
// The zone's own limits (climate.py's range; set_idle_band's range).
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

// A value the card changed, as it's shown and sent: the target to a tenth,
// the band to a fifth, so both its edges land on tenths too. Only the part
// being changed is rounded: a stored 2.5 band stays 2.5.
function rounded(
  { target, band }: Settings,
  part: "target" | "band",
): Settings {
  return part === "target"
    ? { target: Math.round(target * 10) / 10, band }
    : { target, band: Math.max(MIN_BAND, Math.round(band * 5) / 5) };
}

// A smooth line through points that never overshoots them (monotone cubic
// interpolation, Fritsch–Carlson): the curve doesn't invent a peak the
// room never reached.
function monotonePath(points: readonly (readonly [number, number])[]): string {
  const n = points.length;
  if (n < 2) {
    return "";
  }
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i] as readonly [number, number];
    const [x1, y1] = points[i + 1] as readonly [number, number];
    dx.push(x1 - x0);
    slope.push(x1 === x0 ? 0 : (y1 - y0) / (x1 - x0));
  }
  const tangent: number[] = [slope[0] ?? 0];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1] ?? 0;
    const b = slope[i] ?? 0;
    tangent.push(a * b <= 0 ? 0 : (2 * a * b) / (a + b));
  }
  tangent.push(slope[n - 2] ?? 0);
  const [startX, startY] = points[0] as readonly [number, number];
  let d = `M${startX} ${startY}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i] as readonly [number, number];
    const [x1, y1] = points[i + 1] as readonly [number, number];
    const h = (dx[i] ?? 0) / 3;
    d += ` C${x0 + h} ${y0 + (tangent[i] ?? 0) * h} ${x1 - h} ${y1 - (tangent[i + 1] ?? 0) * h} ${x1} ${y1}`;
  }
  return d;
}

function partOf(handle: Handle): "target" | "band" {
  return handle === "target" ? "target" : "band";
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
    menuOpen: { state: true },
    chartWidth: { state: true },
  };

  menuOpen = false;

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

  // The chart's width in pixels, kept by a ResizeObserver.
  chartWidth = 600;
  private chartObserver?: ResizeObserver;

  private observeChart() {
    const chart = this.renderRoot.querySelector(".chart");
    if (!chart || this.chartObserver) {
      return;
    }
    this.chartObserver = new ResizeObserver(([entry]) => {
      const width = Math.round(entry?.contentRect.width ?? 0);
      if (width > 0 && width !== this.chartWidth) {
        this.chartWidth = width;
      }
    });
    this.chartObserver.observe(chart);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.chartObserver?.disconnect();
    this.chartObserver = undefined;
    this.toggleMenu(false);
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
    this.observeChart();
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

  // HA's conventions: a card opens the entity's more-info dialog (at one
  // of its views: history, settings, related), and navigates by pushing
  // history and announcing it.
  private moreInfo(entityId: string, view?: string) {
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: view ? { entityId, view } : { entityId },
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

  // Where a handle would put things with the pointer at `t` degrees. Not
  // rounded: the handle follows the pointer exactly, and the value it
  // stands for is rounded (rounded()) for display and when it's sent.
  private dragTo(drag: Drag, t: number): Settings {
    if (drag.handle === "target") {
      const half = drag.band / 2;
      return {
        target: clamp(
          t,
          Math.max(MIN_TARGET, drag.low + half),
          Math.min(MAX_TARGET, drag.high - half),
        ),
        band: drag.band,
      };
    }
    // An edge: the band widens or narrows around the target.
    const room = 2 * Math.min(drag.target - drag.low, drag.high - drag.target);
    return {
      target: drag.target,
      band: clamp(
        2 * Math.abs(t - drag.target),
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
    // No focus: a pointer drag would leave the handle lit as focused
    // until a click elsewhere. Keyboard users reach it by Tab.
    const handleElement = event.currentTarget as HTMLElement;
    handleElement.setPointerCapture(event.pointerId);
    // The drag ends however the pointer lets go: released anywhere in the
    // window, cancelled, or its capture lost (some webviews deliver the
    // release to none of the band's own elements).
    const end = (e: PointerEvent) => {
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      handleElement.removeEventListener("lostpointercapture", end);
      this.endDrag(e);
    };
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    handleElement.addEventListener("lostpointercapture", end);
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
    // Anything but a cancel keeps where the handle was let go.
    if (drag && zone && event.type !== "pointercancel") {
      this.commit(zone, rounded(drag, partOf(drag.handle)));
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
    // A tenth of a degree per press: the target by 0.1, each edge by 0.1
    // (so the band by 0.2).
    if (handle === "target") {
      this.commit(
        zone,
        rounded(
          {
            ...settings,
            target: clamp(settings.target + step * 0.1, MIN_TARGET, MAX_TARGET),
          },
          "target",
        ),
      );
    } else {
      const outward = handle === "high" ? step : -step;
      this.commit(
        zone,
        rounded(
          {
            ...settings,
            band: clamp(settings.band + outward * 0.2, MIN_BAND, MAX_BAND),
          },
          "band",
        ),
      );
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
      ${this.renderBand(zone)} ${this.renderStatus(zone)}
      ${this.renderHistory(zone)} ${this.renderUnits(zone)}
    </ha-card>`;
  }

  // What the zone is doing and why, as one line: the state leads, the
  // controller's reason follows.
  private renderStatus(zone: Zone) {
    const word = zoneWord(zone);
    if (!word) {
      return nothing;
    }
    const reason =
      zone.state === "off" ? "Nothing runs until it’s turned on." : zone.reason;
    // In shadow mode the word is "Would heat": the note under it says why
    // nothing happens, and how to change that.
    return html`<div class="status ${zone.state ?? ""}">
      <p role="status">
        <strong>${word}</strong>${reason ? html`<span> · ${reason}</span>` : nothing}
      </p>
      ${
        zone.shadow
          ? html`<p class="shadow-note">
            Shadow mode: HZT decides but sends nothing to the units.
            ${this.settingsLink(zone, "Go live in Climate zones")}
          </p>`
          : nothing
      }
    </div>`;
  }

  private settingsLink(zone: Zone, text: string) {
    return html`<a
      href=${this.settingsPath(zone)}
      @click=${(e: MouseEvent) => {
        e.preventDefault();
        this.navigate(this.settingsPath(zone));
      }}
      >${text}</a
    >`;
  }

  private renderHead(zone: Zone) {
    // HZT's own settings first; then HA's views of the zone's entity,
    // opened straight at the useful part of its dialog.
    const item = (label: string, run: () => void) => html`<button
      role="menuitem"
      @click=${() => {
        this.toggleMenu(false);
        run();
      }}
    >
      ${label}
    </button>`;
    const menu = html`${item("Zone settings", () =>
      this.navigate(this.settingsPath(zone)),
    )}
      <div class="menu-caption" role="presentation">In Home Assistant</div>
      ${item("History", () => this.moreInfo(zone.entityId, "history"))}
      ${item("Entity settings", () => this.moreInfo(zone.entityId, "settings"))}
      ${item("Related", () => this.moreInfo(zone.entityId, "related"))}`;
    return html`<div class="head">
      <h2>${zone.name}</h2>
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
      <div class="menu-anchor">
        <button
          class="icon more"
          aria-label="More for ${zone.name}"
          aria-haspopup="menu"
          aria-expanded=${this.menuOpen ? "true" : "false"}
          @click=${() => this.toggleMenu()}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <circle cx="12" cy="5" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="12" cy="19" r="1.8" />
          </svg>
        </button>
        ${
          this.menuOpen
            ? html`<div class="menu" role="menu">
              ${menu}
            </div>`
            : nothing
        }
      </div>
    </div>`;
  }

  // The menu closes on a choice, a click anywhere else, or Escape.
  private toggleMenu(open = !this.menuOpen) {
    this.menuOpen = open;
    if (open) {
      document.addEventListener("pointerdown", this.closeOutside, true);
      document.addEventListener("keydown", this.closeOnEscape, true);
    } else {
      document.removeEventListener("pointerdown", this.closeOutside, true);
      document.removeEventListener("keydown", this.closeOnEscape, true);
    }
  }

  private closeOutside = (event: Event) => {
    const anchor = this.renderRoot.querySelector(".menu-anchor");
    if (anchor && !event.composedPath().includes(anchor)) {
      this.toggleMenu(false);
    }
  };

  private closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this.toggleMenu(false);
    }
  };

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
                this.commit(
                  zone,
                  rounded(
                    { ...settings, target: settings.target - STEP },
                    "target",
                  ),
                )}
            >
              −
            </button>
            <div class="target-value">
              <span class="label">Target</span>
              <span class="mid">${rounded(settings, "target").target.toFixed(1)}</span>
            </div>
            <button
              class="step"
              aria-label="Raise the target"
              ?disabled=${settings.target >= MAX_TARGET}
              @click=${() =>
                this.commit(
                  zone,
                  rounded(
                    { ...settings, target: settings.target + STEP },
                    "target",
                  ),
                )}
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
    // Positions follow a drag exactly; the numbers are what will be sent.
    const { target, band } = settings;
    const { heatBelow, coolAbove } = bandEdges(target, band);
    const shown = this.drag
      ? rounded(settings, partOf(this.drag.handle))
      : settings;
    const shownEdges = bandEdges(shown.target, shown.band);
    const { low, high } = this.scale(zone, settings);
    const room = zone.room;
    const at = (t: number) =>
      `${((clamp(t, low, high) - low) / (high - low)) * 100}%`;
    const active = this.drag?.handle;
    const edges = [
      {
        which: "low" as const,
        value: heatBelow,
        shown: shownEdges.heatBelow,
        words: "Heats below",
        label: "Heating starts below",
      },
      {
        which: "high" as const,
        value: coolAbove,
        shown: shownEdges.coolAbove,
        words: "Cools above",
        label: "Cooling starts above",
      },
    ];
    return html`<div
      class="band ${this.drag ? "dragging" : ""}"
      @pointermove=${this.moveDrag}
    >
      <div
        class="band-track"
        role="img"
        aria-label="Heats below ${degrees(shownEdges.heatBelow)}, idle up to ${degrees(shownEdges.coolAbove)}, cools above${
          room === undefined ? "" : `; the room is ${degrees(room)}`
        }"
      >
        <span class="seg heat" style="left:0;width:${at(heatBelow)}"></span>
        <span
          class="seg idle"
          style="left:${at(heatBelow)};right:calc(100% - ${at(coolAbove)})"
        ></span>
        <span class="seg cool" style="left:${at(coolAbove)};right:0"></span>
        ${edges.map(
          // The edge itself can be grabbed too; it lights up with its label.
          (edge) => html`<span
            class="tick ${edge.which} ${active === edge.which ? "active" : ""}"
            style="left:${at(edge.value)}"
            aria-hidden="true"
            @pointerdown=${(e: PointerEvent) => this.startDrag(e, edge.which)}
            ><span class="tick-line"></span
          ></span>`,
        )}
        ${
          // The room comes down from above: a flag with its reading, its
          // tail pointing into a needle through the bar.
          room === undefined
            ? nothing
            : html`<span class="reading" style="--at:${at(room)}">
                <span class="flag">${room.toFixed(1)}°</span>
                <span class="needle"></span>
              </span>`
        }
        <span
          class="hand ${active === "target" ? "active" : ""}"
          style="left:${at(target)}"
          role="slider"
          tabindex="0"
          aria-label="Target"
          aria-valuemin=${MIN_TARGET}
          aria-valuemax=${MAX_TARGET}
          aria-valuenow=${shown.target}
          aria-valuetext="Target ${degrees(shown.target)}"
          @pointerdown=${(e: PointerEvent) => this.startDrag(e, "target")}
          @keydown=${(e: KeyboardEvent) => this.onHandleKey(e, "target")}
        >
          <span class="hand-face"></span>
        </span>
      </div>
      <div class="band-scale">
        ${edges.map(
          (edge) => html`<span
            class="edge ${edge.which} ${active === edge.which ? "active" : ""}"
            style="--at:${at(edge.value)}"
            role="slider"
            tabindex="0"
            aria-label=${edge.label}
            aria-valuenow=${edge.shown}
            aria-valuetext="${edge.words} ${degrees(edge.shown)}"
            @pointerdown=${(e: PointerEvent) => this.startDrag(e, edge.which)}
            @keydown=${(e: KeyboardEvent) => this.onHandleKey(e, edge.which)}
            ><span
              >${edge.words} <strong>${tenths(edge.shown)}</strong></span
            ></span
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
    // Drawn at the chart's real size, so lines aren't stretched.
    const width = this.chartWidth;
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
    // The room, averaged over ten-minute buckets: a sensor's 0.1 °C
    // flicker would otherwise draw as fuzz, and the day's shape is the
    // point. The latest reading ends the line as it is.
    const bucket = 10 * 60_000;
    const buckets = new Map<number, { sum: number; count: number }>();
    for (const p of rooms.slice(0, -1)) {
      const key = Math.floor(Math.max(p.time, from) / bucket);
      const entry = buckets.get(key) ?? { sum: 0, count: 0 };
      entry.sum += p.room as number;
      entry.count += 1;
      buckets.set(key, entry);
    }
    const means = [...buckets].map(([key, { sum, count }]) => ({
      time: (key + 0.5) * bucket,
      room: sum / count,
    }));
    // Then a rolling mean over five buckets (50 minutes): readings come in
    // 0.1 °C steps, which ten-minute means turn into stairs. At 24 hours
    // across a card, a pixel is a couple of minutes, so nothing real is
    // lost.
    const smooth = [
      ...means.map((p, i) => {
        const window = means.slice(Math.max(0, i - 2), i + 3);
        return {
          time: p.time,
          room: window.reduce((total, w) => total + w.room, 0) / window.length,
        };
      }),
      rooms.at(-1) as { time: number; room: number },
    ];
    const roomPath = monotonePath(
      smooth.map((p) => [x(p.time), y(p.room)] as const),
    );
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
          role="img"
          aria-label="Room temperature against the idle band over the last ${HISTORY_HOURS} hours"
        >
          ${ticks.map(
            (t) =>
              // On a half pixel, so a 1 px line is one crisp row.
              svg`<line class="h-grid" x1="0" x2=${width} y1=${Math.round(y(t)) + 0.5} y2=${Math.round(y(t)) + 0.5}></line>`,
          )}
          <path class="h-idle" d=${bandPath}></path>
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
        No room units yet:
        ${this.settingsLink(zone, "add them in Climate zones")}.
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
      <div class="units-head">
        <h3 class="eyebrow">${heading}</h3>
        ${this.settingsLink(zone, "Configure")}
      </div>
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
    button {
      font: inherit;
      color: var(--hzt-text);
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.4;
      cursor: default;
    }
    /* The header's two buttons, alike: borderless, a wash on hover. The
       power button is filled while the zone is on. */
    .icon {
      width: 40px;
      height: 40px;
      flex: none;
      border: 0;
      border-radius: 12px;
      background: none;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--hzt-muted);
    }
    .icon:hover {
      background: var(--hzt-subtle);
    }
    .icon.power.on {
      background: var(--hzt-subtle);
      color: var(--hzt-text);
    }
    .icon.power.on:hover {
      background: color-mix(in srgb, var(--hzt-text) 16%, var(--hzt-card));
    }
    .icon.power path {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
    }
    .icon.more circle {
      fill: currentColor;
    }
    .menu-anchor {
      position: relative;
    }
    .menu {
      position: absolute;
      top: 44px;
      right: 0;
      /* Above the band's handles, which sit on their own layers. */
      z-index: 10;
      min-width: 200px;
      padding: 4px;
      display: flex;
      flex-direction: column;
      border-radius: 12px;
      background: var(--hzt-card);
      border: 1px solid var(--hzt-border);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
    }
    .menu button {
      display: flex;
      align-items: center;
      height: 36px;
      padding: 0 12px;
      border: 0;
      border-radius: 8px;
      background: none;
      font-size: 14px;
      line-height: 1;
      text-align: left;
      white-space: nowrap;
    }
    .menu button:hover,
    .menu button:focus-visible {
      background: var(--hzt-subtle);
      outline: none;
    }
    .menu-caption {
      margin: 4px 12px 0;
      padding: 8px 0 4px;
      border-top: 1px solid var(--hzt-border);
      font-size: 12px;
      line-height: 1;
      color: var(--hzt-muted);
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
    /* What the zone is doing, then why; tinted while it heats or cools. */
    .status {
      background: var(--hzt-subtle);
      border-radius: 12px;
      padding: 10px 12px;
      font-size: 14px;
      line-height: 1.5;
    }
    .shadow-note {
      margin-top: 4px;
      font-size: 13px;
      color: var(--hzt-muted);
    }
    .status strong {
      font-weight: 500;
    }
    .status span {
      color: var(--hzt-muted);
    }
    .status.heating {
      background: color-mix(in srgb, var(--hzt-heat) 14%, var(--hzt-card));
    }
    .status.cooling {
      background: color-mix(in srgb, var(--hzt-cool) 14%, var(--hzt-card));
    }

    /* The band. Everything slides to its new place, except while a handle
       is held: then it follows the pointer exactly. */
    .band {
      display: flex;
      flex-direction: column;
      gap: 2px;
      user-select: none;
      -webkit-user-select: none;
    }
    .band .seg,
    .band .tick,
    .band .hand,
    .band-scale .edge {
      transition:
        left 300ms ease,
        right 300ms ease,
        width 300ms ease;
    }
    .band.dragging .seg,
    .band.dragging .tick,
    .band.dragging .hand,
    .band.dragging .edge {
      transition: none;
    }
    .band.dragging,
    .band.dragging * {
      cursor: grabbing !important;
    }
    @media (prefers-reduced-motion: reduce) {
      .band .seg,
      .band .tick,
      .band .flag,
      .band .needle,
      .band .hand,
      .band-scale .edge,
      .hand-face::after {
        transition: none !important;
      }
    }
    /* Rows of the track, top down: the room's flag (0-17) and pointer down
       to the bar's middle (17-34), the bar (30-38), the set hand up to the
       bar's middle (34-51). */
    .band-track {
      position: relative;
      height: 56px;
    }
    .seg {
      position: absolute;
      top: 30px;
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
    /* An edge: a line with a 20 px hit area, lit together with its label;
       above the hand's hit area, so an edge near the target can still be
       grabbed. */
    .tick {
      position: absolute;
      z-index: 2;
      top: 24px;
      width: 20px;
      height: 20px;
      margin-left: -10px;
      display: flex;
      justify-content: center;
      cursor: grab;
      touch-action: none;
    }
    .tick-line {
      width: 2px;
      height: 100%;
      border-radius: 1px;
      background: var(--hzt-muted);
      transition:
        width 140ms ease,
        background 140ms ease;
    }
    .tick:hover .tick-line,
    .tick.active .tick-line,
    .band:has(.edge.low:hover, .edge.low:focus-visible) .tick.low .tick-line,
    .band:has(.edge.high:hover, .edge.high:focus-visible)
      .tick.high
      .tick-line {
      width: 4px;
      background: var(--hzt-text);
    }
    /* The room, from above: a flag with its reading (kept inside the
       card), its tail pointing into a hairline needle through the bar. */
    .reading {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .flag {
      position: absolute;
      top: 0;
      left: clamp(22px, var(--at), calc(100% - 22px));
      transform: translateX(-50%);
      padding: 0 6px;
      border-radius: 6px;
      background: var(--hzt-text);
      color: var(--hzt-card);
      font-size: 11px;
      font-weight: 600;
      line-height: 17px;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      transition: left 300ms ease;
    }
    /* The room's pointer and the set hand are mirror images about the
       bar's middle (34): a 12 × 10 triangle 7-17 px from it, and a 2 px
       line from the triangle's tip to the middle. */
    .needle {
      position: absolute;
      top: 17px;
      left: var(--at);
      width: 0;
      height: 17px;
      transition: left 300ms ease;
    }
    .needle::before {
      content: "";
      position: absolute;
      top: 0;
      left: -6px;
      border-left: 6px solid transparent;
      border-right: 6px solid transparent;
      border-top: 10px solid var(--hzt-text);
    }
    .needle::after {
      content: "";
      position: absolute;
      top: 9px;
      left: -1px;
      width: 2px;
      bottom: 0;
      background: var(--hzt-text);
    }
    /* The target, from below: a set hand, as on a barometer, that you
       turn to where you want the room. Its line meets the bar from the
       other side, so the room's needle reads against it, and the band
       around it shows that close is the goal, not exact. */
    .hand {
      --hand: var(--hzt-hand, #e8b04a);
      position: absolute;
      top: 28px;
      width: 28px;
      height: 30px;
      margin-left: -14px;
      cursor: grab;
      touch-action: none;
      outline: none;
      z-index: 1;
    }
    .hand-face {
      position: absolute;
      inset: 0;
    }
    .hand-face::before {
      content: "";
      position: absolute;
      /* Up to the bar's middle, where the room's needle meets it. */
      top: 6px;
      left: calc(50% - 1px);
      width: 2px;
      height: 10px;
      background: var(--hand);
    }
    .hand-face::after {
      content: "";
      position: absolute;
      top: 13px;
      left: calc(50% - 6px);
      border-left: 6px solid transparent;
      border-right: 6px solid transparent;
      border-bottom: 10px solid var(--hand);
      transition: transform 140ms ease;
      transform-origin: 50% 0;
    }
    .hand:hover .hand-face::after,
    .hand:focus-visible .hand-face::after,
    .hand.active .hand-face::after {
      transform: scale(1.3);
    }
    .hand:focus-visible {
      border-radius: 6px;
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--hand) 50%, transparent);
    }
    /* The band's edges, as handles below it that say the rule: the lower
       one hangs left of its edge and the upper one right, so they never
       overlap, and both stay inside the card. */
    /* Pulled up under the track, so each label hangs straight from its
       edge's tick; the hand sits between them. */
    .band-scale {
      --edge-width: 128px;
      position: relative;
      height: 28px;
      /* The track is 56 tall and the band's rows are 2 apart; the ticks
         end at 44. */
      margin-top: -14px;
    }
    .edge {
      position: absolute;
      top: 0;
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
      cursor: grab;
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
    .edge.low.active,
    .band:has(.tick.low:hover) .edge.low {
      background: color-mix(in srgb, var(--hzt-heat) 30%, var(--hzt-card));
    }
    .edge.high:hover,
    .edge.high:focus-visible,
    .edge.high.active,
    .band:has(.tick.high:hover) .edge.high {
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
      stroke: color-mix(in srgb, var(--hzt-border) 55%, transparent);
      stroke-width: 1;
      shape-rendering: crispEdges;
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
      stroke-linecap: round;
      shape-rendering: geometricPrecision;
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
    /* The heading, with a quiet link to set the units up on the right. */
    .units-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 4px;
    }
    .units-head a {
      font-size: 12px;
      color: var(--hzt-muted);
      text-decoration: none;
    }
    .units-head a:hover {
      color: var(--hzt-text);
      text-decoration: underline;
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
