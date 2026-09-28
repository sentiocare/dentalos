import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 3 acceptance (dashboard side): staff review the assistant's phone calls, with the transcript, and
 * record test-call results (PLAN Phase 3: 50 real test calls marked pass/fail). Uses the demo clinic's
 * sample calls (pnpm seed:demo); see scripts/e2e.sh.
 */
const RECEPTION = "reception@demo.sentio";

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Your email").fill(RECEPTION);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel(/6-digit code/).fill("123456");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL("**/today");
}

test("receptionist reviews a call transcript and marks a test call", async ({ page }) => {
  await signIn(page);
  await page.getByRole("link", { name: "More" }).click();
  await page.getByRole("link", { name: "Phone calls" }).click();
  await expect(page.getByRole("heading", { name: "Phone calls" })).toBeVisible();
  await page.getByRole("button", { name: "Emergencies" }).click();
  await expect(page.locator('a[href^="/calls/"]')).toHaveCount(1);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.locator('a[href^="/calls/"]', { hasText: "Booked" }).click();
  await expect(page.getByText("मुझे कल शाम को चेकअप के लिए आना है")).toBeVisible();
  await expect(page.getByText(/Reply time: typical 820 ms/)).toBeVisible();

  await page.getByRole("button", { name: "Pass" }).click();
  await page.getByPlaceholder(/Notes/).fill("Clear Hindi, booked correctly");
  await page.getByRole("button", { name: "Save result" }).click();
  await page.getByRole("link", { name: /Phone calls/ }).click();
  await expect(page.getByText(/Test calls: 1 passed, 0 failed \(target 50\)/)).toBeVisible();
});
