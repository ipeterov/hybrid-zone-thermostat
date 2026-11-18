import { expect, type Page, test } from "@playwright/test";

import { FIXTURES, type Fixture } from "../harness/fixtures";

async function openCards(page: Page, fixture: Fixture | undefined) {
  await page.addInitScript((f) => {
    window.hztFixture = f;
  }, fixture ?? {});
  await page.goto("/?view=card");
}

function lastService(page: Page) {
  return page.evaluate(() =>
    window.hztCalls.filter((call) => call.type === "call_service").at(-1),
  );
}

const card = (page: Page, name: string) =>
  page.locator("hzt-zone-card").filter({ hasText: name });

test("shows the room against its target, the decision and why", async ({
  page,
}) => {
  await openCards(page, FIXTURES["living-room"]);
  const living = card(page, "Living room");

  await expect(living.getByText("Would heat").first()).toBeVisible();
  await expect(living).toContainText("21.4");
  await expect(living).toContainText(/CO2 Monitor Temperature\s*· \d+ s ago/);
  await expect(living).toContainText(/Target\s*22\.5/);
  await expect(
    living.getByRole("img", {
      name: /Heats below 22\.0 °C, idle up to 23\.0 °C/,
    }),
  ).toBeVisible();
  await expect(living).toContainText("Why: 0.6 °C below 22.0");
  await expect(living).toContainText("Shadow mode");
});

test("the target buttons change the zone's target by half a degree", async ({
  page,
}) => {
  await openCards(page, FIXTURES["living-room"]);
  const living = card(page, "Living room");

  await living.getByRole("button", { name: "Raise the target" }).click();

  expect(await lastService(page)).toEqual({
    type: "call_service",
    domain: "climate",
    service: "set_temperature",
    data: { entity_id: "climate.living_room", temperature: 23 },
  });
  await expect(living).toContainText(/Target\s*23\.0/);

  await living.getByRole("button", { name: "Lower the target" }).click();
  await expect(living).toContainText(/Target\s*22\.5/);
});

test("the power button turns the zone off", async ({ page }) => {
  await openCards(page, FIXTURES["living-room"]);

  await card(page, "Living room")
    .getByRole("button", { name: "Turn Living room off" })
    .click();

  expect(await lastService(page)).toEqual(
    expect.objectContaining({
      service: "turn_off",
      data: { entity_id: "climate.living_room" },
    }),
  );
});

test("lists units in order with what each is doing", async ({ page }) => {
  await openCards(page, FIXTURES["living-room"]);
  const living = card(page, "Living room");

  await expect(living).toContainText("Room units, in heating order");
  await expect(living).toContainText("Hisense AC");
  await expect(living).toContainText("HZT: would heat");
  await expect(living).toContainText("Living room radiator");
  await expect(living).toContainText("HZT: standby");
});

test("fan and swing stay the user's, sent to the unit itself", async ({
  page,
}) => {
  await openCards(page, FIXTURES["just-the-ac"]);

  await card(page, "Living room")
    .getByRole("combobox", { name: "Hisense AC fan" })
    .selectOption("quiet");

  expect(await lastService(page)).toEqual(
    expect.objectContaining({
      service: "set_fan_mode",
      data: { entity_id: "climate.living_room_hisense_ac", fan_mode: "quiet" },
    }),
  );
});

test("a single unit has no rank to show", async ({ page }) => {
  await openCards(page, FIXTURES["just-the-ac"]);
  const living = card(page, "Living room");

  await expect(living).toContainText("Room unit");
  await expect(living).not.toContainText("in heating order");
});

test("a locked-out unit says why", async ({ page }) => {
  await openCards(page, FIXTURES["locked-out"]);

  await expect(card(page, "Living room")).toContainText(
    "HZT: locked out · below −15 °C outdoor",
  );
});

test("an off zone shows no band or reason, but its target can change", async ({
  page,
}) => {
  await openCards(page, FIXTURES.house);
  const entryway = card(page, "Entryway");

  await expect(
    entryway.getByText("Off", { exact: true }).first(),
  ).toBeVisible();
  await expect(entryway).not.toContainText("Why:");
  await expect(entryway.locator(".band")).toHaveCount(0);
  await expect(entryway.getByRole("slider")).toHaveCount(0);
  await entryway.getByRole("button", { name: "Raise the target" }).click();
  await expect(entryway).toContainText(/Target\s*18\.5/);
});

test("says so when its entity isn't a zone", async ({ page }) => {
  await page.goto("/?view=card");
  await page.evaluate(() => {
    const element = document.createElement("hzt-zone-card") as HTMLElement & {
      hass?: unknown;
      setConfig(config: object): void;
    };
    element.setConfig({ type: "custom:hzt-zone-card", entity: "climate.nope" });
    element.hass = { states: {} };
    document.body.append(element);
  });

  await expect(page.getByRole("alert")).toContainText(
    "climate.nope isn’t a Hybrid Zone Thermostat zone.",
  );
});

test("fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCards(page, FIXTURES["living-room"]);
  await expect(card(page, "Living room")).toBeVisible();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("changing the target moves its ticks, not the room", async ({ page }) => {
  await openCards(page, FIXTURES["living-room"]);
  const living = card(page, "Living room");
  const pin = living.locator(".pin");
  const before = await pin.boundingBox();

  await living.getByRole("button", { name: "Raise the target" }).click();
  await living.getByRole("button", { name: "Raise the target" }).click();
  await expect(living).toContainText(/Target\s*23\.5/);

  expect((await pin.boundingBox())?.x).toBe(before?.x);
});

function lastCall(page: Page, type: string) {
  return page.evaluate(
    (t) => window.hztCalls.filter((call) => call.type === t).at(-1),
    type,
  );
}

test("shows the last day against the band", async ({ page }) => {
  await openCards(page, FIXTURES["just-the-ac"]);
  const living = card(page, "Living room");

  await expect(
    living.getByRole("img", {
      name: "Room temperature against the idle band over the last 24 hours",
    }),
  ).toBeVisible();
  await expect(living).toContainText("24 h ago");
  expect(await lastCall(page, "history/history_during_period")).toEqual(
    expect.objectContaining({
      entity_ids: [
        "climate.living_room",
        "sensor.co2_monitor_temperature",
        "climate.living_room_hisense_ac",
      ],
    }),
  );
});

test("each unit's lane shows when its device actually ran", async ({
  page,
}) => {
  await openCards(page, FIXTURES.heater);
  const living = card(page, "Living room");

  // The harness's day: the AC cools, then heats; the heater joins late.
  await expect(
    living.getByRole("img", { name: /^Hisense AC: cooling .*, heating / }),
  ).toBeVisible();
  await expect(
    living.getByRole("img", { name: /^Heater plug: heating [^,]+–now$/ }),
  ).toBeVisible();
});

test("the zone's name opens HA's own dialog", async ({ page }) => {
  await openCards(page, FIXTURES["just-the-ac"]);

  await card(page, "Living room")
    .getByRole("button", { name: "Living room", exact: true })
    .click();

  expect(await lastCall(page, "more-info")).toEqual({
    type: "more-info",
    entityId: "climate.living_room",
  });
});

// The x of `degrees` on the living room's band, whose scale is 16 to 30.
async function bandX(page: Page, degrees: number) {
  const track = await card(page, "Living room")
    .locator(".band-track")
    .boundingBox();
  if (!track) {
    throw new Error("No band");
  }
  return {
    x: track.x + ((degrees - 16) / 14) * track.width,
    y: track.y + track.height / 2,
  };
}

test("dragging the target moves the band, and sends once on release", async ({
  page,
}) => {
  await openCards(page, FIXTURES["living-room"]);
  const living = card(page, "Living room");
  const knob = living.getByRole("slider", { name: "Target" });
  const from = await bandX(page, 22.5);
  const to = await bandX(page, 24.1);

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });

  await expect(living).toContainText(/Target\s*24\.0/);
  await expect(knob).toHaveAttribute("aria-valuetext", "Target 24.0 °C");
  await expect(
    living.getByRole("slider", { name: "Heating starts below" }),
  ).toHaveText(/Heats below\s*23\.5/);
  expect(await lastService(page)).toBeUndefined();

  await page.mouse.up();

  expect(await lastService(page)).toEqual({
    type: "call_service",
    domain: "climate",
    service: "set_temperature",
    data: { entity_id: "climate.living_room", temperature: 24 },
  });
  await expect(living).toContainText(/Target\s*24\.0/);
});

test("dragging an edge widens the band around the target", async ({ page }) => {
  await openCards(page, FIXTURES["living-room"]);
  const living = card(page, "Living room");
  const edge = living.getByRole("slider", { name: "Cooling starts above" });
  const box = await edge.boundingBox();
  if (!box) {
    throw new Error("No edge");
  }
  // Grabbed by its label, which hangs right of the edge: it mustn't jump.
  const grab = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const step = (await bandX(page, 1)).x - (await bandX(page, 0)).x;

  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + step * 0.1, grab.y);
  await expect(edge).toHaveText(/Cools above\s*23\.0/);
  await page.mouse.move(grab.x + step * 0.5, grab.y, { steps: 4 });
  await page.mouse.up();

  await expect(edge).toHaveText(/Cools above\s*23\.5/);
  await expect(
    living.getByRole("slider", { name: "Heating starts below" }),
  ).toHaveText(/Heats below\s*21\.5/);
  expect(await lastService(page)).toEqual({
    type: "call_service",
    domain: "hybrid_zone_thermostat",
    service: "set_idle_band",
    data: { entity_id: "climate.living_room", idle_band: 2 },
  });
});

test("arrow keys move the target and the band's edges", async ({ page }) => {
  await openCards(page, FIXTURES["living-room"]);
  const living = card(page, "Living room");

  await living.getByRole("slider", { name: "Target" }).focus();
  await page.keyboard.press("ArrowLeft");
  expect((await lastService(page))?.data).toEqual({
    entity_id: "climate.living_room",
    temperature: 22,
  });

  await living.getByRole("slider", { name: "Heating starts below" }).focus();
  await page.keyboard.press("ArrowLeft");
  expect((await lastService(page))?.data).toEqual({
    entity_id: "climate.living_room",
    idle_band: 1.5,
  });
  await expect(
    living.getByRole("img", {
      name: /Heats below 21\.25 °C, idle up to 22\.75 °C/,
    }),
  ).toBeVisible();
});

test("the unit and the room sensor open their own entities", async ({
  page,
}) => {
  await openCards(page, FIXTURES["just-the-ac"]);
  const living = card(page, "Living room");

  await living.getByRole("button", { name: "Hisense AC" }).click();
  expect((await lastCall(page, "more-info"))?.entityId).toBe(
    "climate.living_room_hisense_ac",
  );

  await living.getByRole("button", { name: "CO2 Monitor Temperature" }).click();
  expect((await lastCall(page, "more-info"))?.entityId).toBe(
    "sensor.co2_monitor_temperature",
  );
});

test("controls don't also open the zone", async ({ page }) => {
  await openCards(page, FIXTURES["just-the-ac"]);

  await card(page, "Living room")
    .getByRole("button", { name: "Raise the target" })
    .click();

  expect(await lastCall(page, "more-info")).toBeUndefined();
});

test("settings and the shadow note lead to the zone in Climate zones", async ({
  page,
}) => {
  await openCards(page, FIXTURES["just-the-ac"]);
  const living = card(page, "Living room");

  await living.getByRole("link", { name: "Go live in Climate zones" }).click();
  expect((await lastCall(page, "navigate"))?.path).toBe(
    "/climate-zones?zone=living_room",
  );

  await living.getByRole("link", { name: "Living room settings" }).click();
  expect((await lastCall(page, "navigate"))?.path).toBe(
    "/climate-zones?zone=living_room",
  );
});

test("a unit's row says what the device itself is doing", async ({ page }) => {
  await openCards(page, FIXTURES.cooling);
  const living = card(page, "Living room");

  await expect(living).toContainText(
    "Cooling · set 20 °C · reads 24 °C · compressor 46 Hz",
  );
  await expect(living).toContainText("HZT: cooling");
  await expect(living.locator("ha-card.cool .aurora.on")).toHaveCount(2);
});

test("no glow while nothing actually runs, even if HZT would", async ({
  page,
}) => {
  await openCards(page, FIXTURES["just-the-ac"]);
  const living = card(page, "Living room");

  await expect(living).toContainText("Off · reads 24 °C");
  await expect(living).not.toContainText("compressor");
  await expect(living.locator(".aurora.on")).toHaveCount(0);
});

test("a heater's row says how long it's on", async ({ page }) => {
  await openCards(page, FIXTURES.heater);

  await expect(card(page, "Living room")).toContainText(
    "HZT: would heat · on 6 of every 10 min",
  );
});

test("a heater isn't on standby while the zone cools", async ({ page }) => {
  const heater = FIXTURES.heater ?? {};
  const cooling = {
    ...heater,
    states: (heater.states ?? []).map((entity) =>
      entity.entity_id === "climate.living_room"
        ? {
            ...entity,
            attributes: {
              ...entity.attributes,
              zone_state: "cooling",
              demands: {
                hisense_ac: { mode: "cool", level: 1 },
                heater_plug: { mode: null, level: 0 },
              },
            },
          }
        : entity,
    ),
  };
  await openCards(page, cooling);

  await expect(card(page, "Living room")).toContainText(
    "HZT: idle, heats only",
  );
  await expect(card(page, "Living room")).not.toContainText("standby");
});

function withZoneState(fixture: Fixture | undefined, zoneState: string) {
  return {
    ...fixture,
    states: (fixture?.states ?? []).map((entity) =>
      entity.entity_id === "climate.living_room"
        ? {
            ...entity,
            attributes: { ...entity.attributes, zone_state: zoneState },
          }
        : entity,
    ),
  };
}

test("units follow the order for what the zone is doing", async ({ page }) => {
  await openCards(page, withZoneState(FIXTURES.heater, "cooling"));
  const living = card(page, "Living room");

  await expect(living).toContainText("Room units, in cooling order");
  await expect(living.locator(".rank")).toHaveText(["1", ""]);
});

test("heating shows the heating order", async ({ page }) => {
  await openCards(page, FIXTURES.heater);
  const living = card(page, "Living room");

  await expect(living).toContainText("Room units, in heating order");
  await expect(living.locator(".rank")).toHaveText(["1", "2"]);
});

test("idle, no order applies", async ({ page }) => {
  await openCards(page, withZoneState(FIXTURES.heater, "idle"));
  const living = card(page, "Living room");

  await expect(living.locator("h3")).toHaveText("Room units");
  await expect(living.locator(".rank")).toHaveText(["", ""]);
});
