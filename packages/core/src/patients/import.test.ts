import { describe, expect, it } from "vitest";
import { buildPatientImportPreview, guessMapping, normalizePatientRow, parseIndianDate } from "./import";
import { isLikelySamePerson } from "./names";

const TODAY = "2026-09-27";

describe("guessMapping", () => {
  it("recognises common English and Hindi headers", () => {
    expect(guessMapping(["S.No", "Patient Name", "Mobile No.", "Umar", "Sex", "Address", "OPD No"])).toEqual({
      name: "Patient Name",
      phone: "Mobile No.",
      age: "Umar",
      gender: "Sex",
      address: "Address",
      fileNumber: "OPD No",
    });
    expect(guessMapping(["नाम", "मोबाइल", "उम्र"])).toEqual({ name: "नाम", phone: "मोबाइल", age: "उम्र" });
  });
});

describe("parseIndianDate", () => {
  it.each([
    ["14/10/1980", "1980-10-14"],
    ["14-10-80", "1980-10-14"],
    ["1-2-2001", "2001-02-01"],
    ["2001-02-01", "2001-02-01"],
    ["29/02/2024", "2024-02-29"],
    ["36526", "2000-01-01"],
  ])("%s → %s", (input, expected) => {
    expect(parseIndianDate(input, TODAY)).toBe(expected);
  });

  it.each(["31/02/2020", "13/13/2020", "tomorrow", "01/01/2030"])("rejects %s", (input) => {
    expect(parseIndianDate(input, TODAY)).toBeNull();
  });
});

describe("normalizePatientRow", () => {
  const mapping = { name: "Name", phone: "Phone", age: "Age", gender: "Gender", dob: "DOB" } as const;

  it("normalises a typical register row", () => {
    const { value, issues } = normalizePatientRow(
      { Name: "  Smt.  Sunita   Devi ", Phone: "098765-43210 / 91234 56789", Age: "45 yrs", Gender: "F" },
      mapping,
      TODAY,
    );
    expect(issues).toEqual([]);
    expect(value).toMatchObject({
      name: "Smt. Sunita Devi",
      phone: "+919876543210",
      altPhone: "+919123456789",
      approxBirthYear: 1981,
      gender: "female",
    });
  });

  it("reports problems without losing the row", () => {
    expect(normalizePatientRow({ Name: "Ravi", Phone: "12345" }, mapping, TODAY).issues).toEqual([
      "invalid_phone",
    ]);
    expect(normalizePatientRow({ Name: "Ravi", DOB: "31/02/1990" }, mapping, TODAY).issues).toEqual([
      "invalid_dob",
      "no_phone",
    ]);
    expect(normalizePatientRow({ Phone: "9876543210" }, mapping, TODAY)).toEqual({
      value: null,
      issues: ["missing_name"],
    });
  });
});

describe("isLikelySamePerson", () => {
  it.each([
    ["Ramesh Kumar", "ramesh kumar"],
    ["Mr. Ramesh Kumar", "Ramesh Kumar Ji"],
    ["Ramesh", "Ramesh Kumar"],
    ["Sunita Devi", "Sunitha Devi"],
    ["Ramesh Kr", "Ramesh Kumar"],
    ["Pooja Kri", "Pooja Kumari"],
  ])("%s ≈ %s", (a, b) => expect(isLikelySamePerson(a, b)).toBe(true));

  it.each([
    ["Ramesh Kumar", "Suresh Kumar"],
    ["Sunita Devi", "Anita Devi"],
    ["Aarav", "Ananya"],
    ["Rajesh Kumar", "Ramesh Kumar"],
  ])("%s ≠ %s (family sharing a phone)", (a, b) => expect(isLikelySamePerson(a, b)).toBe(false));
});

describe("buildPatientImportPreview", () => {
  it("merges with existing patients, skips repeats in the file, keeps family members sharing a phone", () => {
    const rows = [
      { Name: "Ramesh Kumar", Phone: "9876543210" },
      { Name: "Sunita Devi", Phone: "9876543210" }, // wife, same phone
      { Name: "Ramesh Kr", Phone: "+91 98765 43210" }, // same person again
      { Name: "Old Patient", Phone: "9811112222" },
      { Name: "", Phone: "9999999999" },
      { Name: "No Phone Person" },
      { Name: "No Phone Person" },
    ];
    const preview = buildPatientImportPreview(
      rows,
      { name: "Name", phone: "Phone" },
      [{ id: "p-1", name: "Old Patient", phone: "+919811112222", altPhone: null }],
      TODAY,
    );
    expect(preview.map((p) => p.action)).toEqual([
      "create",
      "create",
      "skip",
      "merge",
      "skip",
      "create",
      "skip",
    ]);
    expect(preview[2]!.duplicateOfRow).toBe(1);
    expect(preview[3]!.duplicateOf).toEqual({ id: "p-1", name: "Old Patient" });
    expect(preview[4]!.issues).toEqual(["missing_name"]);
  });

  it("handles 5,000 rows quickly", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      Name: `Patient ${i % 4500}`,
      Phone: `98${String(10_000_000 + (i % 4500)).padStart(8, "0")}`,
    }));
    const started = performance.now();
    const preview = buildPatientImportPreview(rows, { name: "Name", phone: "Phone" }, [], TODAY);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(preview.filter((p) => p.action === "create")).toHaveLength(4500);
    expect(preview.filter((p) => p.action === "skip")).toHaveLength(500);
  });
});
