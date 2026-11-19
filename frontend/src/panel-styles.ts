import { css } from "lit";

// The panel's look, from the canvas's "Settings, zones first" boards, on
// HA's theme variables so it follows light and dark themes. Fallbacks are
// light values, for the harness.
export const panelStyles = css`
  :host {
    --hzt-bg: var(--primary-background-color, #f4f5f7);
    --hzt-card: var(--card-background-color, #fff);
    --hzt-border: var(--divider-color, #e3e5e8);
    --hzt-text: var(--primary-text-color, #1c1f23);
    --hzt-muted: var(--secondary-text-color, #5f6368);
    --hzt-subtle: var(--secondary-background-color, #f1f3f4);
    --hzt-accent: var(--primary-color, #0277bd);
    --hzt-heat: var(--state-climate-heat-color, #ff8100);
    --hzt-cool: var(--state-climate-cool-color, #2b7fd4);
    --hzt-error: var(--error-color, #b00020);

    display: block;
    min-height: 100vh;
    background: var(--hzt-bg);
    color: var(--hzt-text);
    font-family: var(--ha-font-family-body, Roboto, system-ui, sans-serif);
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 56px;
    padding: 0 24px;
    background: var(--hzt-card);
    border-bottom: 1px solid var(--hzt-border);
  }
  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 400;
  }

  .page {
    max-width: 880px;
    margin: 0 auto;
    padding: 32px 24px 64px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    box-sizing: border-box;
  }
  @media (max-width: 600px) {
    .topbar {
      padding: 0 8px;
    }
    .page {
      padding: 24px 16px 48px;
      gap: 16px;
    }
  }

  p {
    margin: 0;
  }
  .small {
    font-size: 13px;
    line-height: 1.5;
    color: var(--hzt-muted);
  }
  .mono {
    font-family: var(--ha-font-family-code, ui-monospace, monospace);
    font-size: 12px;
  }
  .warn {
    color: var(--hzt-error);
  }
  .alert {
    padding: 12px 14px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--hzt-error) 14%, var(--hzt-card));
    font-size: 14px;
  }

  /* The house is the page: a heading, its extras, no card of its own. */
  .house {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .house h2 {
    margin: 0;
    font-size: 28px;
    font-weight: 400;
  }
  .lead {
    font-size: 15px;
    line-height: 1.5;
    color: var(--hzt-muted);
    max-width: 640px;
  }

  /* A zone: one card, its parts split by rules, nothing nested in it. */
  .card {
    background: var(--hzt-card);
    border: 1px solid var(--hzt-border);
    border-radius: 16px;
  }
  .card.focused {
    border-color: color-mix(in srgb, var(--hzt-accent) 60%, var(--hzt-border));
  }
  .card.new {
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .section {
    padding: 20px 24px;
    border-top: 1px solid var(--hzt-border);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .section.foot {
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 14px;
    padding-bottom: 14px;
  }
  @media (max-width: 600px) {
    .section,
    .card.new {
      padding: 16px;
    }
  }

  .zone-head {
    padding: 20px 24px 16px;
    display: flex;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 8px 16px;
  }
  .zone-head + .section.room {
    border-top: 0;
    padding-top: 0;
  }
  @media (max-width: 600px) {
    .zone-head {
      padding: 16px 16px 12px;
    }
  }
  .zone-title {
    flex: 1 1 240px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .zone-title h3 {
    margin: 0 0 2px;
    font-size: 22px;
    font-weight: 500;
  }
  .reason {
    max-width: 560px;
  }
  /* Live or shadow: set once, so it's quiet. */
  .mode {
    font-size: 13px;
    color: var(--hzt-muted);
    padding-top: 6px;
  }
  .mode.confirm {
    flex-basis: 100%;
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--hzt-subtle);
    color: var(--hzt-text);
    font-size: 14px;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .section.room {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 16px 24px;
    align-items: start;
  }
  @media (max-width: 700px) {
    .section.room {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .band-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    min-height: 40px;
  }
  .band-value {
    font-size: 18px;
    font-weight: 500;
    color: var(--hzt-text);
  }

  /* Fields */
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--hzt-muted);
    min-width: 0;
  }
  .field small {
    font-size: 12px;
    line-height: 1.45;
  }
  .inline {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 14px;
    color: var(--hzt-text);
  }
  select,
  input[type="number"],
  input:not([type]) {
    height: 40px;
    box-sizing: border-box;
    border: 0;
    border-radius: 10px;
    background: var(--hzt-subtle);
    color: var(--hzt-text);
    font: inherit;
    font-size: 14px;
    padding: 0 10px;
    max-width: 100%;
  }
  .inline select,
  .inline input {
    height: 36px;
    border-radius: 8px;
  }
  input[type="number"] {
    width: 80px;
  }
  .checks {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 24px;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
  }

  /* Buttons */
  button {
    font: inherit;
    color: var(--hzt-text);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .primary,
  .secondary {
    height: 40px;
    padding: 0 16px;
    border-radius: 10px;
    font-size: 14px;
  }
  .primary {
    border: 0;
    background: var(--hzt-text);
    color: var(--hzt-card);
    font-weight: 500;
  }
  .secondary {
    border: 1px solid var(--hzt-border);
    background: none;
  }
  .text {
    border: 0;
    background: none;
    padding: 0;
    font-size: 13px;
  }
  .text.link {
    color: var(--hzt-accent);
  }
  .text.quiet {
    color: var(--hzt-muted);
  }
  .text.quiet:hover {
    color: var(--hzt-error);
  }
  .end {
    margin-left: auto;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .icon {
    width: 32px;
    height: 32px;
    flex: none;
    border: 0;
    border-radius: 8px;
    background: none;
    color: var(--hzt-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .icon:hover:not(:disabled) {
    background: var(--hzt-subtle);
  }
  .icon svg,
  .pill svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }
  .icon.menu {
    width: 40px;
    height: 40px;
    color: var(--hzt-text);
  }

  /* What waits behind a pill: named for why you'd want it. */
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .pill {
    height: 36px;
    padding: 0 14px 0 10px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: 18px;
    border: 1px solid color-mix(in srgb, var(--hzt-text) 22%, transparent);
    background: none;
    font-size: 14px;
    white-space: nowrap;
  }
  .pill:hover {
    background: var(--hzt-subtle);
  }
  /* What a pill became: a panel with its own ×. */
  .panel {
    border: 1px solid var(--hzt-border);
    border-radius: 12px;
  }
  .panel-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 10px 10px 14px;
    border-bottom: 1px solid var(--hzt-border);
  }
  .panel-title {
    flex: 1;
    font-size: 15px;
    font-weight: 500;
  }
  .panel-body {
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* Units */
  .unit-head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .unit-name {
    font-size: 16px;
    font-weight: 500;
  }
  .note {
    color: var(--hzt-text);
  }

  /* Orders, once there's more than one unit for a direction */
  .section.orders {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px 24px;
  }
  .section.orders .small {
    grid-column: 1 / -1;
  }
  .order-col h4 {
    margin: 0 0 6px;
    font-size: 13px;
    font-weight: 500;
    color: var(--hzt-muted);
  }
  .order {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .order li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
  }
  .order-name {
    flex: 1;
  }
  .rank {
    width: 22px;
    height: 22px;
    flex: none;
    box-sizing: border-box;
    border-radius: 11px;
    border: 2px solid var(--hzt-border);
    display: inline-flex;
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

  /* A room just added: what it needs, said once */
  .empty-state {
    align-items: center;
    text-align: center;
    padding-top: 8px;
    padding-bottom: 28px;
    border-top: 0;
  }
  .empty-state svg {
    fill: none;
    stroke: var(--hzt-muted);
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .empty-title {
    font-size: 16px;
    font-weight: 500;
  }
  .empty-state .small {
    max-width: 460px;
  }
  .empty-actions {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    flex-wrap: wrap;
    gap: 12px;
    text-align: left;
  }
  @media (max-width: 600px) {
    .empty-actions {
      flex-direction: column;
      align-items: stretch;
      width: 100%;
    }
  }
`;
