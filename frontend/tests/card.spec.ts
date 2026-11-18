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
  await expect(living.getByRole("status")).toHaveText(
    "Would heat · 0.6 °C below 22.0: heating with Hisense AC at 60%.",
  );
  // Shadow mode is said with the state it qualifies.
  await expect(living.locator(".status")).toContainText(
    "Shadow mode: HZT decides but sends nothing to the units.",
  );
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
  await expect(entryway.getByRole("status")).toHaveText(
    "Off · Nothing runs until it’s turned on.",
  );
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
  const pin = living.locator(".needle");
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

test("the menu opens HA's views of the zone, straight at the part", async ({
  page,
}) => {
  await openCards(page, FIXTURES["just-the-ac"]);
  const living = card(page, "Living room");
  const more = living.getByRole("button", { name: "More for Living room" });

  for (const [label, view] of [
    ["History", "history"],
    ["Entity settings", "settings"],
    ["Related", "related"],
  ]) {
    await more.click();
    await living.getByRole("menuitem", { name: label }).click();
    expect(await lastCall(page, "more-info")).toEqual({
      type: "more-info",
      entityId: "climate.living_room",
      view,
    });
    await expect(living.getByRole("menu")).toHaveCount(0);
  }
});

test("the menu sits above the band, item by item", async ({ page }) => {
  // A wide band, so its upper edge runs under the open menu.
  const fixture = FIXTURES["living-room"] ?? {};
  await openCards(page, {
    ...fixture,
    states: (fixture.states ?? []).map((e) =>
      e.entity_id === "climate.living_room"
        ? { ...e, attributes: { ...e.attributes, idle_band: 5 } }
        : e,
    ),
  });
  const living = card(page, "Living room");
  await living.getByRole("button", { name: "More for Living room" }).click();

  for (const name of [
    "Zone settings",
    "History",
    "Entity settings",
    "Related",
  ]) {
    const item = living.getByRole("menuitem", { name });
    const box = await item.boundingBox();
    if (!box) {
      throw new Error(`No ${name}`);
    }
    // What's under the item's middle is the item itself.
    const top = await page.evaluate(
      ([x, y]) => {
        const root = document.querySelector("hzt-zone-card")?.shadowRoot;
        return root?.elementFromPoint(x as number, y as number)?.textContent;
      },
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(top?.trim()).toBe(name);
  }
});

test("a drag by a label ends when it's let go", async ({ page }) => {
  await openCards(page, FIXTURES["living-room"]);
  const living = card(page, "Living room");
  const label = await living
    .getByRole("slider", { name: "Heating starts below" })
    .boundingBox();
  if (!label) {
    throw new Error("No label");
  }
  const y = label.y + label.height / 2;

  await page.mouse.move(label.x + label.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(label.x + label.width / 2 - 40, y, { steps: 4 });
  await expect(living.locator(".band.dragging")).toHaveCount(1);
  await page.mouse.up();

  await expect(living.locator(".band.dragging")).toHaveCount(0);
  // Moving the pointer afterwards changes nothing.
  const before = await lastService(page);
  await page.mouse.move(label.x - 120, y, { steps: 4 });
  expect(await lastService(page)).toEqual(before);
  await expect(living.locator(".band.dragging")).toHaveCount(0);
});

test("the menu closes on Escape or a click elsewhere", async ({ page }) => {
  await openCards(page, FIXTURES["just-the-ac"]);
  const living = card(page, "Living room");
  const more = living.getByRole("button", { name: "More for Living room" });

  await more.click();
  await page.keyboard.press("Escape");
  await expect(living.getByRole("menu")).toHaveCount(0);

  await more.click();
  await living.getByText("Room", { exact: true }).click();
  await expect(living.getByRole("menu")).toHaveCount(0);
});

test("the room comes down from above, the set hand up from below", async ({
  page,
}) => {
  // The room right at the target.
  const fixture = FIXTURES["living-room"] ?? {};
  await openCards(page, {
    ...fixture,
    states: (fixture.states ?? []).map((e) =>
      e.entity_id === "climate.living_room"
        ? {
            ...e,
            attributes: { ...e.attributes, current_temperature: 22.5 },
          }
        : e,
    ),
  });
  const living = card(page, "Living room");

  const flag = living.locator(".flag");
  await expect(flag).toHaveText("22.5°");
  const flagBox = await flag.boundingBox();
  const hand = await living.locator(".hand").boundingBox();
  const bar = await living.locator(".seg.idle").boundingBox();
  if (!(flagBox && hand && bar)) {
    throw new Error("Missing part");
  }
  // Nothing of one sits on the other, and on target they line up.
  expect(flagBox.y + flagBox.height).toBeLessThanOrEqual(bar.y);
  expect(hand.y).toBeGreaterThanOrEqual(bar.y - 2);
  expect(
    Math.abs(flagBox.x + flagBox.width / 2 - (hand.x + hand.width / 2)),
  ).toBeLessThan(1.5);
});

test("each edge's label hangs from its edge", async ({ page }) => {
  await openCards(page, FIXTURES["living-room"]);
  const living = card(page, "Living room");

  for (const [which, name] of [
    ["low", "Heating starts below"],
    ["high", "Cooling starts above"],
  ]) {
    const tick = await living.locator(`.tick.${which}`).boundingBox();
    const label = await living.getByRole("slider", { name }).boundingBox();
    if (!(tick && label)) {
      throw new Error("Missing part");
    }
    const edgeX = tick.x + tick.width / 2;
    // Touching: the label starts where the tick ends, at the edge's x.
    expect(Math.abs(label.y - (tick.y + tick.height))).toBeLessThanOrEqual(1);
    expect(
      Math.abs((which === "low" ? label.x + label.width : label.x) - edgeX),
    ).toBeLessThanOrEqual(1.5);
  }
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

test("dragging the target follows the pointer, and sends a tenth on release", async ({
  page,
}) => {
  await openCards(page, FIXTURES["living-room"]);
  const living = card(page, "Living room");
  const knob = living.getByRole("slider", { name: "Target" });
  const from = await bandX(page, 22.5);
  const to = await bandX(page, 24.12);

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });

  // The hand is where the pointer is, not on a step.
  const ring = await living.locator(".hand").boundingBox();
  expect(Math.abs((ring?.x ?? 0) + (ring?.width ?? 0) / 2 - to.x)).toBeLessThan(
    1.5,
  );
  await expect(living).toContainText(/Target\s*24\.1/);
  await expect(knob).toHaveAttribute("aria-valuetext", "Target 24.1 °C");
  await expect(
    living.getByRole("slider", { name: "Heating starts below" }),
  ).toHaveText(/Heats below\s*23\.6/);
  expect(await lastService(page)).toBeUndefined();

  await page.mouse.up();

  expect(await lastService(page)).toEqual({
    type: "call_service",
    domain: "climate",
    service: "set_temperature",
    data: { entity_id: "climate.living_room", temperature: 24.1 },
  });
  await expect(living).toContainText(/Target\s*24\.1/);
});

test("an edge itself can be dragged, as its label can", async ({ page }) => {
  await openCards(page, FIXTURES["living-room"]);
  const living = card(page, "Living room");
  const tick = await living.locator(".tick.high").boundingBox();
  if (!tick) {
    throw new Error("No edge");
  }
  const step = (await bandX(page, 1)).x - (await bandX(page, 0)).x;
  const grab = { x: tick.x + tick.width / 2, y: tick.y + tick.height / 2 };

  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + step, grab.y, { steps: 4 });
  await page.mouse.up();

  expect((await lastService(page))?.data).toEqual({
    entity_id: "climate.living_room",
    idle_band: 3,
  });
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
  await page.mouse.move(grab.x + 1, grab.y);
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

test("a stored band shows as it is, and changing the target keeps it", async ({
  page,
}) => {
  const fixture = FIXTURES["living-room"] ?? {};
  await openCards(page, {
    ...fixture,
    states: (fixture.states ?? []).map((e) =>
      e.entity_id === "climate.living_room"
        ? { ...e, attributes: { ...e.attributes, idle_band: 1.5 } }
        : e,
    ),
  });
  const living = card(page, "Living room");
  const low = living.getByRole("slider", { name: "Heating starts below" });

  await expect(low).toHaveText(/Heats below\s*21\.75/);
  await living.getByRole("button", { name: "Raise the target" }).click();

  await expect(low).toHaveText(/Heats below\s*22\.25/);
  const services = await page.evaluate(() =>
    window.hztCalls.filter((c) => c.type === "call_service"),
  );
  expect(services.map((c) => c.service)).toEqual(["set_temperature"]);
});

test("arrow keys move the target and the band's edges", async ({ page }) => {
  await openCards(page, FIXTURES["living-room"]);
  const living = card(page, "Living room");

  await living.getByRole("slider", { name: "Target" }).focus();
  await page.keyboard.press("ArrowLeft");
  expect((await lastService(page))?.data).toEqual({
    entity_id: "climate.living_room",
    temperature: 22.4,
  });

  await living.getByRole("slider", { name: "Heating starts below" }).focus();
  await page.keyboard.press("ArrowLeft");
  expect((await lastService(page))?.data).toEqual({
    entity_id: "climate.living_room",
    idle_band: 1.2,
  });
  await expect(
    living.getByRole("img", {
      name: /Heats below 21\.8 °C, idle up to 23\.0 °C/,
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

test("settings, Configure and the shadow note lead to the zone in Climate zones", async ({
  page,
}) => {
  await openCards(page, FIXTURES["just-the-ac"]);
  const living = card(page, "Living room");

  await living.getByRole("link", { name: "Go live in Climate zones" }).click();
  expect((await lastCall(page, "navigate"))?.path).toBe(
    "/climate-zones?zone=living_room",
  );

  await living.getByRole("link", { name: "Configure" }).click();
  expect((await lastCall(page, "navigate"))?.path).toBe(
    "/climate-zones?zone=living_room",
  );

  await living.getByRole("button", { name: "More for Living room" }).click();
  await living.getByRole("menuitem", { name: "Zone settings" }).click();
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
