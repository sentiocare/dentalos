import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAppRole, withClinic } from "./client";
import { findDestructiveStatements, loadMigrations, migrate, MIGRATIONS_DIR } from "./migrate";
import { createTestDatabase, hasTestDatabase, type TestDatabase } from "./testing";

describe("destructive migration guard (no database needed)", () => {
  it.each([
    "drop table patients;",
    "alter table patients drop column phone;",
    "truncate appointments;",
    "delete from patients where true;",
    "alter table x alter column y type text;",
    "alter table x rename column a to b;",
  ])("flags %j", (sql) => {
    expect(findDestructiveStatements(sql).length).toBeGreaterThan(0);
  });

  it("ignores destructive words inside comments and allows additive changes", () => {
    expect(findDestructiveStatements("-- we never drop table here\ncreate table a (id int);")).toEqual([]);
    expect(findDestructiveStatements("alter table a add column b int;")).toEqual([]);
  });

  it("ignores statements inside function bodies, which run later, not at migration time", () => {
    const fn = `create function f() returns void language sql as $fn$ delete from slot_holds where expires_at < now() $fn$;`;
    expect(findDestructiveStatements(fn)).toEqual([]);
    expect(findDestructiveStatements(`do $$ begin null; end $$; drop table x;`).length).toBeGreaterThan(0);
  });

  it("repository migrations are all allowed", async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    expect(migrations.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasTestDatabase)("migrations and clinic context (real Postgres)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    // A throwaway tenant table protected exactly the way every real tenant table will be.
    await db.pool.query(`
      create table public.rls_probe (id serial primary key, clinic_id uuid not null, label text);
      alter table public.rls_probe enable row level security;
      alter table public.rls_probe force row level security;
      create policy tenant on public.rls_probe using (clinic_id = app.current_clinic_id())
        with check (clinic_id = app.current_clinic_id());
      grant select, insert on public.rls_probe to app_user;
      grant usage on sequence public.rls_probe_id_seq to app_user;
    `);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("re-running migrations is a no-op", async () => {
    const again = await migrate(db.pool);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toContain("0001_foundation");
  });

  it("refuses a migration that was edited after being applied", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mig-"));
    await writeFile(path.join(dir, "0001_foundation.sql"), "select 1; -- edited");
    await expect(migrate(db.pool, dir)).rejects.toThrow(/changed after being applied/);
  });

  it("refuses unapproved destructive migrations before touching the database", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mig-"));
    await writeFile(path.join(dir, "0099_cleanup.sql"), "drop table public.service_heartbeats;");
    await expect(migrate(db.pool, dir)).rejects.toThrow(/destructive/);
    const { rows } = await db.pool.query("select to_regclass('public.service_heartbeats') as t");
    expect(rows[0].t).toBe("service_heartbeats");
  });

  it("runs as app_user with clinic context set only for the transaction", async () => {
    const clinicId = "11111111-1111-7111-8111-111111111111";
    const seen = await withClinic(db.pool, { clinicId, actor: "system" }, async (c) => {
      const { rows } = await c.query("select current_user as u, app.current_clinic_id() as clinic");
      return rows[0];
    });
    expect(seen).toEqual({ u: "app_user", clinic: clinicId });

    const { rows } = await db.pool.query("select app.current_clinic_id() as clinic");
    expect(rows[0].clinic).toBeNull();
  });

  it("row-level security isolates clinics", async () => {
    const clinicA = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
    const clinicB = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
    await withClinic(db.pool, { clinicId: clinicA, actor: "system" }, (c) =>
      c.query("insert into rls_probe (clinic_id, label) values ($1, 'A secret')", [clinicA]),
    );
    const fromB = await withClinic(db.pool, { clinicId: clinicB, actor: "system" }, async (c) => {
      const { rows } = await c.query("select label from rls_probe");
      return rows;
    });
    expect(fromB).toEqual([]);

    await expect(
      withClinic(db.pool, { clinicId: clinicB, actor: "system" }, (c) =>
        c.query("insert into rls_probe (clinic_id, label) values ($1, 'spoof')", [clinicA]),
      ),
    ).rejects.toThrow(/row-level security/);

    const noContext = await withAppRole(
      db.pool,
      async (c) => (await c.query("select * from rls_probe")).rows,
    );
    expect(noContext).toEqual([]);
  });

  it("append-only trigger blocks updates and deletes", async () => {
    await db.pool.query(`
      create table public.append_probe (id int primary key, v text);
      create trigger no_mutation before update or delete on public.append_probe
        for each row execute function app.forbid_mutation();
      insert into public.append_probe values (1, 'x');
    `);
    await expect(db.pool.query("update public.append_probe set v = 'y'")).rejects.toThrow(/append-only/);
    await expect(db.pool.query("delete from public.append_probe")).rejects.toThrow(/append-only/);
  });

  it("parses bigint money as a number", async () => {
    const { rows } = await db.pool.query("select 1234567890123::bigint as paise");
    expect(rows[0].paise).toBe(1234567890123);
  });
});
