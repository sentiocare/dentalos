/* eslint-disable no-console -- command-line tool output */
import { createPool } from "./client";
import { loadMigrations, migrate } from "./migrate";

async function main() {
  const command = process.argv[2];
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("Set DATABASE_ADMIN_URL (see docs/SETUP.md).");
    process.exit(1);
  }
  const pool = createPool(url, { max: 1 });
  try {
    if (command === "migrate") {
      const result = await migrate(pool);
      console.log(`Applied: ${result.applied.join(", ") || "nothing new"}`);
      console.log(`Already applied: ${result.alreadyApplied.length}`);
    } else if (command === "status") {
      const all = await loadMigrations();
      const { rows } = await pool
        .query<{ version: string }>("select version from public.schema_migrations")
        .catch(() => ({ rows: [] as { version: string }[] }));
      const done = new Set(rows.map((r) => r.version));
      for (const m of all) console.log(`${done.has(m.version) ? "✔ applied" : "• pending"}  ${m.version}`);
    } else {
      console.error("Usage: cli.ts migrate|status");
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
