import { describe, expect, it } from "vitest";
import { effectivePermissions } from "./permissions.js";

describe("effectivePermissions", () => {
  it("owners have everything and cannot be restricted", () => {
    const p = effectivePermissions("owner", { "reports.revenue": false, "staff.manage": false });
    expect(p.has("reports.revenue")).toBe(true);
    expect(p.has("staff.manage")).toBe(true);
  });

  it("the owner can hide revenue from a receptionist", () => {
    expect(effectivePermissions("receptionist").has("reports.revenue")).toBe(true);
    expect(effectivePermissions("receptionist", { "reports.revenue": false }).has("reports.revenue")).toBe(
      false,
    );
  });

  it("staff management can never be granted to non-owners", () => {
    expect(effectivePermissions("receptionist", { "staff.manage": true }).has("staff.manage")).toBe(false);
  });

  it("assistants cannot edit patients by default but can be allowed", () => {
    expect(effectivePermissions("assistant").has("patients.write")).toBe(false);
    expect(effectivePermissions("assistant", { "patients.write": true }).has("patients.write")).toBe(true);
  });
});
