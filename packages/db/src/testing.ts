import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPool } from "./client";
import { migrate } from "./migrate";

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
export async function createTestDatabase(
  options: {
    migrate?: boolean;
    /** Connections for this test file. Keep small (all test files run at once against one Postgres);
     *  only tests of simultaneous requests need more. */
    max?: number;
  } = {},
): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  const name = `dentalos_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), { max: options.max ?? 6 });
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

export interface SeededClinic {
  clinicId: string;
  branchId: string;
  doctorIds: string[];
  chairIds: string[];
  procedureId: string;
  patientIds: string[];
}

/**
 * Minimal clinic for database tests: 2 doctors, 2 chairs, one 30-minute procedure, 2 patients.
 * Inserted with the pool's privileged role (fixtures bypass RLS on purpose).
 */
export async function seedMinimalClinic(pool: pg.Pool, name = "Test Dental"): Promise<SeededClinic> {
  const one = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0].id as string;
  const clinicId = await one("insert into clinics (name) values ($1) returning id", [name]);
  const branchId = await one(
    "insert into branches (clinic_id, name, is_default) values ($1, 'Main', true) returning id",
    [clinicId],
  );
  const doctorIds = [
    await one("insert into doctors (clinic_id, name) values ($1, 'Dr. Sharma') returning id", [clinicId]),
    await one("insert into doctors (clinic_id, name) values ($1, 'Dr. Verma') returning id", [clinicId]),
  ];
  const chairIds = [
    await one("insert into chairs (clinic_id, branch_id, name) values ($1, $2, 'Chair 1') returning id", [
      clinicId,
      branchId,
    ]),
    await one("insert into chairs (clinic_id, branch_id, name) values ($1, $2, 'Chair 2') returning id", [
      clinicId,
      branchId,
    ]),
  ];
  const procedureId = await one(
    `insert into procedure_types (clinic_id, code, name, default_duration_min, buffer_after_min)
     values ($1, 'scaling', 'Scaling', 30, 5) returning id`,
    [clinicId],
  );
  const patientIds = [
    await one(
      "insert into patients (clinic_id, name, phone) values ($1, 'Ramesh Kumar', '+919876543210') returning id",
      [clinicId],
    ),
    await one(
      "insert into patients (clinic_id, name, phone) values ($1, 'Sunita Devi', '+919812345678') returning id",
      [clinicId],
    ),
  ];
  return { clinicId, branchId, doctorIds, chairIds, procedureId, patientIds };
}
