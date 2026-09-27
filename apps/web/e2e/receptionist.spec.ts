import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 1 acceptance (PLAN §7): a receptionist on a phone can book, move, resize and cancel appointments,
 * and keeps working through a network drop. Requires the demo clinic (pnpm seed:demo) and running API
 * and web servers; see scripts/e2e.sh.
 */
const API = process.env.E2E_API_URL ?? "http://localhost:8080";
const RECEPTION = "90000 00002";

async function apiToken(phone: string) {
  const res = await fetch(`${API}/v1/dev/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone }),
  });
  return ((await res.json()) as { token: string }).token;
}

async function apiGet<T>(path: string): Promise<T> {
  const token = await apiToken(RECEPTION);
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return (await res.json()) as T;
}

/** A Monday–Saturday date a few days ahead, in IST. */
function nextWorkingDay(daysAhead: number): string {
  const d = new Date(Date.now() + 5.5 * 3600_000 + daysAhead * 86_400_000);
  while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Your mobile number").fill(RECEPTION);
  await page.getByRole("button", { name: "Send OTP" }).click();
  await page.getByLabel(/6-digit OTP/).fill("123456");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL("**/today");
}

async function openCalendarOn(page: Page, date: string) {
  await page.getByRole("link", { name: "Calendar" }).click();
  await page.getByLabel("Choose date").fill(date);
  await expect(page.getByTestId("day-grid")).toBeVisible();
}

/** Scrolls a clinic-local time in a calendar column into view and returns its screen position. */
async function point(page: Page, columnTitle: string, minutes: number) {
  const column = page.locator("[data-column]").nth(await columnIndex(page, columnTitle));
  const dayStart = Number(await column.getAttribute("data-day-start"));
  const offset = (minutes - dayStart) * 1.6 + 4;
  await column.evaluate((el, dy) => {
    const top = el.getBoundingClientRect().top + window.scrollY + dy;
    window.scrollTo(0, top - window.innerHeight / 2);
  }, offset);
  const box = (await column.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + offset };
}

async function columnIndex(page: Page, title: string) {
  const titles = await page.locator("[data-testid=day-grid] .h-12 p.truncate.font-medium").allTextContents();
  const i = titles.indexOf(title);
  expect(i, `column ${title}`).toBeGreaterThanOrEqual(0);
  return i;
}

interface Appt {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  patient: { name: string };
}

async function appointmentsOn(date: string): Promise<Appt[]> {
  const from = new Date(`${date}T00:00:00+05:30`).toISOString();
  const to = new Date(`${date}T23:59:00+05:30`).toISOString();
  return apiGet<Appt[]>(
    `/v1/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&includeCancelled=true`,
  );
}

const ist = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));

test("receptionist books, moves, resizes and cancels on a phone", async ({ page }) => {
  const date = nextWorkingDay(3);
  await signIn(page);
  await openCalendarOn(page, date);

  // Tap an empty evening slot in Dr. Sharma's column → booking sheet.
  const at = await point(page, "Dr. Rakesh Sharma", 20 * 60 + 30);
  await page.mouse.click(at.x, at.y);
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("New appointment")).toBeVisible();
  await sheet.getByPlaceholder("Search patient by name or phone").fill("SDC-1007");
  await sheet.locator("ul li button").first().click();
  await sheet.getByLabel("Treatment").selectOption({ label: "Scaling and polishing · 30 min" });
  await sheet.getByLabel("Chair").selectOption({ label: "Chair 2 (surgery)" });
  await sheet.getByRole("button", { name: "Book appointment" }).click();
  await expect(page.getByText("Appointment booked")).toBeVisible();

  let mine = (await appointmentsOn(date)).find((a) => ist(a.startsAt) === "20:30" && a.status === "booked");
  expect(mine, "booked at 20:30").toBeTruthy();
  const name = mine!.patient.name;
  const block = page.getByTestId(`appt-${name}`).last();
  await expect(block).toBeVisible();

  // Drag it 30 minutes earlier.
  const b = (await block.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 8);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 8 - 30 * 1.6, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByText("Appointment moved")).toBeVisible();
  mine = (await appointmentsOn(date)).find((a) => a.id === mine!.id)!;
  expect(ist(mine.startsAt)).toBe("20:00");
  expect(ist(mine.endsAt)).toBe("20:30");

  // Drag the bottom edge down 15 minutes.
  const moved = (await page.getByTestId(`appt-${name}`).last().boundingBox())!;
  await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height - 2);
  await page.mouse.down();
  await page.mouse.move(moved.x + moved.width / 2, moved.y + moved.height - 2 + 15 * 1.6, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByText("Appointment moved")).toBeVisible();
  await expect
    .poll(async () => ist((await appointmentsOn(date)).find((a) => a.id === mine!.id)!.endsAt))
    .toBe("20:45");

  // Tap → cancel.
  await page.getByTestId(`appt-${name}`).last().click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel appointment" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel appointment" }).click();
  await expect
    .poll(async () => (await appointmentsOn(date)).find((a) => a.id === mine!.id)!.status)
    .toBe("cancelled");
});

test("keeps working through a network drop and syncs afterwards", async ({ page, context }) => {
  const date = nextWorkingDay(4);
  await signIn(page);
  await openCalendarOn(page, date);
  const target = (await appointmentsOn(date)).find((a) => a.status === "booked");
  test.skip(!target, "demo data has no booked appointment that day");
  await expect(page.getByTestId(`appt-${target!.patient.name}`).first()).toBeVisible();

  await context.setOffline(true);
  await page.getByTestId(`appt-${target!.patient.name}`).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirmed" }).click();
  await expect(page.getByText(/1 change waiting to send/)).toBeVisible();
  expect((await appointmentsOn(date)).find((a) => a.id === target!.id)!.status).toBe("booked");

  await context.setOffline(false);
  await expect(page.getByText(/waiting to send/)).toBeHidden({ timeout: 15_000 });
  await expect
    .poll(async () => (await appointmentsOn(date)).find((a) => a.id === target!.id)!.status)
    .toBe("confirmed");
});

test("today's schedule opens from the phone's copy when there is no internet", async ({ page, context }) => {
  await signIn(page);
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== undefined);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();
  await expect(page.getByText("Offline")).toBeVisible();
  await context.setOffline(false);
});

test("Hindi interface", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "More" }).click();
  await page.getByRole("button", { name: "हिन्दी" }).click();
  await expect(page.getByRole("link", { name: "कैलेंडर" })).toBeVisible();
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("link", { name: "Calendar" })).toBeVisible();
});
