/**
 * Role-based permissions (Build Prompt §5.15). One matrix used by the API and the dashboard, so a button
 * the user cannot use is hidden and the request is refused anyway.
 */
export const PERMISSIONS = [
  "settings.manage",
  "staff.manage",
  "patients.read",
  "patients.write",
  "patients.delete",
  "patients.import",
  "appointments.read",
  "appointments.write",
  "audit.read",
  "reports.revenue",
  // Patients' bills: see the account; take payments and add charges; refunds, discounts and corrections.
  "billing.read",
  "billing.write",
  "billing.adjust",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = "owner" | "doctor" | "receptionist" | "assistant";

const ROLE_DEFAULTS: Record<Role, Permission[]> = {
  owner: [...PERMISSIONS],
  doctor: [
    "patients.read",
    "patients.write",
    "appointments.read",
    "appointments.write",
    "audit.read",
    "billing.read",
    "billing.write",
  ],
  receptionist: [
    "patients.read",
    "patients.write",
    "patients.import",
    "appointments.read",
    "appointments.write",
    "reports.revenue",
    "billing.read",
    "billing.write",
  ],
  assistant: ["patients.read", "appointments.read", "appointments.write"],
};

/** Permissions the owner may switch on or off per person. Owners always keep everything. */
export const OVERRIDABLE: Permission[] = [
  "patients.write",
  "patients.import",
  "patients.delete",
  "appointments.write",
  "audit.read",
  "reports.revenue",
  "settings.manage",
  "billing.read",
  "billing.write",
  "billing.adjust",
];

export function effectivePermissions(role: Role, overrides: Record<string, unknown> = {}): Set<Permission> {
  const set = new Set<Permission>(ROLE_DEFAULTS[role]);
  if (role === "owner") return set;
  for (const permission of OVERRIDABLE) {
    const value = overrides[permission];
    if (value === true) set.add(permission);
    if (value === false) set.delete(permission);
  }
  return set;
}

export function isRole(value: unknown): value is Role {
  return value === "owner" || value === "doctor" || value === "receptionist" || value === "assistant";
}
