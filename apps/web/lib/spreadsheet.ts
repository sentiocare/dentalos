/**
 * Reads an uploaded .xlsx or .csv into rows of text keyed by the header row. Parsing happens on the phone,
 * so only the rows (not the file) are sent to the server.
 */
export async function readSpreadsheet(file: File): Promise<Record<string, string>[]> {
  const name = file.name.toLowerCase();
  let table: unknown[][];
  if (name.endsWith(".xlsx")) {
    const { readSheet } = await import("read-excel-file/browser");
    table = (await readSheet(file)) as unknown[][];
  } else {
    const Papa = (await import("papaparse")).default;
    const text = await file.text();
    table = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { skipEmptyLines: "greedy" }).data;
  }
  const [header, ...rows] = table;
  if (!header) return [];
  const headers = header.map((h, i) => (cellText(h) || `Column ${i + 1}`).trim());
  return rows
    .map((row) => Object.fromEntries(headers.map((h, i) => [h, cellText(row[i])])))
    .filter((r) => Object.values(r).some((v) => v !== ""));
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    // Excel stores times as dates on 1899-12-30/31; keep just the clock time for those.
    if (value.getUTCFullYear() < 1901) {
      return `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}`;
    }
    return value.toISOString().slice(0, 10);
  }
  return String(value).trim();
}
