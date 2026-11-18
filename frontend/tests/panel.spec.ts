import { expect, test } from "@playwright/test";

test("an empty house says there are no zones", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Climate zones" }),
  ).toBeVisible();
  await expect(page.getByText("No zones yet.")).toBeVisible();
});

test("lists the zones it's given", async ({ page }) => {
  await page.addInitScript(() => {
    window.hztFixture = {
      config: {
        zones: [
          { id: "living_room", name: "Living room" },
          { id: "bedroom", name: "Bedroom" },
        ],
        room_units: [],
        central_units: [],
      },
    };
  });
  await page.goto("/");

  await expect(page.getByRole("listitem")).toHaveText([
    "Living room",
    "Bedroom",
  ]);
});

test("says when the zones can't be loaded", async ({ page }) => {
  await page.addInitScript(() => {
    window.hztFixture = { error: "Hybrid Zone Thermostat isn't set up." };
  });
  await page.goto("/");

  await expect(page.getByRole("alert")).toContainText("isn't set up");
});
