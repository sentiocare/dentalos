/** Name comparison for duplicate detection, tolerant of honorifics and spelling variation. */

const HONORIFICS = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "smt",
  "shri",
  "sri",
  "shrimati",
  "kumari",
  "km",
  "dr",
  "master",
  "baby",
  "ji",
  "sahab",
  "saheb",
]);

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !HONORIFICS.has(w))
    .join(" ");
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Trigram similarity (same idea as Postgres pg_trgm), 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const tx = trigrams(x);
  const ty = trigrams(y);
  let shared = 0;
  for (const t of tx) if (ty.has(t)) shared++;
  return shared / (tx.size + ty.size - shared);
}

/**
 * Same person? Same phone is not enough: families share one number. Names must also match closely,
 * or one must be a prefix of the other ("Ramesh" vs "Ramesh Kumar").
 */
export function isLikelySamePerson(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 4 && long.startsWith(`${short} `)) return true;
  if (sameFirstNameWithAbbreviations(short, long)) return true;
  // A shared surname makes whole names look alike ("Rajesh Kumar" / "Ramesh Kumar"), so first names
  // must also be close.
  const firstSimilar = nameSimilarity(x.split(" ")[0]!, y.split(" ")[0]!) >= 0.5;
  return firstSimilar && nameSimilarity(x, y) >= 0.55;
}

/** "kr" abbreviates "kumar": same first letter, and the letters appear in order. */
function abbreviates(token: string, full: string): boolean {
  if (token === full) return true;
  if (token[0] !== full[0]) return false;
  let i = 0;
  for (const ch of full) if (ch === token[i]) i++;
  return i === token.length;
}

/** First names match closely and every remaining word is the same or an abbreviation ("Ramesh Kr"). */
function sameFirstNameWithAbbreviations(a: string, b: string): boolean {
  const [firstA, ...restA] = a.split(" ");
  const [firstB, ...restB] = b.split(" ");
  if (!firstA || !firstB || nameSimilarity(firstA, firstB) < 0.6) return false;
  if (restA.length === 0 || restB.length === 0) return false;
  const [fewer, more] = restA.length <= restB.length ? [restA, restB] : [restB, restA];
  return fewer.every((t) => more.some((u) => abbreviates(t, u) || abbreviates(u, t)));
}
