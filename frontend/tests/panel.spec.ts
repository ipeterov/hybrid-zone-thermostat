import { expect, type Page, test } from "@playwright/test";

import {
  DEVICES,
  FIXTURES,
  type Fixture,
  LIVING_ROOM,
} from "../harness/fixtures";
import type { HouseConfig } from "../src/hass";

async function open(page: Page, fixture: Fixture | undefined) {
  await page.addInitScript((f) => {
    window.hztFixture = f;
  }, fixture ?? {});
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
const outdoorCard = (page: Page) =>
  page.getByRole("region", { name: "Outdoor temperature" });

async function openUnit(page: Page, name: string) {
  await page
    .getByRole("button", { name: new RegExp(`^${name} `) })
    .first()
    .click();
  await expect(side(page).getByRole("heading", { name })).toBeVisible();
}

// ---- Loading and empty ---------------------------------------------------

test("an empty house explains zones and offers to add one", async ({
  page,
}) => {
  await open(page, FIXTURES.empty);

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

// ---- Zones -------------------------------------------------------------

test("adds a zone, in shadow mode, and selects it", async ({ page }) => {
  await open(page, FIXTURES.empty);

  await side(page).getByLabel("Name").fill("Living room");
  await side(page)
    .getByLabel("Room temperature")
    .selectOption("sensor.co2_monitor_temperature");
  await side(page).getByRole("button", { name: "Add zone" }).click();

  await expect(
    side(page).getByRole("heading", { name: "Living room" }),
  ).toBeVisible();
  await expect(side(page)).toContainText("Shadow mode.");
  const saved = await lastSaved(page);
  expect(saved?.zones).toEqual([
    expect.objectContaining({
      id: "living_room",
      room_sensor: "sensor.co2_monitor_temperature",
      shadow: true,
    }),
  ]);
});

test("offers only temperature sensors", async ({ page }) => {
  await open(page, FIXTURES.empty);

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

test("maps every unit to its zone and shows what's running", async ({
  page,
}) => {
  await open(page, FIXTURES.house);

  await expect(page.getByText("Would heat · #1")).toBeVisible();
  await expect(page.getByText("Standby · #2")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Bedroom 19\.8 → 20\.0 · idle/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Entryway 16\.1 → 18\.0 · off/ }),
  ).toBeVisible();
});

test("selecting another zone shows it on the side", async ({ page }) => {
  await open(page, FIXTURES.house);

  await page.getByRole("button", { name: /^Bedroom 19\.8/ }).click();

  await expect(
    side(page).getByRole("heading", { name: "Bedroom" }),
  ).toBeVisible();
  await expect(side(page)).toContainText("between 20.0 and 21.5");
});

test("shows a zone's state, reason and heating order", async ({ page }) => {
  await open(page, FIXTURES["living-room"]);

  await expect(side(page).getByText("Would heat")).toBeVisible();
  await expect(side(page)).toContainText("0.6 °C below 22.0");
  await expect(
    side(page)
      .getByRole("list", { name: "Heating order" })
      .getByRole("listitem"),
  ).toHaveText([
    /Hisense AC[\s\S]*First choice/,
    /Living room radiator[\s\S]*#1 can’t keep up/,
  ]);
  // One cooler isn't an order.
  await expect(
    side(page).getByRole("list", { name: "Cooling order" }),
  ).toHaveCount(0);
  await expect(side(page)).toContainText("Does all the cooling.");
});

test("one unit doing both gets one line, not two orders", async ({ page }) => {
  await open(page, FIXTURES["just-the-ac"]);

  await expect(side(page)).toContainText("Heating and cooling");
  await expect(side(page)).toContainText("Does all the heating and cooling.");
  await expect(side(page).getByRole("list")).toHaveCount(0);
});

test("the idle band says when cooling starts", async ({ page }) => {
  await open(page, FIXTURES["living-room"]);

  await side(page).getByLabel("Idle band").selectOption("2");

  await expect
    .poll(async () => (await lastSaved(page))?.zones[0]?.idle_band)
    .toBe(2);
  await expect(side(page)).toContainText("cools above 24.0");
});

test("reorders the heating order", async ({ page }) => {
  await open(page, FIXTURES["living-room"]);

  await side(page)
    .getByRole("button", { name: "Move Living room radiator up" })
    .click();

  await expect
    .poll(async () => (await lastSaved(page))?.zones[0]?.heating_order)
    .toEqual(["living_room_radiator", "hisense_ac"]);
});

// ---- Shadow and live ---------------------------------------------------

test("going live asks first, then saves", async ({ page }) => {
  await open(page, FIXTURES["just-the-ac"]);

  await side(page).getByRole("button", { name: "Go live…" }).click();
  await expect(side(page)).toContainText("Hand Hisense AC to HZT?");
  expect(await lastSaved(page)).toBeUndefined();
  await side(page)
    .getByRole("button", { name: "Go live", exact: true })
    .click();

  await expect
    .poll(async () => (await lastSaved(page))?.zones[0]?.shadow)
    .toBe(false);
  await expect(side(page)).toContainText("Live.");
});

test("a live zone says what HZT controls and offers shadow mode back", async ({
  page,
}) => {
  await open(page, FIXTURES.live);

  await expect(side(page)).toContainText("HZT sets Hisense AC’s mode");
  await side(page).getByRole("button", { name: "Back to shadow mode" }).click();

  await expect
    .poll(async () => (await lastSaved(page))?.zones[0]?.shadow)
    .toBe(true);
});

// ---- Room units --------------------------------------------------------

test("adds a room unit, reading what it can do from its modes", async ({
  page,
}) => {
  await open(page, {
    config: { ...LIVING_ROOM, room_units: [] },
    states: DEVICES,
  });

  await side(page).getByRole("button", { name: "+ Room unit" }).click();
  await side(page)
    .getByLabel("Device")
    .selectOption("climate.living_room_hisense_ac");
  await side(page).getByRole("button", { name: "Add unit" }).click();

  await expect(side(page)).toContainText("Does all the heating and cooling.");
  const saved = await lastSaved(page);
  expect(saved?.zones[0]?.heating_order).toEqual(["hisense_ac"]);
  expect(saved?.zones[0]?.cooling_order).toEqual(["hisense_ac"]);
  expect(saved?.room_units[0]).toEqual(
    expect.objectContaining({ heat_lockout_below: null, min_run: 6 }),
  );
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

  await expect(side(page).locator("optgroup[label^='ACs'] option")).toHaveText([
    "Bedroom radiator",
    "Entryway radiator",
    "Hisense AC",
    "Living room radiator",
  ]);
});

test("a heating lockout says who takes over", async ({ page }) => {
  await open(page, FIXTURES["living-room"]);
  await openUnit(page, "Hisense AC");

  await expect(side(page)).toContainText(
    "Below −15 °C, Living room radiator takes over the heating. It’s 7.2 °C now.",
  );
});

test("a lockout on the only heater says nothing will heat", async ({
  page,
}) => {
  await open(page, FIXTURES["just-the-ac"]);
  await openUnit(page, "Hisense AC");

  await side(page).getByLabel("Stop heating below").selectOption("-15");

  await expect
    .poll(
      async () => (await lastSaved(page))?.room_units[0]?.heat_lockout_below,
    )
    .toBe(-15);
  await expect(side(page)).toContainText(
    "Below −15 °C, nothing heats Living room.",
  );
});

test("lockouts need an outdoor sensor, and say so", async ({ page }) => {
  await open(page, FIXTURES["no-outdoor-sensor"]);

  await expect(outdoorCard(page)).toContainText(
    "Without a sensor, lockouts are off",
  );
  await openUnit(page, "Hisense AC");
  await expect(side(page).getByLabel("Stop heating below")).toBeDisabled();
  await expect(side(page)).toContainText("Needs an outdoor sensor");
});

test("a locked-out unit shows on the map and in the outdoor card", async ({
  page,
}) => {
  await open(page, FIXTURES["locked-out"]);

  await expect(page.getByText("Locked out · #1")).toBeVisible();
  await expect(outdoorCard(page)).toContainText(
    "It’s −18.0 °C now. Hisense AC can’t heat now.",
  );
});

test("sets the outdoor sensor", async ({ page }) => {
  await open(page, FIXTURES.empty);

  await outdoorCard(page)
    .getByLabel("Sensor")
    .selectOption("sensor.outdoor_temperature");

  await expect
    .poll(async () => (await lastSaved(page))?.house.outdoor_sensor)
    .toBe("sensor.outdoor_temperature");
});

test("equipment protection says what it does", async ({ page }) => {
  await open(page, FIXTURES["just-the-ac"]);
  await openUnit(page, "Hisense AC");

  await side(page).getByLabel("Runs at least").selectOption("8");

  await expect
    .poll(async () => (await lastSaved(page))?.room_units[0]?.min_run)
    .toBe(8);
  await expect(side(page)).toContainText(
    "Once started, it runs at least 8 min",
  );
  await expect(side(page)).toContainText(
    "Switching between heating and cooling waits at least 10 min.",
  );
});

test("removes a room unit", async ({ page }) => {
  await open(page, FIXTURES["living-room"]);
  await openUnit(page, "Living room radiator");

  await side(page)
    .getByRole("button", { name: "Remove from Living room" })
    .click();

  await expect
    .poll(async () => (await lastSaved(page))?.room_units.map((u) => u.id))
    .toEqual(["hisense_ac"]);
});

// ---- Screen sizes ------------------------------------------------------

test("on a narrow screen, offers HA's sidebar and fits the width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, FIXTURES.house);
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
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("on a wide screen, leaves the sidebar to HA", async ({ page }) => {
  await open(page, FIXTURES.house);

  await expect(
    page.getByRole("button", { name: "Open the sidebar" }),
  ).toHaveCount(0);
});

test("?zone= opens that zone", async ({ page }) => {
  await page.addInitScript((f) => {
    window.hztFixture = f;
  }, FIXTURES.house ?? {});
  await page.goto("/?zone=bedroom");

  await expect(
    side(page).getByRole("heading", { name: "Bedroom" }),
  ).toBeVisible();
});

test("a relay is added as a heater and opens to confirm it", async ({
  page,
}) => {
  await open(page, {
    config: { ...LIVING_ROOM, room_units: [] },
    states: DEVICES,
  });

  await side(page).getByRole("button", { name: "+ Room unit" }).click();
  await side(page)
    .getByLabel("Device")
    .selectOption("switch.living_room_heater_plug");
  await side(page).getByRole("button", { name: "Add unit" }).click();

  await expect(
    side(page).getByRole("heading", { name: "Heater plug" }),
  ).toBeVisible();
  await expect(side(page).getByLabel("Heats", { exact: true })).toBeChecked();
  await expect(
    side(page).getByLabel("Cools", { exact: true }),
  ).not.toBeChecked();
  await expect(side(page)).toContainText("HZT only switches its power");
  const saved = await lastSaved(page);
  expect(saved?.room_units[0]).toEqual(
    expect.objectContaining({
      entity_id: "switch.living_room_heater_plug",
      can_heat: true,
      can_cool: false,
      cycle_minutes: 10,
    }),
  );
});

test("the device picker separates climate entities from relays", async ({
  page,
}) => {
  await open(page, {
    config: { ...LIVING_ROOM, room_units: [] },
    states: DEVICES,
  });

  await side(page).getByRole("button", { name: "+ Room unit" }).click();

  // Lights count (plugs often show up as lights); a device's settings
  // switches don't.
  await expect(
    side(page).locator("optgroup[label^='Relays'] option"),
  ).toHaveText(["Heater plug · Living Room", "Lava lamp · Living Room"]);
});

test("a heater's cycle says what it does", async ({ page }) => {
  await open(page, FIXTURES.heater);
  await openUnit(page, "Heater plug");

  await expect(side(page)).toContainText(
    "at 40 % demand it’s on 4 min of every 10",
  );
  await side(page).getByLabel("Cycle").selectOption("30");

  await expect
    .poll(async () => (await lastSaved(page))?.room_units[1]?.cycle_minutes)
    .toBe(30);
  await expect(side(page)).toContainText("part of every 30 minutes");
});

test("a climate unit has no switching settings", async ({ page }) => {
  await open(page, FIXTURES.heater);
  await openUnit(page, "Hisense AC");

  await expect(side(page)).not.toContainText("Switched on and off");
});
