import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2 acceptance (PLAN §7): staff see WhatsApp chats and open tasks, take a chat over, reply, and
 * hand it back to the assistant. Uses the demo clinic's sample chats (pnpm seed:demo); see scripts/e2e.sh.
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

test("receptionist takes over a WhatsApp chat, replies and hands it back", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("link", { name: /tasks? needs? attention/ })).toBeVisible();

  await page.getByRole("link", { name: "WhatsApp" }).click();
  await page.getByRole("button", { name: "Needs action" }).click();
  // Only the chat with an open task is left under this filter.
  await expect(page.locator('a[href^="/inbox/"]')).toHaveCount(1);
  await page.locator('a[href^="/inbox/"]').click();
  await expect(page.getByText("Please call me back about my bill")).toBeVisible();
  await expect(page.getByText(/Call back: Patient asked for a call back/)).toBeVisible();

  await page.getByRole("button", { name: "Take over" }).click();
  await expect(page.getByText(/You are handling this chat/)).toBeVisible();

  await page.getByPlaceholder("Type a reply…").fill("Namaste, I will call you in 10 minutes.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Namaste, I will call you in 10 minutes.")).toBeVisible();
  await expect(page.getByText(/· queued/)).toBeVisible();

  await page.getByRole("button", { name: "Hand back to assistant" }).click();
  await expect(page.getByRole("button", { name: "Take over" })).toBeVisible();

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText(/Call back: Patient asked/)).toHaveCount(0);
});

test("tasks page lists open tasks", async ({ page }) => {
  await signIn(page);
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
});
