import { expect, type Page, test } from "@playwright/test";

import {
  DEVICES,
  FIXTURES,
  type Fixture,
  LIVING_ROOM,
} from "../harness/fixtures";
import type { HouseConfig } from "../src/hass";

async function open(page: Page, fixture: Fixture | undefined, query = "") {
  await page.addInitScript((f) => {
    window.hztFixture = f;
  }, fixture ?? {});
  await page.goto(`/${query}`);
}

function lastSaved(page: Page): Promise<HouseConfig | undefined> {
  return page.evaluate(() => {
    const saves = window.hztCalls.filter(
      (call) => call.type === "hybrid_zone_thermostat/config/save",
    );
    return saves.at(-1)?.config as HouseConfig | undefined;
  });
}

const zone = (page: Page, name: string) =>
  page.getByRole("article", { name, exact: true });
const unit = (page: Page, zoneName: string, name: string) =>
  zone(page, zoneName).getByRole("region", { name, exact: true });
const panel = (scope: Page | ReturnType<Page["locator"]>, name: string) =>
  scope.getByRole("group", { name });

const withoutUnits = {
  config: { ...LIVING_ROOM, room_units: [] },
  states: DEVICES,
};

// ---- The house -------------------------------------------------------------

test("an empty house says what HZT does and offers to control a room", async ({
  page,
}) => {
  await open(page, FIXTURES.empty);

  await expect(page.getByRole("heading", { name: "Your house" })).toBeVisible();
  await expect(
    page.getByText("HZT keeps each room within a band"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Control a room" }),
  ).toBeVisible();
});

test("says when the zones can't be loaded", async ({ page }) => {
  await open(page, { error: "Hybrid Zone Thermostat isn't set up." });

  await expect(page.getByRole("alert")).toContainText("isn't set up");
});

test("a house with no room offers no extras: there's nothing for them to act on", async ({
  page,
}) => {
  await open(page, FIXTURES.empty);

  await expect(
    page.getByRole("button", { name: "Control a room" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use the outdoor temperature" }),
  ).toHaveCount(0);
});

test("the outdoor temperature waits behind a pill until it's wanted", async ({
  page,
}) => {
  await open(page, FIXTURES["no-outdoor-sensor"]);

  await page
    .getByRole("button", { name: "Use the outdoor temperature" })
    .click();
  await panel(page, "Use the outdoor temperature")
    .getByLabel("Read from")
    .selectOption("sensor.outdoor_temperature");

  await expect
    .poll(async () => (await lastSaved(page))?.house.outdoor_sensor)
    .toBe("sensor.outdoor_temperature");
  await expect(panel(page, "Use the outdoor temperature")).toContainText(
    "No unit uses it yet.",
  );
});

test("the outdoor panel says which units it stops, and × turns it off", async ({
  page,
}) => {
  await open(page, FIXTURES["living-room"]);
  const outdoor = panel(page, "Use the outdoor temperature");

  await expect(outdoor).toContainText("Hisense AC stops heating below −15 °C.");
  await expect(outdoor).toContainText(
    "Without it, those limits stop applying.",
  );
  await outdoor
    .getByRole("button", { name: "Turn off: use the outdoor temperature" })
    .click();

  await expect
    .poll(async () => (await lastSaved(page))?.house.outdoor_sensor)
    .toBeNull();
  await expect(
    page.getByRole("button", { name: "Use the outdoor temperature" }),
  ).toBeVisible();
});

// ---- Rooms -----------------------------------------------------------------

test("adding a room asks its name and shows what it still needs", async ({
  page,
}) => {
  await open(page, FIXTURES.empty);

  await page.getByRole("button", { name: "Control a room" }).click();
  await page.getByLabel("What’s the room called?").fill("Bedroom");
  await page.getByRole("button", { name: "Add room" }).click();

  const saved = await lastSaved(page);
  expect(saved?.zones).toEqual([
    expect.objectContaining({ id: "bedroom", shadow: true, room_sensor: null }),
  ]);
  await expect(zone(page, "Bedroom")).toContainText("Not set up yet");
  await expect(zone(page, "Bedroom")).toContainText(
    "Two things and HZT can look after Bedroom",
  );
  await expect(
    page.getByRole("button", { name: "Control another room" }),
  ).toBeVisible();
});

test("a new room offers only temperature sensors, with their readings", async ({
  page,
}) => {
  await open(page, {
    config: {
      ...LIVING_ROOM,
      zones: [{ ...LIVING_ROOM.zones[0], room_sensor: null } as never],
      room_units: [],
    },
    states: DEVICES,
  });

  const sensor = zone(page, "Living room").getByLabel("Reads the room from");
  // Not a device's diagnostics (the AC's chip temperature).
  await expect(sensor.locator("option")).toHaveText([
    "Choose a sensor",
    "Bedroom temperature · 19.8 °C",
    "CO2 Monitor Temperature · 21.4 °C",
    "Entryway temperature · 16.1 °C",
    "Hisense AC Indoor coil temperature · 48.0 °C",
    "Outdoor temperature · 7.2 °C",
  ]);
  await sensor.selectOption("sensor.co2_monitor_temperature");

  await expect
    .poll(async () => (await lastSaved(page))?.zones[0]?.room_sensor)
    .toBe("sensor.co2_monitor_temperature");
});

test("a room read by its own unit's sensor gets a warning", async ({
  page,
}) => {
  await open(page, {
    config: {
      ...LIVING_ROOM,
      zones: LIVING_ROOM.zones.map((z) => ({
        ...z,
        room_sensor: "sensor.living_room_hisense_ac_indoor_coil_temperature",
      })),
    },
    states: DEVICES,
  });

  await expect(zone(page, "Living room")).toContainText(
    "This sensor is part of Hisense AC, so it reads the unit",
  );
});

test("a room read by a sensor elsewhere gets no warning", async ({ page }) => {
  await open(page, FIXTURES["living-room"]);

  await expect(zone(page, "Living room")).not.toContainText(
    "This sensor is part of",
  );
});

test("each room says what it's doing, and why", async ({ page }) => {
  await open(page, FIXTURES.house);

  await expect(zone(page, "Living room")).toContainText("Would heat · 21.4 °C");
  await expect(zone(page, "Living room")).toContainText(
    "0.6 °C below 22.0: heating with Hisense AC at 60%.",
  );
  await expect(zone(page, "Bedroom")).toContainText("Idle · 19.8 °C");
  await expect(zone(page, "Entryway")).toContainText("Off · 16.1 °C");
});

test("a save's reload doesn't blank the room's status", async ({ page }) => {
  await open(page, FIXTURES["living-room"]);
  const room = zone(page, "Living room");
  await expect(room).toContainText("Would heat · 21.4 °C");

  // Reloading after a save, HA briefly has the zone's entity unavailable.
  await page.evaluate(() =>
    window.hztSetState({
      entity_id: "climate.living_room",
      state: "unavailable",
      attributes: { friendly_name: "Living room" },
    }),
  );

  await expect(room).toContainText("Would heat · 21.4 °C");
  await expect(room).toContainText("0.6 °C below 22.0");
  await expect(room).not.toContainText("Starting");
});

test("the band is centred on the target and says where", async ({ page }) => {
  await open(page, FIXTURES["living-room"]);
  const room = zone(page, "Living room");

  await expect(room).toContainText("22.0 – 23.0 °C");
  await room.getByLabel("Idle band").selectOption("2");

  await expect
    .poll(async () => (await lastSaved(page))?.zones[0]?.idle_band)
    .toBe(2);
  await expect(room).toContainText("Heats below 21.5, cools above 23.5");
});

test("the target can be set here too", async ({ page }) => {
  await open(page, FIXTURES["living-room"]);

  await zone(page, "Living room").getByLabel("Target").fill("23.4");
  await zone(page, "Living room").getByLabel("Target").press("Enter");

  await expect
    .poll(async () => (await lastSaved(page))?.zones[0]?.target)
    .toBe(23.4);
});

test("removes a room", async ({ page }) => {
  await open(page, FIXTURES.house);

  await zone(page, "Entryway")
    .getByRole("button", { name: "Remove room" })
    .click();

  await expect
    .poll(async () => (await lastSaved(page))?.zones.map((z) => z.id))
    .toEqual(["living_room", "bedroom"]);
});

// ---- Orders ----------------------------------------------------------------

test("two heaters make a heating order; one cooler isn't an order", async ({
  page,
}) => {
  await open(page, FIXTURES["living-room"]);
  const room = zone(page, "Living room");

  await expect(
    room.getByRole("list", { name: "Heating order" }).getByRole("listitem"),
  ).toHaveText([/Hisense AC/, /Living room radiator/]);
  await expect(room.getByRole("list", { name: "Cooling order" })).toHaveCount(
    0,
  );
  await expect(unit(page, "Living room", "Hisense AC")).toContainText(
    "Heats and cools",
  );
});

test("one unit doing both has no order, just what it does", async ({
  page,
}) => {
  await open(page, FIXTURES["just-the-ac"]);

  await expect(zone(page, "Living room").getByRole("list")).toHaveCount(0);
  await expect(unit(page, "Living room", "Hisense AC")).toContainText(
    "Heats and cools this room",
  );
});

test("reorders the heating order", async ({ page }) => {
  await open(page, FIXTURES["living-room"]);

  await zone(page, "Living room")
    .getByRole("button", { name: "Move Living room radiator up" })
    .click();

  await expect
    .poll(async () => (await lastSaved(page))?.zones[0]?.heating_order)
    .toEqual(["living_room_radiator", "hisense_ac"]);
});

// ---- Shadow and live -------------------------------------------------------

test("going live asks first, then saves", async ({ page }) => {
  await open(page, FIXTURES["just-the-ac"]);
  const room = zone(page, "Living room");

  await expect(room).toContainText("Shadow: HZT decides but sends nothing");
  await room.getByRole("button", { name: "Go live…" }).click();
  await expect(room).toContainText("Hand Hisense AC to HZT?");
  expect(await lastSaved(page)).toBeUndefined();
  await room.getByRole("button", { name: "Go live", exact: true }).click();

  await expect
    .poll(async () => (await lastSaved(page))?.zones[0]?.shadow)
    .toBe(false);
  await expect(room).toContainText("Live: HZT drives Hisense AC");
});

test("a live room offers shadow mode back", async ({ page }) => {
  await open(page, FIXTURES.live);

  await zone(page, "Living room")
    .getByRole("button", { name: "Use shadow mode" })
    .click();

  await expect
    .poll(async () => (await lastSaved(page))?.zones[0]?.shadow)
    .toBe(true);
});

// ---- Room units ------------------------------------------------------------

test("adds a room unit in place, reading what it can do from its modes", async ({
  page,
}) => {
  await open(page, withoutUnits);

  await zone(page, "Living room")
    .getByRole("button", { name: "Add what heats or cools it" })
    .click();
  await zone(page, "Living room")
    .getByLabel("What heats or cools Living room?")
    .selectOption("climate.living_room_hisense_ac");

  await expect(unit(page, "Living room", "Hisense AC")).toContainText(
    "Heats and cools this room",
  );
  const saved = await lastSaved(page);
  expect(saved?.zones[0]?.heating_order).toEqual(["hisense_ac"]);
  expect(saved?.zones[0]?.cooling_order).toEqual(["hisense_ac"]);
  expect(saved?.room_units[0]).toEqual(
    expect.objectContaining({ heat_lockout_below: null, min_run: 6 }),
  );
  await expect(
    zone(page, "Living room").getByRole("button", {
      name: "Help it with a second heater or cooler",
    }),
  ).toBeVisible();
});

test("adding a unit can be cancelled", async ({ page }) => {
  await open(page, FIXTURES["just-the-ac"]);
  const room = zone(page, "Living room");

  await room
    .getByRole("button", { name: "Help it with a second heater or cooler" })
    .click();
  await room.getByRole("button", { name: "Cancel" }).click();

  await expect(room.getByRole("region", { name: "New room unit" })).toHaveCount(
    0,
  );
  expect(await lastSaved(page)).toBeUndefined();
});

test("doesn't offer HZT's own zones as room units", async ({ page }) => {
  await open(page, {
    ...withoutUnits,
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

  await zone(page, "Living room")
    .getByRole("button", { name: "Add what heats or cools it" })
    .click();

  await expect(
    zone(page, "Living room").locator("optgroup[label^='ACs'] option"),
  ).toHaveText([
    "Bedroom radiator",
    "Entryway radiator",
    "Hisense AC",
    "Living room radiator",
  ]);
});

test("the device picker separates climate entities from relays", async ({
  page,
}) => {
  await open(page, withoutUnits);

  await zone(page, "Living room")
    .getByRole("button", { name: "Add what heats or cools it" })
    .click();

  // Lights count (plugs often show up as lights); a device's settings
  // switches don't.
  await expect(
    zone(page, "Living room").locator("optgroup[label^='Relays'] option"),
  ).toHaveText(["Heater plug · Living Room", "Lava lamp · Living Room"]);
});

test("a relay is added as a heater, with what to know about it", async ({
  page,
}) => {
  await open(page, withoutUnits);

  await zone(page, "Living room")
    .getByRole("button", { name: "Add what heats or cools it" })
    .click();
  await zone(page, "Living room")
    .getByLabel("What heats or cools Living room?")
    .selectOption("switch.living_room_heater_plug");

  const plug = unit(page, "Living room", "Heater plug");
  await expect(plug.getByLabel("Heats", { exact: true })).toBeChecked();
  await expect(plug.getByLabel("Cools", { exact: true })).not.toBeChecked();
  await expect(plug).toContainText("HZT only switches its power");
  expect((await lastSaved(page))?.room_units[0]).toEqual(
    expect.objectContaining({
      entity_id: "switch.living_room_heater_plug",
      can_heat: true,
      can_cool: false,
      cycle_minutes: 10,
    }),
  );
});

test("a relay heats or cools, never both", async ({ page }) => {
  await open(page, FIXTURES.heater);
  const plug = unit(page, "Living room", "Heater plug");
  const does = plug.getByRole("radiogroup", {
    name: "What Heater plug powers",
  });

  await expect(does.getByRole("radio", { name: "Heats" })).toBeChecked();
  await does.getByRole("radio", { name: "Cools" }).check();

  await expect
    .poll(async () => {
      const saved = (await lastSaved(page))?.room_units[1];
      return [saved?.can_heat, saved?.can_cool];
    })
    .toEqual([false, true]);
  await expect(plug).toContainText("HZT switches its power on to cool");
  await expect(plug).not.toContainText("HZT only switches its power");
});

test("removes a room unit", async ({ page }) => {
  await open(page, FIXTURES["living-room"]);

  await unit(page, "Living room", "Living room radiator")
    .getByRole("button", { name: "Remove" })
    .click();

  await expect
    .poll(async () => (await lastSaved(page))?.room_units.map((u) => u.id))
    .toEqual(["hisense_ac"]);
});

// ---- A unit's extras: pills that become panels -----------------------------

test("a heating limit says who takes over and whether it may heat now", async ({
  page,
}) => {
  await open(page, FIXTURES["living-room"]);

  await expect(
    panel(
      unit(page, "Living room", "Hisense AC"),
      "Stop it heating in the cold",
    ),
  ).toContainText(
    "Below −15 °C, Living room radiator takes over the heating. It’s 7.2 °C outdoors, so it may heat now.",
  );
});

test("a limit on the only heater says nothing will heat, and × lifts it", async ({
  page,
}) => {
  await open(page, FIXTURES["just-the-ac"]);
  const ac = unit(page, "Living room", "Hisense AC");

  await ac.getByRole("button", { name: "Stop it heating in the cold" }).click();
  await expect
    .poll(
      async () => (await lastSaved(page))?.room_units[0]?.heat_lockout_below,
    )
    .toBe(-15);
  const limit = panel(ac, "Stop it heating in the cold");
  await expect(limit).toContainText("Below −15 °C, nothing heats Living room.");

  await limit
    .getByRole("button", { name: "Turn off: stop it heating in the cold" })
    .click();
  await expect
    .poll(
      async () => (await lastSaved(page))?.room_units[0]?.heat_lockout_below,
    )
    .toBeNull();
  await expect(
    ac.getByRole("button", { name: "Stop it heating in the cold" }),
  ).toBeVisible();
});

test("a limit without an outdoor sensor asks for one in place", async ({
  page,
}) => {
  await open(page, FIXTURES["no-outdoor-sensor"]);
  const ac = unit(page, "Living room", "Hisense AC");

  await ac.getByRole("button", { name: "Stop it heating in the cold" }).click();
  const limit = panel(ac, "Stop it heating in the cold");
  await expect(limit).toContainText(
    "It needs to know the outdoor temperature first.",
  );
  await limit
    .getByLabel("Outdoor temperature from")
    .selectOption("sensor.outdoor_temperature");

  await expect
    .poll(async () => (await lastSaved(page))?.house.outdoor_sensor)
    .toBe("sensor.outdoor_temperature");
});

test("a locked-out unit says so", async ({ page }) => {
  await open(page, FIXTURES["locked-out"]);
  const ac = unit(page, "Living room", "Hisense AC");

  await expect(ac).toContainText("Locked out");
  await expect(panel(ac, "Stop it heating in the cold")).toContainText(
    "It’s −18.0 °C outdoors, so it can’t heat now.",
  );
});

test("longer rests open from a pill, say what they do, and × resets them", async ({
  page,
}) => {
  await open(page, FIXTURES["just-the-ac"]);
  const ac = unit(page, "Living room", "Hisense AC");

  await ac
    .getByRole("button", { name: "Let it rest longer between runs" })
    .click();
  const rest = panel(ac, "Let it rest longer between runs");
  await rest.getByLabel("Runs at least").selectOption("8");

  await expect
    .poll(async () => (await lastSaved(page))?.room_units[0]?.min_run)
    .toBe(8);
  await expect(rest).toContainText("Once started, it runs at least 8 min");
  await expect(rest).toContainText(
    "Switching between heating and cooling waits at least 10 min.",
  );

  await rest
    .getByRole("button", { name: "Turn off: let it rest longer between runs" })
    .click();
  await expect
    .poll(async () => {
      const saved = (await lastSaved(page))?.room_units[0];
      return [saved?.min_run, saved?.min_rest];
    })
    .toEqual([6, 4]);
});

test("a heater's cycle opens from a pill and says what it does", async ({
  page,
}) => {
  await open(page, FIXTURES.heater);
  const plug = unit(page, "Living room", "Heater plug");

  await plug
    .getByRole("button", { name: "Switch it on longer cycles" })
    .click();
  const cycle = panel(plug, "Switch it on longer cycles");
  await expect(cycle).toContainText("at 40 % demand it’s on 4 min of every 10");
  await cycle.getByLabel("Cycle", { exact: true }).selectOption("30");

  await expect
    .poll(async () => (await lastSaved(page))?.room_units[1]?.cycle_minutes)
    .toBe(30);
  await expect(cycle).toContainText("part of every 30 minutes");
});

test("a climate unit has no switching settings", async ({ page }) => {
  await open(page, FIXTURES.heater);

  await expect(
    unit(page, "Living room", "Hisense AC").getByRole("button", {
      name: "Switch it on longer cycles",
    }),
  ).toHaveCount(0);
});

// ---- Screen sizes and links ------------------------------------------------

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

test("?zone= brings that room into view", async ({ page }) => {
  await open(page, FIXTURES.house, "?zone=entryway");

  await expect(zone(page, "Entryway")).toHaveClass(/focused/);
  await expect(zone(page, "Entryway")).toBeInViewport();
});
