import { expect, test, type Page } from "@playwright/test";

/** Phase 6: the front desk works leads from ads (demo clinic leads; see scripts/e2e.sh). */
async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Your email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel(/6-digit code/).fill("123456");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL("**/today");
}

test("reception sees hot leads to call first, records the call, and adds a lead from a phone enquiry", async ({
  page,
}) => {
  await signIn(page, "reception@demo.sentio");
  await page.getByRole("link", { name: "More" }).click();
  await page.getByRole("link", { name: "Leads" }).click();
  await expect(page.getByRole("heading", { name: "Leads" })).toBeVisible();
  await expect(page.getByTestId("lead-funnel")).toContainText("This month");

  // "Call now" lists hot leads with a call task.
  const list = page.getByTestId("leads");
  await expect(list).toContainText("Anjali Mishra");
  await list.getByText("Anjali Mishra").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("link", { name: /^Call / })).toHaveAttribute("href", "tel:+919811100001");
  await expect(sheet).toContainText("Braces for my son");
  await sheet.getByRole("button", { name: "Call back later" }).click();
  await sheet.getByLabel("Call back at").fill("2099-01-01T18:00");
  await sheet.getByLabel("Note (optional)").fill("In a meeting, call in the evening");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toContainText("Staff called (Call back later): In a meeting");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "+ Add lead" }).click();
  const add = page.getByRole("dialog");
  await add.getByLabel("Name").fill("Suresh Mahto");
  await add.getByLabel("Phone").fill("98111 00099");
  await add.getByLabel("Wants").selectOption({ label: "Root canal" });
  await add.getByRole("button", { name: "Add lead" }).click();
  await expect(page.getByText("Lead added. The first WhatsApp goes now.")).toBeVisible();
  await page.getByRole("tab", { name: "Open" }).click();
  await expect(page.getByTestId("leads")).toContainText("Suresh Mahto");
});
