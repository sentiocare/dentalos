import { expect, test, type Page } from "@playwright/test";

/**
 * The doctor's side (demo clinic; see scripts/e2e.sh): a note for the visit, a tooth on the chart, and a
 * prescription from a template, printed. Reception doesn't see doctor's notes.
 */
test.use({ viewport: { width: 1366, height: 800 } });

async function signIn(page: Page, phone: string) {
  await page.goto("/login");
  await page.getByLabel("Your mobile number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  await page.getByLabel(/6-digit OTP/).fill("123456");
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL("**/today");
}

async function openPatient(page: Page, fileNo: string) {
  await page.keyboard.press("/");
  await page.keyboard.type(fileNo);
  await page.getByRole("listbox", { name: "Patients found" }).getByRole("option").first().click();
  await page.waitForURL("**/patients/**");
}

test("the doctor writes a note, charts a tooth and prescribes from a template", async ({ page }) => {
  await signIn(page, "90000 00001");
  await openPatient(page, "SDC-1040");
  const record = page.getByTestId("clinical-record");
  await expect(page.getByRole("tab", { name: "Doctor's notes" })).toHaveAttribute("aria-selected", "true");

  await record.getByLabel("Visit").selectOption({ label: "Without a visit (e.g. phone advice)" });
  await record.getByLabel("Complaint").fill("Sensitivity to cold, upper left");
  await record.getByLabel("Diagnosis").fill("Dentine hypersensitivity");
  await record.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByText("Note saved")).toBeVisible();
  await expect(record).toContainText("Dentine hypersensitivity");

  await record.getByRole("button", { name: "Tooth 24", exact: true }).click();
  const tooth = page.getByRole("dialog");
  await tooth.getByRole("radio", { name: "Cavity" }).click();
  await tooth.getByLabel("Surfaces").fill("o");
  await tooth.getByRole("button", { name: "Save" }).click();
  await expect(record.getByRole("button", { name: "Tooth 24: Cavity" })).toBeVisible();

  await record.getByRole("button", { name: "Write prescription" }).click();
  const rx = page.getByRole("dialog");
  await rx.getByLabel("Start from").selectOption({ label: "Sensitivity" });
  await expect(rx.getByLabel("Medicine 1")).toHaveValue("Potassium nitrate toothpaste");
  await rx.getByLabel("Send to the patient on WhatsApp").uncheck();
  await rx.getByRole("button", { name: "Save prescription" }).click();
  await expect(rx.getByTestId("rx-saved")).toContainText(/Prescription RX\/\d{4}-\d{2}\/\d{4} saved/);
  await rx.getByRole("button", { name: "Close" }).last().click();
  await expect(record.getByTestId("prescriptions")).toContainText("Potassium nitrate toothpaste");
});

test("reception sees the bill and plans, not the doctor's notes", async ({ page }) => {
  await signIn(page, "90000 00002");
  await openPatient(page, "SDC-1040");
  await expect(page.getByRole("tab", { name: "Bill" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Doctor's notes" })).toHaveCount(0);
});
