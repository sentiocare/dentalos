/* eslint-disable no-console -- command-line tool output */
/**
 * Sentio admin: give a person access to the Sentio admin panel (all clinics' billing and health).
 *
 *   DATABASE_URL=... node admin.js make-admin --email you@sentio.care [--remove]
 *
 * The person must have signed in to the dashboard once with that email.
 */
import { parseArgs } from "node:util";
import { createPool } from "@dentalos/db";

export async function makeAdminCommand(args: string[]) {
  const { values } = parseArgs({ args, options: { email: { type: "string" }, remove: { type: "boolean" } } });
  const email = values.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    console.error("Usage: --email you@example.com [--remove]");
    process.exit(1);
  }
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL (see docs/SETUP.md)");
  const pool = createPool(url, { max: 1 });
  try {
    const user = (await pool.query("select id, name from users where email = $1", [email])).rows[0];
    if (!user)
      throw new Error(
        `No one has signed in with ${email} yet. Sign in to the dashboard once, then run this again.`,
      );
    if (values.remove) {
      await pool.query("delete from platform_admins where user_id = $1", [user.id]);
      console.log(`${email} is no longer a Sentio admin.`);
    } else {
      await pool.query("insert into platform_admins (user_id) values ($1) on conflict do nothing", [user.id]);
      console.log(`${email} is now a Sentio admin. Reload the dashboard to see "Sentio admin" under More.`);
    }
  } finally {
    await pool.end();
  }
}
