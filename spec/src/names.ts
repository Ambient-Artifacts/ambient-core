// Which strings can name a wiki page. Summarizers sometimes return a description where a name
// belongs ("Nikolai (person working/testing on Mac)"), and a page named after a description is
// a duplicate in waiting. Pure functions, shared by ingest, session notes and the dedup pass.

export type EntityFolder = "people" | "orgs" | "projects" | "topics";

export const ENTITY_FOLDERS: readonly EntityFolder[] = ["people", "orgs", "projects", "topics"];

/** The most words a name has, per folder ("Maria de la Cruz", "Bergmann Logistik GmbH & Co KG"). */
export const MAX_NAME_WORDS: Record<EntityFolder, number> = { people: 4, orgs: 6, projects: 5, topics: 5 };

const PARTICLES = new Set(["von", "van", "de", "der", "den", "del", "della", "di", "da", "du", "la", "le", "zu", "ten", "ter", "al", "bin", "dos", "das", "y"]);

/** A person's name as written, or null when it reads like a description or a handle. */
export function personName(raw: string): string | null {
  const n = raw.replace(/\s+/g, " ").trim();
  if (!n || /[()[\]{}:;/\\@#0-9]/.test(n)) return null;
  const words = n.split(" ");
  if (words.length > MAX_NAME_WORDS.people) return null;
  return words.every((w) => PARTICLES.has(w.toLowerCase()) || /^\p{Lu}[\p{L}'’.-]*$/u.test(w)) ? n : null;
}

/** A name for a page in `folder`, or null when it is a sentence or a description. */
export function entityName(folder: EntityFolder, raw: string): string | null {
  if (folder === "people") return personName(raw);
  const n = raw.replace(/\s+/g, " ").trim();
  if (!n || /[()[\]{}:;]/.test(n)) return null;
  return n.split(" ").length <= MAX_NAME_WORDS[folder] ? n : null;
}

/** The words of a ref's file name: `people/anna-mueller` → ["anna", "mueller"]. */
export function refWords(ref: string): string[] {
  return (ref.split("/").slice(1).join("-")).split("-").filter(Boolean);
}

/** A ref whose file name has more words than a name in its folder can: it was made from a description. */
export function descriptiveRef(ref: string): boolean {
  const max = MAX_NAME_WORDS[ref.split("/")[0] as EntityFolder];
  return max !== undefined && refWords(ref).length > max;
}
