import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 5 (dashboard side): a patient's bill at the desk, the collections and dues page with its Excel
 * export, and the owner's Sentio usage wallet. Uses the demo clinic (pnpm seed:demo); see scripts/e2e.sh.
 */
async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Your email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel(/6-digit code/).fill("123456");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL("**/today");
}

test("reception adds a charge and takes a UPI payment; the bill is settled and a receipt number given", async ({
  page,
}) => {
  await signIn(page, "reception@demo.sentio");
  await page.getByRole("link", { name: "Patients" }).click();
  await page.locator('a[href^="/patients/"]').nth(5).click();
  await expect(page.getByRole("heading", { name: "Bill and payments" })).toBeVisible();

  await page.getByRole("button", { name: "+ Add charge" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByLabel("Treatment").selectOption({ label: "Consultation" });
  await sheet.getByLabel("Amount (₹)").fill("500");
  await sheet.getByRole("button", { name: "Add charge" }).click();
  await expect(page.getByText("Charge added")).toBeVisible();
  await expect(page.getByTestId("balance")).toContainText(/Due ₹/);

  await page.getByRole("button", { name: "Take payment" }).click();
  // The amount due is filled in; pay it all by UPI.
  await page.getByRole("radio", { name: "UPI" }).click();
  await page.getByLabel("Reference (UPI or card ref.)").fill("UPI998877");
  await page.getByRole("button", { name: "Save payment" }).click();
  await expect(page.getByText(/Payment saved\. Receipt R\//)).toBeVisible();
  await expect(page.getByTestId("balance")).toHaveText(/Settled|Advance/);
  await expect(page.getByRole("button", { name: /^Receipt R\// }).first()).toBeVisible();
});

test("owner sees collections by method and who owes money, and downloads the Excel", async ({ page }) => {
  await signIn(page, "owner@demo.sentio");
  await page.getByRole("link", { name: "More" }).click();
  await page.getByRole("link", { name: "Payments & dues" }).click();
  await page.getByRole("tab", { name: "This month" }).click();
  await expect(page.getByTestId("collections")).toContainText("₹");
  await expect(page.getByTestId("dues").locator("li").first()).toContainText("₹");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Excel" }).click();
  expect((await download).suggestedFilename()).toMatch(/^payments_.*\.xlsx$/);
});

test("owner sees the Sentio usage balance and this month's usage", async ({ page }) => {
  await signIn(page, "owner@demo.sentio");
  await page.goto("/wallet");
  await expect(page.getByRole("heading", { name: "Sentio balance & billing" })).toBeVisible();
  await expect(page.getByTestId("wallet-state")).toContainText("₹");
  await expect(page.getByText("Phone call minutes")).toBeVisible();
  await expect(page.getByText(/at least 24 hours ahead/)).toBeVisible();
});
