/* eslint-disable no-console -- command-line tool output */
/**
 * Sentio admin: create a new clinic and invite its owner by phone number.
 *
 *   DATABASE_URL=... pnpm --filter @dentalos/api clinic:create -- --name "Sharma Dental Clinic" \
 *       --city Ranchi --owner-name "Dr. Rakesh Sharma" --owner-phone 9835012345
 *
 * The owner then opens the dashboard, signs in with that number, and the clinic appears.
 */
import { parseArgs } from "node:util";
import { createClinic } from "@dentalos/core";
import { createPool } from "@dentalos/db";

export async function createClinicCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      city: { type: "string" },
      phone: { type: "string" },
      "owner-name": { type: "string" },
      "owner-phone": { type: "string" },
    },
  });
  if (!values.name || !values["owner-name"] || !values["owner-phone"]) {
    console.error(
      'Usage: --name "Clinic name" --owner-name "Dr. Name" --owner-phone 98xxxxxxxx [--city Ranchi] [--phone clinic-phone]',
    );
    process.exit(1);
  }
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL (see docs/SETUP.md)");
  const pool = createPool(url, { max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { clinicId } = await createClinic(client, {
      name: values.name,
      city: values.city,
      phone: values.phone,
      owner: { name: values["owner-name"], phone: values["owner-phone"] },
    });
    await client.query("commit");
    console.log(`Created clinic ${values.name} (${clinicId}).`);
    console.log(`The owner can now sign in with ${values["owner-phone"]}.`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("create-clinic.ts")) {
  createClinicCommand(process.argv.slice(2)).catch((error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
