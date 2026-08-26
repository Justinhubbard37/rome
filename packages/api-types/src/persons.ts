// How a person's display name becomes the id that keys their row, their
// channel mappings, and their profile file on disk.
//
// The derivation is part of the contract rather than an implementation detail
// of the create route: the id is guardian-visible on the People page, and any
// client that predicts one — the dashboard's mock backend today — has to
// produce the same slug the server would. Keeping it here means the repository
// and that client read one function instead of two that agree until the first
// punctuation edge case.

/**
 * The sentinel person every sender the guardian dismisses is mapped onto.
 *
 * Core seeds the row at boot and `/persons/mark-stranger` points mappings at
 * it. It is a real row in the persons table, so `/api/persons` returns it and
 * every reader has to know to leave it out of a list of people.
 */
export const STRANGER_PERSON_ID = "__STRANGER__";

/** The sentinel's display name. A separate constant that happens to equal the
 *  id — a reader that assumes they are the same value breaks the day one moves. */
export const STRANGER_PERSON_DISPLAY_NAME = "__STRANGER__";

/** Why a person row refuses a guardian's edit. */
export type ProtectedPersonReason = "guardian" | "stranger-sentinel";

/**
 * Why this person row refuses to be moved along the ladder or merged away, or
 * null when it accepts both.
 *
 * Two rows in the persons table are structure rather than people. The guardian
 * anchors the ladder. The stranger sentinel is the row every dismissal maps
 * onto, so merging it away reclassifies everyone already dismissed and leaves
 * the next dismissal nowhere to land. Stranger is a mapping rather than a
 * stored bond, which is why the sentinel has no place on the ladder to move to.
 *
 * Every write that reassigns or removes a person reads this — the route and the
 * dashboard's mock backend alike — so the two cannot disagree on which rows are
 * off limits. The caller phrases its own message from the reason.
 */
export function protectedPersonReason(person: {
  id: string;
  bondLevel: string;
}): ProtectedPersonReason | null {
  if (person.id === STRANGER_PERSON_ID) return "stranger-sentinel";
  return person.bondLevel === "guardian" ? "guardian" : null;
}

/**
 * The slug for a display name: lower-cased, spaces to hyphens, everything
 * outside `[a-z0-9-]` dropped, runs of hyphens collapsed, no leading or
 * trailing hyphen.
 *
 * Returns the empty string when nothing survives — a name written entirely in
 * a non-Latin script does, so callers need their own fallback rather than
 * assuming a usable id comes back.
 */
export function generatePersonSlug(displayName: string): string {
  return displayName
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The id to mint for `base` given the ids already taken that could collide with
 * it — `base` itself, and anything of the form `base-<n>`. Returns `base` when
 * it is free, otherwise `base-<n>`.
 *
 * The suffix numbers the person among everyone sharing the name, and `base` is
 * the first of them: the second Ada Lovelace is `ada-lovelace-2`, the third
 * `ada-lovelace-3`. So the id a guardian reads on the People page counts the
 * way they would count, and no id claims to be the first of a name that
 * already has one.
 *
 * One past the highest suffix in use, not the first free slot: reusing the id
 * of a person who has been deleted would silently re-point their old profile
 * file and any channel mapping that outlived them at whoever is created next.
 *
 * Callers may pass ids that cannot collide; they are ignored. Passing only a
 * pre-filtered set is therefore an optimization, never a correctness condition.
 */
export function nextAvailablePersonId(base: string, taken: Iterable<string>): string {
  const takenIds = [...taken];
  if (!takenIds.includes(base)) return base;

  let suffix = 2;
  for (const id of takenIds) {
    if (!id.startsWith(`${base}-`)) continue;
    const num = Number.parseInt(id.slice(base.length + 1), 10);
    if (!Number.isNaN(num) && num >= suffix) suffix = num + 1;
  }
  return `${base}-${suffix}`;
}
