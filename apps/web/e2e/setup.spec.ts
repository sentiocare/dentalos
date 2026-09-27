import { expect, test, type Page } from "@playwright/test";

/** Phase 6: the owner's setup checklist, test mode, call forwarding and the report. */
async function signIn(page: Page, phone: string) {
  await page.goto("/login");
  await page.getByLabel("Your mobile number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  await page.getByLabel(/6-digit OTP/).fill("123456");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL("**/today");
}

test("the owner works through setup, uses test mode, reads forwarding codes and the report", async ({
  page,
}) => {
  await signIn(page, "90000 00001");
  await page.getByTestId("setup-banner").click();
  await expect(page.getByRole("heading", { name: "Setup checklist" })).toBeVisible();

  const hours = page.getByTestId("setup-steps").getByRole("listitem").filter({ hasText: "Working hours" });
  await hours.getByRole("checkbox", { name: "Done" }).check();
  await expect(hours.getByRole("checkbox", { name: "Done" })).toBeChecked();

  await page.getByLabel("Test mode is on").check();
  await expect(page.getByLabel("Extra test numbers, separated by commas")).toBeVisible();
  await page.getByLabel("Test mode is on").uncheck();
  await expect(page.getByLabel("Extra test numbers, separated by commas")).toBeHidden();

  await expect(page.getByText("When not answered")).toBeVisible();
  await page.getByRole("tab", { name: "Landline" }).click();
  await expect(page.getByText(/customer care/)).toBeVisible();

  // A step's link opens its settings section.
  await hours.getByRole("link", { name: "Open" }).click();
  await expect(page.locator("details#hours")).toHaveAttribute("open", "");

  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByTestId("recovered")).toContainText("Rupees recovered after follow-ups");
  await page.getByRole("tab", { name: "Month" }).click();
  await expect(page.getByTestId("report-tiles")).toContainText("Patients seen");
});
