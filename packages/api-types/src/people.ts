// The People surface's contract, in two nouns — a person, and the accounts
// they are reachable at:
//
//   GET /api/people           -> PeopleList (curated people only)
//   GET /api/people/:id       -> PersonResource
//   GET /api/people/:id/messages -> TimelinePage
//
// The vocabulary is docs/concepts/identity.md's. Rome never mints an account:
// an account is platform-owned, named by the pair (channel, channelUserId),
// and the only identity fact Rome contributes is which person it belongs to.
//
// The timeline's entry shape, ordering and cursor are the identity union's,
// and they are re-exported rather than restated. The two surfaces page the
// same entries: a person row's `latest` is the head of the timeline the same
// row opens, and a cursor written against one has to name a position in the
// other. A second definition of either is a page boundary the two ends
// disagree about.

import {
  compareIdentityCursors,
  identityCursorOf,
  matchesQuery,
  normalizeBondLevel,
  parseFilterLevel,
  TIMELINE_PAGE_DEFAULT_LIMIT,
  TIMELINE_PAGE_MAX_LIMIT,
  type IdentityDynamic,
  type PlacedBondLevel,
} from "./identities.js";

export {
  compareTimelineEntries,
  isAfterTimelineCursor,
  latestDynamic,
  parseTimelineCursor,
  timelineCursor,
  TIMELINE_PAGE_DEFAULT_LIMIT,
  TIMELINE_PAGE_MAX_LIMIT,
  // Which level a stored `persons.bondLevel` counts and filters under. The
  // column is free text — older rows carry levels off today's ladder — so
  // every reader has to bucket them the same way.
  normalizeBondLevel,
  type IdentityDynamic,
  type TimelineEntry,
  type TimelinePage,
} from "./identities.js";

/**
 * The page size a `?limit=` value asks for: clamped to
 * {@link TIMELINE_PAGE_MAX_LIMIT}, and the default for anything that does not
 * name a positive count — absent, empty, zero, negative, or not a number.
 *
 * Never zero. A limit of zero answers an empty page with no cursor, which a
 * caller cannot tell from an exhausted timeline, so it would silently truncate
 * the history rather than reporting a bad request.
 */
export function timelinePageLimit(raw: string | number | null | undefined): number {
  const requested = Number(raw);
  return Number.isFinite(requested) && requested >= 1
    ? Math.min(Math.floor(requested), TIMELINE_PAGE_MAX_LIMIT)
    : TIMELINE_PAGE_DEFAULT_LIMIT;
}

/** An account's identity: the pair that names it on its platform. Rome never
 *  mints one — every ref is observed from a message or an address-book mirror. */
export interface AccountRef {
  channel: string;
  channelUserId: string;
}

/** One account as it appears under the person linked to it. `displayName` is
 *  platform-supplied — each provider's directory answers what its platform
 *  calls the account, and the raw identifier is only the last resort. */
export interface LinkedAccount extends AccountRef {
  displayName: string;
}

/**
 * A person with their accounts and their activity across all of them.
 *
 * `bondLevel` is the stored value, free text included: older rows carry levels
 * outside today's ladder ("colleague"), and a reader buckets them with
 * {@link personBondLevel} rather than the contract pretending they cannot
 * exist.
 *
 * `latest` and `messageCount` describe one history — the merged timeline
 * `GET /api/people/:id/messages` pages. `latest` is {@link latestDynamic} of
 * it and `messageCount` is how many entries it holds, so the line a row
 * previews is the line its dossier opens on, and the number beside it counts
 * what the dossier will show. A group conversation contributes to neither: a
 * timeline entry names no sender, so nothing said in a room of ten people is
 * attributable to one of them.
 */
export interface PersonResource {
  id: string;
  displayName: string;
  bondLevel: string;
  accounts: LinkedAccount[];
  messageCount: number;
  latest: IdentityDynamic | null;
}

/**
 * `GET /api/people` — every curated person, and the numbers its filter chips
 * show.
 *
 * Unpaged, unlike the account directory: curated people are entered one at a
 * time by a guardian, so the listing is bounded by hand. The account directory
 * is a mirrored address book of thousands and pages.
 *
 * The stranger sentinel never appears. It is a row in the persons table that
 * dismissed accounts are linked to — structure, not someone the guardian knows
 * — and `GET /api/people/:id` answers 404 for its id.
 */
export interface PeopleList {
  people: PersonResource[];
  counts: PersonCounts;
}

/** The bond levels a curated person can be counted under, in display order —
 *  every level {@link normalizeBondLevel} can answer, which is the ladder
 *  minus the two positions no person row holds. */
export const PERSON_BOND_LEVELS: readonly PlacedBondLevel[] = [
  "guardian",
  "inner-circle",
  "acquaintance",
  "other",
];

export type PersonBondLevel = PlacedBondLevel;

/** A level the listing can be filtered and counted by: a bond level, or "all"
 *  — every curated person whatever their level. */
export type PersonFilterLevel = "all" | PersonBondLevel;

/**
 * How many people sit at each level.
 *
 * Counted over everything `?q=` matches rather than the rows `?level=`
 * returned: the chips are how a client moves between the levels, so a count
 * taken over the returned rows would report zero for every chip but the one
 * already selected, and the guardian could never leave it.
 *
 * "all" is the sum of the others — every level here is one a person is
 * actually placed at.
 */
export interface PersonCounts extends Record<PersonFilterLevel, number> {}

/** Whether a person belongs to a chip's view. */
export function personMatchesLevel(person: PersonResource, level: PersonFilterLevel): boolean {
  return level === "all" || normalizeBondLevel(person.bondLevel) === level;
}

export function parsePersonFilterLevel(raw: string | undefined | null): PersonFilterLevel | null {
  return parseFilterLevel(raw, PERSON_BOND_LEVELS);
}

export function countPeople(people: readonly PersonResource[]): PersonCounts {
  const counts: PersonCounts = {
    all: 0,
    guardian: 0,
    "inner-circle": 0,
    acquaintance: 0,
    other: 0,
  };
  for (const person of people) {
    counts[normalizeBondLevel(person.bondLevel)] += 1;
    counts.all += 1;
  }
  return counts;
}

/**
 * What `?q=` matches: the person's own name, and every account they hold —
 * both what the platform calls it and the identifier itself.
 *
 * The identifiers are in the haystack because a guardian searches with what
 * they have: a phone number they were given, a member id pasted from a profile
 * URL. A saved name would otherwise hide the account they are looking for.
 */
export function personMatchesQuery(person: PersonResource, query: string): boolean {
  return matchesQuery(query, [
    person.displayName,
    ...person.accounts.flatMap((account) => [
      account.displayName,
      account.channel,
      account.channelUserId,
    ]),
  ]);
}

/**
 * The listing's order: newest activity first, people who have never said
 * anything last, ties broken by name and then id.
 *
 * The identity stream's order, not a second one that happens to agree — the
 * two surfaces list the same rows, so an order defined twice is two answers to
 * "who is at the top" and, once this listing takes a cursor, a row skipped or
 * repeated at every page boundary.
 */
export function comparePeople(a: PersonResource, b: PersonResource): number {
  return compareIdentityCursors(identityCursorOf(a), identityCursorOf(b));
}
