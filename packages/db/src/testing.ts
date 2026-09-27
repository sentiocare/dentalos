import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPool } from "./client.js";
import { migrate } from "./migrate.js";

/**
 * Database tests run against a real Postgres (real constraints, real RLS), never a mock.
 * TEST_DATABASE_URL points at a server where we may create databases, e.g.
 *   postgres://postgres:postgres@localhost:5432/postgres
 * In CI, REQUIRE_DB_TESTS=1 turns a missing database into a failure instead of a skip.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL && process.env.REQUIRE_DB_TESTS === "1") {
  throw new Error("REQUIRE_DB_TESTS=1 but TEST_DATABASE_URL is not set");
}

export const hasTestDatabase = Boolean(TEST_DATABASE_URL);

export interface TestDatabase {
  url: string;
  pool: pg.Pool;
  drop(): Promise<void>;
}

/** Creates a fresh, fully migrated database for one test file. */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  const name = `dentalos_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), { max: 25 });
  if (options.migrate !== false) await migrate(pool);

  return {
    url: url.toString(),
    pool,
    async drop() {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await cleanup.connect();
      await cleanup.query(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    },
  };
}
