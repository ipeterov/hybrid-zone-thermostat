import { expect, type Page, test } from "@playwright/test";

import type { HassEntity, HouseConfig } from "../src/hass";

const STATES: HassEntity[] = [
  {
    entity_id: "sensor.co2_monitor_temperature",
    state: "21.4",
    attributes: {
      friendly_name: "CO2 monitor temperature",
      device_class: "temperature",
      unit_of_measurement: "°C",
    },
  },
  {
    entity_id: "sensor.outdoor_temperature",
    state: "7.2",
    attributes: {
      friendly_name: "Outdoor temperature",
      device_class: "temperature",
    },
  },
  {
    entity_id: "sensor.co2_monitor_co2",
    state: "640",
    attributes: {
      friendly_name: "CO2 monitor CO2",
      device_class: "carbon_dioxide",
    },
  },
  {
    entity_id: "climate.living_room_hisense_ac",
    state: "heat",
    attributes: {
      friendly_name: "Living room Hisense AC",
      hvac_modes: ["off", "cool", "heat", "fan_only", "dry"],
    },
  },
  {
    entity_id: "climate.living_room_trv",
    state: "heat",
    attributes: {
      friendly_name: "Living room TRV",
      hvac_modes: ["off", "heat"],
    },
  },
];

const LIVING_ROOM: HouseConfig = {
  house: { outdoor_sensor: "sensor.outdoor_temperature" },
  zones: [
    {
      id: "living_room",
      name: "Living room",
      room_sensor: "sensor.co2_monitor_temperature",
      target: 22,
      idle_band: 1.5,
      enabled: true,
      heating_order: ["living_room_hisense_ac", "living_room_trv"],
      cooling_order: ["living_room_hisense_ac"],
    },
  ],
  room_units: [
    {
      id: "living_room_hisense_ac",
      name: "Living room Hisense AC",
      entity_id: "climate.living_room_hisense_ac",
      zone_id: "living_room",
      can_heat: true,
      can_cool: true,
    },
    {
      id: "living_room_trv",
      name: "Living room TRV",
      entity_id: "climate.living_room_trv",
      zone_id: "living_room",
      can_heat: true,
      can_cool: false,
    },
  ],
  central_units: [],
};

async function open(
  page: Page,
  fixture: { config?: HouseConfig; states?: HassEntity[]; error?: string },
) {
  await page.addInitScript((f) => {
    window.hztFixture = f;
  }, fixture);
  await page.goto("/");
}

function lastSaved(page: Page): Promise<HouseConfig> {
  return page.evaluate(() => {
    const saves = window.hztCalls.filter(
      (call) => call.type === "hybrid_zone_thermostat/config/save",
    );
    return saves.at(-1)?.config as HouseConfig;
  });
}

test("an empty house says there are no zones", async ({ page }) => {
  await open(page, { states: STATES });

  await expect(
    page.getByRole("heading", { name: "Climate zones" }),
  ).toBeVisible();
  await expect(page.getByText("No zones yet.")).toBeVisible();
});

test("says when the zones can't be loaded", async ({ page }) => {
  await open(page, { error: "Hybrid Zone Thermostat isn't set up." });

  await expect(page.getByRole("alert")).toContainText("isn't set up");
});

test("adds a zone with its room sensor", async ({ page }) => {
  await open(page, { states: STATES });
  const form = page.getByRole("heading", { name: "New zone" }).locator("..");

  await form.getByLabel("Name").fill("Living room");
  await form
    .getByLabel("Room temperature")
    .selectOption("sensor.co2_monitor_temperature");
  await form.getByRole("button", { name: "Add zone" }).click();

  await expect(page.getByRole("region", { name: "Living room" })).toBeVisible();
  const saved = await lastSaved(page);
  expect(saved.zones).toEqual([
    expect.objectContaining({
      id: "living_room",
      name: "Living room",
      room_sensor: "sensor.co2_monitor_temperature",
      target: 21,
    }),
  ]);
});

test("offers only temperature sensors", async ({ page }) => {
  await open(page, { states: STATES });

  const options = page
    .getByRole("heading", { name: "New zone" })
    .locator("..")
    .getByLabel("Room temperature")
    .locator("option");
  await expect(options).toHaveText([
    "None",
    "CO2 monitor temperature",
    "Outdoor temperature",
  ]);
});

test("sets the outdoor sensor", async ({ page }) => {
  await open(page, { states: STATES });

  await page
    .getByRole("heading", { name: "House" })
    .locator("..")
    .getByLabel("Outdoor temperature")
    .selectOption("sensor.outdoor_temperature");

  await expect
    .poll(async () => (await lastSaved(page))?.house.outdoor_sensor)
    .toBe("sensor.outdoor_temperature");
});

test("adds a room unit, reading what it can do from its modes", async ({
  page,
}) => {
  await open(page, {
    states: STATES,
    config: { ...LIVING_ROOM, room_units: [] },
  });
  const zone = page.getByRole("region", { name: "Living room" });

  await zone
    .getByLabel("Add a room unit")
    .selectOption("climate.living_room_hisense_ac");
  await zone.getByRole("button", { name: "Add unit" }).click();

  await expect(zone.getByRole("listitem")).toContainText([
    "Living room Hisense AC",
  ]);
  await expect(zone.getByRole("listitem")).toContainText(["heats and cools"]);
  const saved = await lastSaved(page);
  expect(saved.zones[0]?.heating_order).toEqual(["living_room_hisense_ac"]);
  expect(saved.zones[0]?.cooling_order).toEqual(["living_room_hisense_ac"]);
});

test("reorders room units", async ({ page }) => {
  await open(page, { states: STATES, config: LIVING_ROOM });
  const zone = page.getByRole("region", { name: "Living room" });

  await zone.getByRole("button", { name: "Move Living room TRV up" }).click();

  await expect(zone.getByRole("listitem").first()).toContainText(
    "Living room TRV",
  );
  const saved = await lastSaved(page);
  expect(saved.zones[0]?.heating_order).toEqual([
    "living_room_trv",
    "living_room_hisense_ac",
  ]);
  expect(saved.zones[0]?.cooling_order).toEqual(["living_room_hisense_ac"]);
});

test("shows what a shadow zone would do, and why", async ({ page }) => {
  await open(page, {
    config: LIVING_ROOM,
    states: [
      ...STATES,
      {
        entity_id: "climate.living_room",
        state: "heat_cool",
        attributes: {
          hzt_zone_id: "living_room",
          zone_state: "heating",
          shadow: true,
          current_temperature: 21.4,
          reason: "0.6 °C below 22.0, demand 30%: #1 living_room_hisense_ac.",
        },
      },
    ],
  });
  const zone = page.getByRole("region", { name: "Living room" });

  await expect(zone.getByText("Would heat")).toBeVisible();
  await expect(zone.getByText("Room 21.4 °C · Target 22.0 °C")).toBeVisible();
  await expect(zone).toContainText("0.6 °C below 22.0");
  await expect(zone).toContainText("Shadow mode");
});

test("doesn't offer HZT's own zones as room units", async ({ page }) => {
  await open(page, {
    config: { ...LIVING_ROOM, room_units: [] },
    states: [
      ...STATES,
      {
        entity_id: "climate.living_room",
        state: "heat_cool",
        attributes: {
          friendly_name: "Living room",
          hzt_zone_id: "living_room",
        },
      },
    ],
  });

  const options = page
    .getByRole("region", { name: "Living room" })
    .getByLabel("Add a room unit")
    .locator("option");
  await expect(options).toHaveText([
    "Choose a climate entity",
    "Living room Hisense AC",
    "Living room TRV",
  ]);
});
