import { css } from "lit";

// The panel's look, from docs/design/panel-system-map.html, on HA's theme
// variables so it follows light and dark themes. Fallbacks are the
// design's light values, for the harness.
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
    --hzt-line: color-mix(in srgb, var(--hzt-muted) 55%, transparent);

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
    font-weight: 500;
  }
  h2 {
    margin: 0;
    font-size: 17px;
    font-weight: 500;
  }
  h2.big {
    font-size: 20px;
  }
  p {
    margin: 0;
  }

  .page {
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px 20px;
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    align-items: flex-start;
  }
  .main {
    flex: 999 1 640px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .side {
    flex: 1 1 340px;
    min-width: 0;
  }
  .wide {
    flex-basis: 100%;
  }

  .card {
    background: var(--hzt-card);
    border: 1px solid var(--hzt-border);
    border-radius: 16px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    box-sizing: border-box;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .card-head h2 {
    flex: 1;
  }

  .eyebrow {
    margin: 4px 0 0;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--hzt-muted);
  }
  .small,
  .empty {
    font-size: 13px;
    line-height: 1.5;
    color: var(--hzt-muted);
  }
  .empty {
    font-size: 14px;
    padding: 12px 0;
  }
  .alert {
    background: color-mix(in srgb, var(--hzt-error) 12%, var(--hzt-card));
    color: var(--hzt-text);
    border-radius: 12px;
    padding: 10px 14px;
    font-size: 14px;
  }

  /* Buttons */
  button {
    font: inherit;
    color: var(--hzt-text);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    height: 36px;
    box-sizing: border-box;
    border-radius: 18px;
    border: 1px solid var(--hzt-border);
    background: var(--hzt-card);
    padding: 0 14px;
    font-size: 13px;
    font-weight: 500;
  }
  .primary {
    height: 40px;
    border-radius: 20px;
    border: 0;
    background: var(--hzt-accent);
    color: var(--text-primary-color, #fff);
    padding: 0 20px;
    font-size: 14px;
    font-weight: 500;
  }
  .text {
    border: 0;
    background: none;
    height: 36px;
    padding: 0 8px;
    font-size: 13px;
    font-weight: 500;
  }
  .danger {
    color: var(--hzt-error);
  }
  .icon {
    width: 32px;
    height: 32px;
    flex: none;
    border-radius: 16px;
    border: 0;
    background: none;
    color: var(--hzt-muted);
    font-size: 15px;
  }
  .icon:not(:disabled):hover {
    background: var(--hzt-subtle);
  }
  .icon.menu {
    width: 44px;
    height: 44px;
    border-radius: 22px;
    margin-left: -12px;
    color: var(--hzt-text);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .icon.menu path {
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }

  /* Form controls */
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 13px;
    color: var(--hzt-muted);
  }
  .field.narrow {
    max-width: 420px;
  }
  select,
  input {
    height: 44px;
    box-sizing: border-box;
    border-radius: 8px;
    border: 1px solid var(--hzt-border);
    background: var(--hzt-card);
    color: var(--hzt-text);
    padding: 0 10px;
    font: inherit;
    font-size: 15px;
  }

  /* The system map */
  .map-scroll {
    overflow-x: auto;
  }
  .map {
    position: relative;
  }
  .col-label {
    position: absolute;
    top: 0;
    font-size: 12px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--hzt-muted);
  }
  .lines {
    position: absolute;
    left: 0;
    top: 0;
  }
  .line {
    fill: none;
    stroke: var(--hzt-line);
    stroke-width: 2;
  }
  .line.heat {
    stroke: var(--hzt-heat);
    stroke-width: 3;
  }
  .line.cool {
    stroke: var(--hzt-cool);
    stroke-width: 3;
  }
  .node {
    position: absolute;
    box-sizing: border-box;
    height: 56px;
    margin: 0;
    border: 1px solid var(--hzt-border);
    border-radius: 12px;
    background: var(--hzt-card);
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    text-align: left;
  }
  .node.hint {
    height: auto;
    border-style: dashed;
    background: none;
    font-size: 12px;
    line-height: 1.45;
    color: var(--hzt-muted);
  }
  .node-name {
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .node-sub {
    font-size: 12px;
    color: var(--hzt-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .node.unit.heat {
    border: 2px solid var(--hzt-heat);
    background: color-mix(in srgb, var(--hzt-heat) 8%, var(--hzt-card));
    padding: 7px 11px;
  }
  .node.unit.cool {
    border: 2px solid var(--hzt-cool);
    background: color-mix(in srgb, var(--hzt-cool) 8%, var(--hzt-card));
    padding: 7px 11px;
  }
  .node.unit.gone {
    border-style: dashed;
    background: none;
  }
  .node.zone {
    cursor: pointer;
  }
  .node.zone:hover {
    border-color: var(--hzt-muted);
  }
  .node.zone.selected {
    border: 2px solid var(--hzt-text);
    padding: 7px 11px;
  }

  /* The side panel */
  .side-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .title-row h2 {
    flex: 1;
  }
  .chip {
    border-radius: 999px;
    padding: 4px 12px;
    font-size: 13px;
    font-weight: 500;
    background: var(--hzt-subtle);
  }
  .chip.heating {
    background: color-mix(in srgb, var(--hzt-heat) 16%, var(--hzt-card));
  }
  .chip.cooling {
    background: color-mix(in srgb, var(--hzt-cool) 16%, var(--hzt-card));
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
  .facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .fact {
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: var(--hzt-subtle);
    border-radius: 10px;
    padding: 10px;
    font-size: 13px;
    color: var(--hzt-muted);
    min-width: 0;
  }
  .fact.full {
    grid-column: 1 / -1;
  }
  .fact select {
    height: 24px;
    border: 0;
    background: transparent;
    padding: 0;
    margin-left: -2px;
    font-size: 14px;
    font-weight: 500;
    min-width: 0;
    cursor: pointer;
  }
  .fact strong {
    font-size: 14px;
    font-weight: 500;
    line-height: 24px;
    color: var(--hzt-text);
  }
  .fact small {
    font-size: 12px;
    color: var(--hzt-muted);
  }
  .order {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .order li {
    display: flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--hzt-border);
    border-radius: 12px;
    padding: 8px 6px 8px 12px;
  }
  .rank {
    width: 24px;
    height: 24px;
    flex: none;
    box-sizing: border-box;
    border-radius: 12px;
    border: 2px solid var(--hzt-border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    color: var(--hzt-muted);
    margin-right: 4px;
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
  .order-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .order-name {
    font-size: 14px;
    font-weight: 500;
  }
  .order-rule {
    font-size: 12px;
    color: var(--hzt-muted);
  }
  .side-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: space-between;
  }
  .side-form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .side-form .side-actions {
    justify-content: flex-start;
  }

  @media (max-width: 600px) {
    .topbar {
      padding: 0 16px;
    }
    .page {
      padding: 16px 12px;
      gap: 12px;
    }
    .main {
      gap: 12px;
    }
    .card {
      padding: 16px;
    }
  }
`;
