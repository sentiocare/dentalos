import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 4 (dashboard side): treatment plans on the patient page and the Incomplete treatments list with
 * rupee values. Uses the demo clinic's sample plans (pnpm seed:demo); see scripts/e2e.sh.
 */
async function signIn(page: Page, phone: string) {
  await page.goto("/login");
  await page.getByLabel("Your mobile number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  await page.getByLabel(/6-digit OTP/).fill("123456");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL("**/today");
}

test("owner sees incomplete treatments with values and opens a plan", async ({ page }) => {
  await signIn(page, "90000 00001");
  await page.goto("/treatments");
  await expect(page.getByRole("heading", { name: "Incomplete treatments" })).toBeVisible();
  const totals = page.getByTestId("treatment-totals");
  await expect(totals).toContainText("₹");
  await expect(page.getByText(/days overdue/).first()).toBeVisible();

  // Open the first patient and see the plan with its sittings and a "Book" button.
  await page.locator('a[href^="/patients/"]').first().click();
  await expect(page.getByRole("heading", { name: "Treatment plans" })).toBeVisible();
  const plan = page.getByTestId("plan").first();
  await expect(plan).toContainText(/sittings done/);
  await plan.getByRole("button", { name: /^Book:/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("a new plan can be created from a template on the patient page", async ({ page }) => {
  await signIn(page, "90000 00001");
  await page.getByRole("link", { name: "Patients" }).click();
  await page.locator('a[href^="/patients/"]').nth(2).click();
  await page.getByRole("button", { name: "+ New plan" }).click();
  await page.getByLabel("Treatment").selectOption({ label: "Root canal" });
  await page.getByLabel(/Teeth/).fill("36");
  await page.getByRole("button", { name: "Create plan" }).click();
  await expect(page.getByTestId("plan").filter({ hasText: "Root canal" }).first()).toContainText("36");
  await page
    .getByTestId("plan")
    .filter({ hasText: "Root canal" })
    .first()
    .getByRole("button", { name: "Make estimate" })
    .click();
  await expect(page.getByTestId("estimate").first()).toContainText("Not sent");
});
