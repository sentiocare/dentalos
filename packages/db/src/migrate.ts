import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

/** In the deployed image migrations live next to the bundled CLI; MIGRATIONS_DIR points there. */
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

export interface Migration {
  version: string;
  sql: string;
  checksum: string;
}

/**
 * Build Prompt §0.5: never change the schema destructively without approval. A migration containing a
 * destructive statement is refused unless its first lines carry an explicit approval header, e.g.
 *   -- destructive-approved-by: Dr. Aditya, 2026-10-12, ticket #42
 */
const DESTRUCTIVE_PATTERNS = [
  /\bdrop\s+(table|column|schema|type|view|materialized\s+view)\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b/i,
  /\balter\s+table\b[^;]*\balter\s+column\b[^;]*\btype\b/i,
  /\brename\s+(column|to)\b/i,
];
const APPROVAL_HEADER = /^--\s*destructive-approved-by:\s*\S.+$/im;

/** Removes comments and dollar-quoted bodies (functions, DO blocks): code there is not run as DDL. */
function stripNonExecuted(sql: string): string {
  return sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(\$[A-Za-z_]*\$)[\s\S]*?\1/g, "$$$$");
}

export function findDestructiveStatements(sql: string): string[] {
  const body = stripNonExecuted(sql);
  return DESTRUCTIVE_PATTERNS.filter((p) => p.test(body)).map((p) => p.source);
}

export function assertMigrationAllowed(migration: Migration): void {
  const destructive = findDestructiveStatements(migration.sql);
  if (destructive.length > 0 && !APPROVAL_HEADER.test(migration.sql)) {
    throw new Error(
      `Migration ${migration.version} contains destructive statements (${destructive.join(", ")}) ` +
        `and has no "-- destructive-approved-by:" header. Get founder approval first.`,
    );
  }
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(path.join(dir, file), "utf8");
      return {
        version: file.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies pending migrations in order, each in its own transaction, under an advisory lock so two deploys
 * cannot migrate at once. Editing a migration after it was applied is an error: add a new one instead.
 */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const migrations = await loadMigrations(dir);
  migrations.forEach(assertMigrationAllowed);

  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('dentalos_migrations'))");
    await client.query(`
      create table if not exists public.schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      "select version, checksum from public.schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const result: MigrationResult = { applied: [], alreadyApplied: [] };

    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing) {
        if (existing !== migration.checksum) {
          throw new Error(
            `Migration ${migration.version} was changed after being applied. Revert the edit and add a new migration.`,
          );
        }
        result.alreadyApplied.push(migration.version);
        continue;
      }
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query("insert into public.schema_migrations (version, checksum) values ($1, $2)", [
          migration.version,
          migration.checksum,
        ]);
        await client.query("commit");
        result.applied.push(migration.version);
      } catch (error) {
        await client.query("rollback");
        throw new Error(`Migration ${migration.version} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }
    return result;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('dentalos_migrations'))").catch(() => {});
    client.release();
  }
}
