// The People surface's contract, in two nouns — a person, and the accounts
// they are reachable at:
//
//   GET    /api/people              -> PeopleList (curated people only)
//   GET    /api/people/:id          -> PersonResource
//   GET    /api/people/:id/messages -> TimelinePage
//   POST   /api/people/:id/accounts -> PersonResource | LinkConflict (409)
//   DELETE /api/people/:id/accounts/:channel/:channelUserId -> PersonResource
//   GET    /api/accounts            -> AccountDirectory
//
// The vocabulary is docs/concepts/identity.md's. Rome never mints an account:
// an account is platform-owned, named by the pair (channel, channelUserId),
// and the only identity fact Rome contributes is which person it belongs to.
// So the writes here move a link between people; none of them creates or
// destroys the account under it.
//
// The timeline's entry shape, its ordering and its cursor are the identity
// union's, and they are re-exported rather than restated. The surfaces page
// the same entries: a row's `latest` is the head of the timeline the same row
// opens, and a cursor written against one has to name a position in the
// other. A second definition of either is a page boundary the two ends
// disagree about.

import {
  compareIdentityCursors,
  encodeIdentityCursor,
  identityCursorOf,
  isChannelIdentifier,
  matchesQuery,
  normalizeBondLevel,
  parseFilterLevel,
  parseIdentityCursor,
  TIMELINE_PAGE_DEFAULT_LIMIT,
  TIMELINE_PAGE_MAX_LIMIT,
  type IdentityCursor,
  type IdentityDynamic,
  type PlacedBondLevel,
} from "./identities.js";
import { STRANGER_PERSON_ID } from "./persons.js";

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
 * The page size a `?limit=` value asks for: clamped to `max`, and `fallback`
 * for anything that does not name a positive count — absent, empty, zero,
 * negative, or not a number.
 *
 * Never zero. A limit of zero answers an empty page with no cursor, which a
 * caller cannot tell from an exhausted listing, so it would silently truncate
 * the read rather than reporting a bad request.
 */
function pageLimit(
  raw: string | number | null | undefined,
  bounds: { fallback: number; max: number },
): number {
  const requested = Number(raw);
  return Number.isFinite(requested) && requested >= 1
    ? Math.min(Math.floor(requested), bounds.max)
    : bounds.fallback;
}

/** {@link pageLimit} for one page of a timeline. */
export function timelinePageLimit(raw: string | number | null | undefined): number {
  return pageLimit(raw, {
    fallback: TIMELINE_PAGE_DEFAULT_LIMIT,
    max: TIMELINE_PAGE_MAX_LIMIT,
  });
}

/**
 * The newest thing that happened on an account: which surface it happened on,
 * when, and one line of it.
 *
 * The identity union's shape, under the name the account contract uses for it.
 * A directory row's `latest` is the head of the history that row opens, so the
 * two are one type rather than two that can disagree.
 */
export type AccountDynamic = IdentityDynamic;

/**
 * What the guardian has decided about an account.
 *
 * "unlinked" is the absence of a decision rather than one Rome writes down: an
 * account it has observed and nobody has placed. The other two are decisions —
 * a link onto a person, and a dismissal, which files the account under the
 * stranger sentinel.
 *
 * The three partition the directory, so their counts sum to it.
 */
export const ACCOUNT_STATES = ["unlinked", "linked", "dismissed"] as const;

export type AccountState = (typeof ACCOUNT_STATES)[number];

/** Parse a `?state=` value, or null when it names no state — an unknown filter
 *  is a caller's bug, and answering it as the whole directory would silently
 *  show the wrong accounts. */
export function parseAccountState(raw: string | undefined | null): AccountState | null {
  if (raw == null || raw === "") return null;
  return (ACCOUNT_STATES as readonly string[]).includes(raw) ? (raw as AccountState) : null;
}

/** How an account's link renders: its state, and the person it names. */
export interface AccountPresentation {
  state: AccountState;
  /** The person the account is linked to, or null in either other state. */
  personId: string | null;
  personName: string | null;
}

/**
 * Read a link the way every surface has to read it.
 *
 * The stranger sentinel is a row in the persons table that every dismissed
 * account is mapped onto, not someone the guardian knows. So a dismissal
 * answers a state and no person: a caller handed the sentinel's id would render
 * it as a person, open a timeline merging everyone ever dismissed, and address
 * writes at a row no write may touch.
 */
export function accountPresentation(
  link: { personId: string; displayName: string } | null | undefined,
): AccountPresentation {
  if (link == null) return { state: "unlinked", personId: null, personName: null };
  if (link.personId === STRANGER_PERSON_ID) {
    return { state: "dismissed", personId: null, personName: null };
  }
  return { state: "linked", personId: link.personId, personName: link.displayName };
}

/**
 * One account in the directory: one person on one channel, however many
 * addresses that channel reaches them at.
 *
 * `channel` and `channelUserId` are its identity — the pair a link, a dismissal
 * or a timeline read names. {@link accountRef} renders the pair as the single
 * token a key or a path segment needs.
 */
export interface DirectoryAccount {
  channel: string;
  /** The address the channel folds its other addressings of this account onto.
   *  Stable across a re-sync and across which addressing a message arrives on. */
  channelUserId: string;
  /**
   * Every address the channel can reach the account at, `channelUserId`
   * included, ordered by code point.
   *
   * A search reads these, so an omitted one is an account the guardian cannot
   * find by the phone number they know.
   */
  addresses: string[];
  /**
   * What the account's own platform calls it, then the name its sender put on a
   * message, then the address itself. Never empty, and never the linked
   * person's name — {@link personName} answers that, and a guardian renaming a
   * person does not rename the account.
   */
  displayName: string;
  state: AccountState;
  /** Never the stranger sentinel's id — see {@link accountPresentation}. */
  personId: string | null;
  personName: string | null;
  /** The newest thing on record for this account, or null when nothing is. */
  latest: AccountDynamic | null;
  /**
   * Every record the producers hold for this account — not every line a
   * timeline renders. A reaction counts, and so does a message Rome sent, so
   * this is not the length of a {@link TimelinePage} and a client that treats
   * it as one will disagree with the timeline it paged.
   */
  messageCount: number;
}

/**
 * An account with nothing on record that nobody has decided about: a synced
 * address-book contact and no more.
 *
 * Derived rather than carried, so no producer can report an account as silent
 * while its own `latest` says otherwise. A link or a dismissal is a decision
 * the guardian made about the account, and a decided account is never held
 * back — the directory's toggle hides the address book, not the guardian's own
 * work.
 */
export function isSilentAccount(account: DirectoryAccount): boolean {
  return account.latest === null && account.state === "unlinked";
}

/** How many accounts sit in each state. */
export interface AccountCounts extends Record<AccountState, number> {}

/**
 * One page of the account directory, newest activity first.
 *
 * `counts` and `silentTotal` describe the whole directory the query and the
 * silent toggle admit, never the page — so every number a client renders is the
 * server's, and no chip collapses as the client pages.
 */
export interface AccountDirectory {
  accounts: DirectoryAccount[];
  /** Opaque, and null on the last page. */
  nextCursor: string | null;
  /** Per state, over everything the query and the silent toggle admit and
   *  before `state` narrows the page — so each chip's number is the size of the
   *  listing that chip shows. */
  counts: AccountCounts;
  /** Every matching silent account, whether or not the toggle let them onto the
   *  page — the number the toggle itself offers. */
  silentTotal: number;
}

/**
 * Render an account's identity as one token, for a client's row key and for the
 * position a cursor names.
 *
 * Only the first colon is structural, so a channel carrying one would make the
 * token ambiguous. Channel names are short slugs, so refusing the separator
 * costs nothing and removes the ambiguity rather than documenting it. A caller
 * passing one has a bug that a silently collapsed row would hide until a write
 * landed on the wrong account.
 */
export function accountRef(account: { channel: string; channelUserId: string }): string {
  if (!isChannelIdentifier(account.channel)) {
    throw new Error(
      `channel must be non-empty and free of ":" — received ${JSON.stringify(account.channel)}`,
    );
  }
  if (!account.channelUserId) throw new Error("channelUserId must be non-empty");
  return `${account.channel}:${account.channelUserId}`;
}

/** What `?q=` matches: the display name, the linked person's name, and every
 *  address — so a phone number finds an account the platform named something
 *  else, and a person's name finds the accounts they were placed on. */
export function accountMatchesQuery(account: DirectoryAccount, query: string): boolean {
  return matchesQuery(query, [
    account.displayName,
    account.personName ?? "",
    account.channel,
    ...account.addresses,
  ]);
}

/**
 * Where one account sits in the directory's order: the tuple the ordering
 * reads, and nothing else. A cursor carries this rather than a ref, so resuming
 * needs a position rather than an account that still exists.
 *
 * The identity stream's position, over an account's ref — one activity order
 * and one encoding of it, so the reasons it is a tuple rather than a row id and
 * the reasons every part is escaped hold in one place
 * ({@link encodeIdentityCursor}) rather than two that can be fixed apart.
 */
export type AccountCursor = IdentityCursor;

export const compareAccountCursors = compareIdentityCursors;
export const encodeAccountCursor = encodeIdentityCursor;
export const parseAccountCursor = parseIdentityCursor;

export function accountCursorOf(account: DirectoryAccount): AccountCursor {
  return {
    timestamp: account.latest?.timestamp ?? null,
    displayName: account.displayName,
    id: accountRef(account),
  };
}

/**
 * The directory's order: newest activity first, accounts that have never done
 * anything last, ties broken by name and then ref so the sequence is total —
 * which is what lets a cursor resume it.
 */
export function compareAccounts(a: DirectoryAccount, b: DirectoryAccount): number {
  return compareAccountCursors(accountCursorOf(a), accountCursorOf(b));
}

/** Whether an account falls after a cursor in {@link compareAccounts} order —
 *  i.e. belongs on a later page than the one that cursor ended. */
export function isAfterAccountCursor(account: DirectoryAccount, cursor: AccountCursor): boolean {
  return compareAccountCursors(cursor, accountCursorOf(account)) < 0;
}

/** How many accounts one page carries when the caller names no limit, and the
 *  ceiling it is clamped to. A synced address book is thousands of rows, so the
 *  default is a screenful of them rather than all of them. */
export const ACCOUNT_PAGE_DEFAULT_LIMIT = 200;
export const ACCOUNT_PAGE_MAX_LIMIT = 500;

/** {@link pageLimit} for one page of the account directory. */
export function accountPageLimit(raw: string | number | null | undefined): number {
  return pageLimit(raw, { fallback: ACCOUNT_PAGE_DEFAULT_LIMIT, max: ACCOUNT_PAGE_MAX_LIMIT });
}

/**
 * Cut one page out of the directory, with the numbers that describe the whole
 * of it.
 *
 * Takes every account there is, in any order: the order is this function's, so
 * a producer cannot page one order while a client renders another.
 *
 * `query` scopes everything, including the counts. `state` and the cursor scope
 * the page alone, so a client filtered to one chip still reads every chip's
 * number, and a client on page four reads the same numbers it read on page one.
 *
 * A query reaches silent accounts whatever the toggle says. The toggle keeps a
 * 9,000-contact address book out of a browsing view, and a guardian typing a
 * name or a number is not browsing — a lookup that answered "no such account"
 * for a contact the mirror holds would be a worse answer than a long list.
 */
export function sliceAccountDirectory(
  directory: readonly DirectoryAccount[],
  options: {
    query?: string | null;
    state?: AccountState | null;
    cursor?: AccountCursor | null;
    limit?: number | null;
    /** Whether the page carries silent accounts. Off by default. */
    includeSilent?: boolean;
  } = {},
): AccountDirectory {
  const query = options.query?.trim() ?? "";
  const matching = query ? directory.filter((a) => accountMatchesQuery(a, query)) : directory;
  const silentTotal = matching.filter(isSilentAccount).length;

  const admitted =
    options.includeSilent || query !== "" ? matching : matching.filter((a) => !isSilentAccount(a));
  const counts: AccountCounts = { unlinked: 0, linked: 0, dismissed: 0 };
  for (const account of admitted) counts[account.state] += 1;

  // The sort key is built once per account rather than once per comparison: it
  // renders a ref and a directory is thousands of rows, so a comparator that
  // rebuilds it pays for that on every one of N log N comparisons.
  const ordered = admitted
    .map((account) => ({ account, at: accountCursorOf(account) }))
    .sort((a, b) => compareAccountCursors(a.at, b.at))
    .map((entry) => entry.account);
  const state = options.state;
  const scoped = state ? ordered.filter((a) => a.state === state) : ordered;
  const cursor = options.cursor;
  const remaining = cursor ? scoped.filter((a) => isAfterAccountCursor(a, cursor)) : scoped;

  const accounts = remaining.slice(0, accountPageLimit(options.limit));
  const last = accounts.at(-1);
  const nextCursor =
    remaining.length > accounts.length && last ? encodeAccountCursor(accountCursorOf(last)) : null;

  return { accounts, nextCursor, counts, silentTotal };
}

/**
 * One account as it appears under the person linked to it.
 *
 * `(channel, channelUserId)` is the account's identity — Rome never mints one,
 * every pair here is observed from a message or an address-book mirror — and
 * `displayName` is what the platform calls it, the raw identifier being only
 * the last resort. The directory's {@link DirectoryAccount} is the same
 * account seen from the other side, with what Rome decided about it.
 */
export interface LinkedAccount {
  channel: string;
  channelUserId: string;
  displayName: string;
}

/**
 * A person with their accounts and their activity across all of them.
 *
 * `bondLevel` is the stored value, free text included: older rows carry levels
 * outside today's ladder ("colleague"), and a reader buckets them with
 * {@link normalizeBondLevel} rather than the contract pretending they cannot
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

/**
 * `POST /api/people/:id/accounts` — the link verb, and the only way an account
 * changes hands.
 *
 * Compare-and-swap on whoever holds the account now. Linking one nobody holds
 * needs no `transferFrom`, and re-linking one this person already holds is the
 * same request answered twice — both succeed and neither disturbs the other
 * accounts. Taking an account from another person requires `transferFrom`
 * naming that person exactly; anything else answers a {@link LinkConflict}.
 *
 * The explicitness is the point. A link decides who every message that account
 * ever sent belongs to, so a transfer re-attributes a whole history and must
 * not happen as the side effect of a retry against a page that has gone stale.
 */
export interface LinkAccountRequest {
  channel: string;
  channelUserId: string;
  transferFrom?: string;
}

/**
 * The request a body carries, or null when it is not one — a channel
 * {@link accountRef} cannot name and an empty identifier name no account, and
 * an empty `transferFrom` is a caller that meant to name an owner.
 */
export function parseLinkAccountRequest(body: unknown): LinkAccountRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const { channel, channelUserId, transferFrom } = body as Record<string, unknown>;
  if (typeof channel !== "string" || !isChannelIdentifier(channel)) return null;
  if (typeof channelUserId !== "string" || channelUserId === "") return null;
  if (transferFrom === undefined) return { channel, channelUserId };
  if (typeof transferFrom !== "string" || transferFrom === "") return null;
  return { channel, channelUserId, transferFrom };
}

/**
 * Who holds an account, as this surface presents ownership.
 *
 * A dismissal is stored as a link too, onto a sentinel row no caller may see,
 * so a dismissed account has no holder here — the rule
 * {@link accountPresentation} states for the directory, where the same
 * dismissal reads as a state and no person.
 */
export interface AccountHolder {
  personId: string;
  personName: string;
}

/**
 * The 409 body a refused link answers with: the account it was about, and who
 * holds it now, so a client can render the conflict and offer the explicit
 * transfer that resolves it.
 *
 * `holder` is null when the refusal was a stale `transferFrom` against an
 * account nobody holds — the caller's view of the owner is wrong either way,
 * and the answer says which owner it actually has.
 */
export interface LinkConflict {
  error: string;
  channel: string;
  channelUserId: string;
  holder: AccountHolder | null;
}

export function linkConflict(
  account: { channel: string; channelUserId: string },
  holder: AccountHolder | null,
): LinkConflict {
  return {
    error: holder
      ? `${accountRef(account)} is linked to "${holder.personName}"`
      : `${accountRef(account)} is linked to nobody`,
    channel: account.channel,
    channelUserId: account.channelUserId,
    holder,
  };
}
