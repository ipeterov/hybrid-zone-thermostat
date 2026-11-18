import { css, html, LitElement, nothing } from "lit";

import { DOMAIN, type Hass, type HouseConfig } from "./hass";

// The Climate zones sidebar page. HA sets `hass` (and `narrow`, `panel`)
// on it, and sets `hass` again on every state change.
export class HztPanel extends LitElement {
  static properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    config: { state: true },
    error: { state: true },
  };

  hass?: Hass;
  narrow = false;
  config?: HouseConfig;
  error?: string;

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
          this.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          this.loading = false;
        });
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
    if (!this.config) {
      return nothing;
    }
    if (this.config.zones.length === 0) {
      return html`<p>No zones yet.</p>`;
    }
    return html`<ul>
      ${this.config.zones.map((zone) => html`<li>${zone.name}</li>`)}
    </ul>`;
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
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px 20px;
    }
  `;
}

customElements.define("hzt-panel", HztPanel);
