import { expect, test, type Page } from "@playwright/test";

/**
 * The reception desk (demo clinic; see scripts/e2e.sh): a walk-in gets a token, goes in to a free doctor
 * and chair, and is billed and paid in one sheet, with the receipt ready to print. At desk size.
 */
const API = process.env.E2E_API_URL ?? "http://localhost:8080";

test.use({ viewport: { width: 1366, height: 800 } });

async function signIn(page: Page, phone: string) {
  await page.goto("/login");
  await page.getByLabel("Your mobile number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  await page.getByLabel(/6-digit OTP/).fill("123456");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL("**/today");
}

test("walk-in to receipt: token, send in, done, bill, pay", async ({ page }) => {
  // A chair of its own, so the test never waits on the demo's bookings at whatever time it runs.
  const token = (
    (await (
      await fetch(`${API}/v1/dev/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: "90000 00001" }),
      })
    ).json()) as { token: string }
  ).token;
  await fetch(`${API}/v1/chairs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "Chair E2E", equipment: [] }),
  });

  await signIn(page, "90000 00002");
  await expect(
    page.getByRole("navigation", { name: "Main menu" }).getByRole("link", { name: "Leads" }),
  ).toBeVisible();
  await expect(page.getByTestId("assistant-today")).toContainText("Assistant today");

  // Search from the top bar ("/" jumps into it).
  await page.keyboard.press("/");
  await page.keyboard.type("SDC-1005");
  await expect(page.getByRole("listbox", { name: "Patients found" }).getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "+ Walk-in" }).click();
  const walkIn = page.getByRole("dialog");
  await walkIn.getByPlaceholder("Search patient by name or phone").fill("SDC-1075");
  await walkIn.locator("ul li button").first().click();
  const patient = (await walkIn.locator(".bg-brand-50 p.font-medium").textContent())!.trim();
  await walkIn.getByLabel("For").selectOption({ label: "Scaling and polishing" });
  await walkIn.getByLabel("Note (optional)").fill("Bleeding gums");
  await walkIn.getByRole("button", { name: "Give token" }).click();
  await expect(walkIn.getByTestId("token-given")).toContainText(patient);
  await walkIn.getByRole("button", { name: "Close" }).last().click();

  const waiting = page.getByTestId("col-waiting").locator("div.rounded-2xl").filter({ hasText: patient });
  await expect(waiting).toContainText("Bleeding gums");
  await waiting.getByRole("button", { name: "Send in" }).click();
  const send = page.getByRole("dialog");
  await send.getByLabel("Doctor").selectOption({ label: "Dr. Sunil Prasad" });
  await send.getByLabel("Chair").selectOption({ label: "Chair E2E" });
  await send.getByRole("button", { name: "Send in" }).click();

  const withDoctor = page
    .getByTestId("col-with-doctor")
    .locator("div.rounded-2xl")
    .filter({ hasText: patient });
  await expect(withDoctor).toContainText("Dr. Sunil Prasad");
  await withDoctor.getByRole("button", { name: "Done · bill" }).click();

  const bill = page.getByRole("dialog");
  await expect(bill.getByRole("heading", { name: "Bill & payment" })).toBeVisible();
  await expect(bill.getByLabel("Amount for Scaling and polishing")).toHaveValue("800");
  await bill.getByRole("radio", { name: "UPI" }).click();
  await bill.getByRole("button", { name: /Take payment/ }).click();
  await expect(bill.getByTestId("checkout-paid")).toContainText(/Receipt R\//);
  await expect(bill.getByRole("button", { name: "Print receipt" })).toBeVisible();
  await bill.getByRole("button", { name: "Close" }).last().click();

  await expect(
    page.getByTestId("col-finished").locator("div.rounded-2xl").filter({ hasText: patient }),
  ).toContainText("Paid ₹800");
});
