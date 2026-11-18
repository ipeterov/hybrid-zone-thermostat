import { expect, type Page, test } from "@playwright/test";

import {
  DEVICES,
  FIXTURES,
  type Fixture,
  LIVING_ROOM,
} from "../harness/fixtures";
import type { HouseConfig } from "../src/hass";

async function open(page: Page, fixture: Fixture) {
  await page.addInitScript((f) => {
    window.hztFixture = f;
  }, fixture);
  await page.goto("/");
}

function lastSaved(page: Page): Promise<HouseConfig | undefined> {
  return page.evaluate(() => {
    const saves = window.hztCalls.filter(
      (call) => call.type === "hybrid_zone_thermostat/config/save",
    );
    return saves.at(-1)?.config as HouseConfig | undefined;
  });
}

const side = (page: Page) => page.getByRole("complementary");

test("an empty house explains zones and offers to add one", async ({
  page,
}) => {
  await open(page, FIXTURES.empty ?? {});

  await expect(
    page.getByRole("heading", { name: "Climate zones" }),
  ).toBeVisible();
  await expect(page.getByText("No zones yet.")).toBeVisible();
  await expect(
    side(page).getByRole("heading", { name: "New zone" }),
  ).toBeVisible();
});

test("says when the zones can't be loaded", async ({ page }) => {
  await open(page, { error: "Hybrid Zone Thermostat isn't set up." });

  await expect(page.getByRole("alert")).toContainText("isn't set up");
});

test("adds a zone and selects it", async ({ page }) => {
  await open(page, FIXTURES.empty ?? {});

  await side(page).getByLabel("Name").fill("Living room");
  await side(page)
    .getByLabel("Room temperature")
    .selectOption("sensor.co2_monitor_temperature");
  await side(page).getByRole("button", { name: "Add zone" }).click();

  await expect(
    page.getByRole("button", { name: /Living room/, pressed: true }),
  ).toBeVisible();
  await expect(
    side(page).getByRole("heading", { name: "Living room" }),
  ).toBeVisible();
  const saved = await lastSaved(page);
  expect(saved?.zones).toEqual([
    expect.objectContaining({
      id: "living_room",
      name: "Living room",
      room_sensor: "sensor.co2_monitor_temperature",
      target: 21,
    }),
  ]);
});

test("offers only temperature sensors", async ({ page }) => {
  await open(page, FIXTURES.empty ?? {});

  await expect(
    side(page).getByLabel("Room temperature").locator("option"),
  ).toHaveText([
    "None",
    "Bedroom temperature",
    "CO2 Monitor Temperature",
    "Entryway temperature",
    "Outdoor temperature",
  ]);
});

test("sets the outdoor sensor", async ({ page }) => {
  await open(page, FIXTURES.empty ?? {});

  await page
    .locator("section", { has: page.getByRole("heading", { name: "House" }) })
    .getByLabel("Outdoor temperature")
    .selectOption("sensor.outdoor_temperature");

  await expect
    .poll(async () => (await lastSaved(page))?.house.outdoor_sensor)
    .toBe("sensor.outdoor_temperature");
});

test("maps every unit to its zone and shows what's running", async ({
  page,
}) => {
  await open(page, FIXTURES.house ?? {});

  await expect(page.getByText("Would heat · #1")).toBeVisible();
  await expect(page.getByText("Standby · #2")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Bedroom.*19\.8 → 20\.0 · idle/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Entryway.*off/ }),
  ).toBeVisible();
});

test("shows the selected zone's state, reason and orders", async ({ page }) => {
  await open(page, FIXTURES["living-room"] ?? {});

  await expect(side(page).getByText("Would heat")).toBeVisible();
  await expect(side(page)).toContainText("0.6 °C below 22.0");
  await expect(side(page)).toContainText("Shadow mode");
  await expect(
    side(page)
      .getByRole("list", { name: "Heating order" })
      .getByRole("listitem"),
  ).toHaveText([
    /Hisense AC[\s\S]*below target/,
    /Living room radiator[\s\S]*#1 can’t keep up/,
  ]);
  await expect(
    side(page)
      .getByRole("list", { name: "Cooling order" })
      .getByRole("listitem"),
  ).toHaveText([/Hisense AC/]);
});

test("selecting another zone shows it on the side", async ({ page }) => {
  await open(page, FIXTURES.house ?? {});

  await page.getByRole("button", { name: /^Bedroom/ }).click();

  await expect(
    side(page).getByRole("heading", { name: "Bedroom" }),
  ).toBeVisible();
  await expect(side(page)).toContainText("between 20.0 and 21.5");
});

test("adds a room unit, reading what it can do from its modes", async ({
  page,
}) => {
  await open(page, {
    config: { ...LIVING_ROOM, room_units: [] },
    states: DEVICES,
  });

  await side(page).getByRole("button", { name: "+ Room unit" }).click();
  await side(page)
    .getByLabel("Climate entity")
    .selectOption("climate.living_room_hisense_ac");
  await side(page).getByRole("button", { name: "Add unit" }).click();

  await expect(
    side(page).getByRole("list", { name: "Cooling order" }),
  ).toContainText("Hisense AC");
  const saved = await lastSaved(page);
  expect(saved?.zones[0]?.heating_order).toEqual(["hisense_ac"]);
  expect(saved?.zones[0]?.cooling_order).toEqual(["hisense_ac"]);
});

test("doesn't offer HZT's own zones as room units", async ({ page }) => {
  await open(page, {
    config: { ...LIVING_ROOM, room_units: [] },
    states: [
      ...DEVICES,
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

  await side(page).getByRole("button", { name: "+ Room unit" }).click();

  await expect(
    side(page).getByLabel("Climate entity").locator("option"),
  ).toHaveText([
    "Choose one",
    "Bedroom radiator",
    "Entryway radiator",
    "Hisense AC",
    "Living room radiator",
  ]);
});

test("reorders the heating order", async ({ page }) => {
  await open(page, FIXTURES["living-room"] ?? {});

  await side(page)
    .getByRole("list", { name: "Heating order" })
    .getByRole("button", { name: "Move Living room radiator up" })
    .click();

  await expect
    .poll(async () => (await lastSaved(page))?.zones[0]?.heating_order)
    .toEqual(["living_room_radiator", "hisense_ac"]);
  expect((await lastSaved(page))?.zones[0]?.cooling_order).toEqual([
    "hisense_ac",
  ]);
});

test("changes the idle band", async ({ page }) => {
  await open(page, FIXTURES["living-room"] ?? {});

  await side(page).getByLabel("Idle band").selectOption("2");

  await expect
    .poll(async () => (await lastSaved(page))?.zones[0]?.idle_band)
    .toBe(2);
  await expect(side(page)).toContainText("Cools above 24.0 °C");
});

test("removes a room unit", async ({ page }) => {
  await open(page, FIXTURES["living-room"] ?? {});

  await side(page)
    .getByRole("list", { name: "Heating order" })
    .getByRole("button", { name: "Remove Living room radiator" })
    .click();

  await expect
    .poll(async () => (await lastSaved(page))?.room_units.map((u) => u.id))
    .toEqual(["hisense_ac"]);
});

test("on a narrow screen, offers HA's sidebar from the top bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, FIXTURES.house ?? {});
  await page.evaluate(() => {
    document.addEventListener("hass-toggle-menu", () => {
      window.hztCalls.push({ type: "hass-toggle-menu" });
    });
  });

  await page.getByRole("button", { name: "Open the sidebar" }).click();

  expect(
    await page.evaluate(() =>
      window.hztCalls.some((call) => call.type === "hass-toggle-menu"),
    ),
  ).toBe(true);
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(fits).toBe(true);
});

test("on a wide screen, leaves the sidebar to HA", async ({ page }) => {
  await open(page, FIXTURES.house ?? {});

  await expect(
    page.getByRole("button", { name: "Open the sidebar" }),
  ).toHaveCount(0);
});
