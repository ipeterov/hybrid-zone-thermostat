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
  await expect(living).toContainText(/Target\s*22\.0/);
  await expect(
    living.getByRole("img", {
      name: /Heats below 22\.0 °C, idle up to 23\.5 °C/,
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
    data: { entity_id: "climate.living_room", temperature: 22.5 },
  });
  await expect(living).toContainText(/Target\s*22\.5/);

  await living.getByRole("button", { name: "Lower the target" }).click();
  await expect(living).toContainText(/Target\s*22\.0/);
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
  await expect(entryway.getByRole("img")).toHaveCount(0);
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
  await expect(living).toContainText(/Target\s*23\.0/);

  expect((await pin.boundingBox())?.x).toBe(before?.x);
});

function lastCall(page: Page, type: string) {
  return page.evaluate(
    (t) => window.hztCalls.filter((call) => call.type === t).at(-1),
    type,
  );
}

test("clicking the card opens the zone, as HA cards do", async ({ page }) => {
  await openCards(page, FIXTURES["just-the-ac"]);

  await card(page, "Living room").getByText("Room", { exact: true }).click();

  expect(await lastCall(page, "more-info")).toEqual({
    type: "more-info",
    entityId: "climate.living_room",
  });
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
  await expect(living.locator(".room.glow.cool")).toHaveCount(1);
});

test("no glow while nothing actually runs, even if HZT would", async ({
  page,
}) => {
  await openCards(page, FIXTURES["just-the-ac"]);
  const living = card(page, "Living room");

  await expect(living).toContainText("Off · reads 24 °C");
  await expect(living).not.toContainText("compressor");
  await expect(living.locator(".room.glow")).toHaveCount(0);
});

test("a heater's row says how long it's on", async ({ page }) => {
  await openCards(page, FIXTURES.heater);

  await expect(card(page, "Living room")).toContainText(
    "HZT: would heat · on 6 of every 10 min",
  );
});
