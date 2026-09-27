/* eslint-disable no-console -- command-line tool output */
/**
 * Sentio admin commands, bundled as admin.js in the API image:
 *   node admin.js create-clinic --name "…" --owner-name "…" --owner-phone 98…
 *   node admin.js seed-demo [--reset]
 *   node admin.js make-admin --phone 98… [--remove]
 */
import { createClinicCommand } from "./create-clinic";
import { makeAdminCommand } from "./make-admin";
import { seedDemoCommand } from "./seed-demo";

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => Promise<unknown>> = {
  "create-clinic": createClinicCommand,
  "seed-demo": seedDemoCommand,
  "make-admin": makeAdminCommand,
};

const run = command ? commands[command] : undefined;
if (!run) {
  console.error(`Usage: node admin.js <${Object.keys(commands).join("|")}> [options]`);
  process.exit(1);
}
run(args).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
