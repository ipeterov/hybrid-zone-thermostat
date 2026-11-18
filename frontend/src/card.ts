import { css, html, LitElement } from "lit";

import type { Hass } from "./hass";

interface ZoneCardConfig {
  type: string;
  zone?: string;
}

// The dashboard zone card. A placeholder until zones exist to show.
export class HztZoneCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    config: { state: true },
  };

  hass?: Hass;
  config?: ZoneCardConfig;

  setConfig(config: ZoneCardConfig): void {
    this.config = config;
  }

  getCardSize(): number {
    return 4;
  }

  protected render() {
    return html`<div class="card">
      <h2>${this.config?.zone ?? "Zone"}</h2>
    </div>`;
  }

  static styles = css`
    .card {
      padding: 20px;
      border-radius: var(--ha-card-border-radius, 16px);
      background: var(--card-background-color, #fff);
    }
    h2 {
      margin: 0;
      font-size: 20px;
      font-weight: 500;
    }
  `;
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
  description: "One climate zone: its temperature, target and units.",
});
