// The People page's unified identity contract: one row shape for every
// identity Rome has met — curated persons, unmapped senders still sitting in
// the sentinel log, and the mirrored address books nobody has placed yet
// (WhatsApp contacts, LinkedIn participants).
//
// The pieces live here rather than in core because three implementations have
// to agree on them at once: the `/api/identities` route that computes the
// union, the dashboard that renders and mutates it, and the dashboard's mock
// backend that stands in for the route. A row id, a level name, or a display
// name derived two different ways is a row the UI can neither regroup nor
// mutate.

/**
 * Every position on the bond ladder the page renders, in display order.
 *
 * "unknown" and "stranger" are positions on the same ladder as the curated
 * bonds, not separate kinds of thing: "unknown" is computed (an identity with
 * no person row yet — never stored), and "stranger" is the mapping onto the
 * stranger sentinel person.
 */
export const BOND_LADDER = [
  "unknown",
  "guardian",
  "inner-circle",
  "acquaintance",
  "other",
  "stranger",
] as const;

export type BondLadderLevel = (typeof BOND_LADDER)[number];

/**
 * The levels a "move" can target. Guardian is not assignable, and "unknown"
 * is not a destination — an identity becomes unknown by having no person row,
 * never by being moved there.
 */
export const MOVE_TARGET_LEVELS = ["inner-circle", "acquaintance", "other", "stranger"] as const;

export type MoveTargetLevel = (typeof MOVE_TARGET_LEVELS)[number];

/**
 * Whether this identity can be moved to "stranger".
 *
 * Dismissal re-points an identity's channel mappings onto the sentinel person,
 * so it needs at least one mapping to move. A curated person can legitimately
 * hold none — someone the guardian typed in before any channel matched them —
 * and there is no way to place such a row at Stranger, because Stranger is a
 * mapping rather than a stored level.
 *
 * A caller offers the move only where this holds. Offering it regardless and
 * letting the write fail is the shape that loses the row: the natural
 * implementation of "dismiss" merges into the sentinel, which for a
 * channel-less person contributes nothing and removes the only row they had.
 */
export function canMoveToStranger(row: Pick<IdentityRow, "channels">): boolean {
  return row.channels.length > 0;
}

/** The persistable subset of {@link MOVE_TARGET_LEVELS}: what `persons.bondLevel`
 *  accepts from a guardian action. "stranger" is excluded because dismissal is
 *  a mapping onto the sentinel person, never a stored bond level. */
export const ASSIGNABLE_BOND_LEVELS = ["inner-circle", "acquaintance", "other"] as const;

export type AssignableBondLevel = (typeof ASSIGNABLE_BOND_LEVELS)[number];

export function isAssignableBondLevel(value: unknown): value is AssignableBondLevel {
  return ASSIGNABLE_BOND_LEVELS.includes(value as AssignableBondLevel);
}

/** A level a person row can actually hold: the ladder minus its two computed
 *  positions. "unknown" is an identity with no person row and "stranger" is a
 *  link onto the sentinel, so neither is ever stored on a person. */
export type PlacedBondLevel = Exclude<BondLadderLevel, "unknown" | "stranger">;

/**
 * Bucket a stored `persons.bondLevel` onto the ladder. The column is free text
 * and older rows carry values outside today's enum (e.g. "colleague"), so
 * every reader has to agree on where those land rather than dropping the row
 * from every group.
 */
export function normalizeBondLevel(raw: string): PlacedBondLevel {
  return (BOND_LADDER as readonly string[]).includes(raw) && raw !== "unknown" && raw !== "stranger"
    ? (raw as PlacedBondLevel)
    : "other";
}

/**
 * Compare two strings by code point, returning zero only for exact equality.
 *
 * `localeCompare` answers zero for strings that are canonically equivalent but
 * distinct — "\u00e9" and "e\u0301" — and its result depends on the running
 * locale, so a server and a client can disagree on the same pair. Neither is
 * acceptable where an order has to be total and has to mean the same thing on
 * both ends of a cursor.
 */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Order two display names the same way in every runtime.
 *
 * Not `localeCompare`, even with a code-point tiebreak behind it. That fallback
 * repairs a tie but cannot repair an inversion, and collations genuinely
 * disagree about order: "\u00e4" sorts before "z" under English and after it
 * under Swedish. The mock runs in a browser and the route runs in Node, so a
 * cursor written by one and read by the other would skip or repeat rows.
 *
 * Case-folded first so "ada" and "Ada" sit together, then by code point.
 * Accented names therefore sort after unaccented ones, which is the price of an
 * order both ends agree on. It is a small price here: the stream sorts by
 * activity first, so a name only ever settles a tie between two identities
 * whose newest dynamic landed in the same second.
 */
export function compareDisplayNames(a: string, b: string): number {
  const normalizedA = a.normalize("NFC");
  const normalizedB = b.normalize("NFC");
  const byFolded = compareCodePoints(normalizedA.toLowerCase(), normalizedB.toLowerCase());
  return byFolded !== 0 ? byFolded : compareCodePoints(normalizedA, normalizedB);
}

/** One channel identity attached to a row. */
export interface IdentityChannel {
  channel: string;
  channelUserId: string;
}

/**
 * The newest thing that happened with an identity, whichever surface it
 * happened on: what the stream sorts by and what a stream row shows.
 *
 * `source` is a channel name today ("whatsapp", "telegram"); a Rome App that
 * starts producing dynamics writes its own name here and the stream renders it
 * through the same glyph lookup.
 */
export interface IdentityDynamic {
  source: string;
  /** Epoch seconds. */
  timestamp: number;
  /** One line, already trimmed to a preview; null when the dynamic carries no
   *  text (an image, a call, an app event with no body). */
  preview: string | null;
}

/**
 * One row on the People page, whichever source it came from.
 *
 * `id` is typed: `person:<personId>` for a curated person,
 * `channel:<channel>:<channelUserId>` for an identity with no person row of
 * its own (unknown senders, silent contacts, and dismissed strangers — the
 * stranger sentinel is a person row, but each dismissed identity renders as
 * its own channel-form row). The form of the id is what tells a client which
 * mutation a "move" is: a bond-level update, or a materialization.
 */
export interface IdentityRow {
  id: string;
  displayName: string;
  level: BondLadderLevel;
  /**
   * Every channel identity this row stands for, aliases included.
   *
   * One person can reach a channel under more than one identifier — a WhatsApp
   * contact is one row under both its phone jid and its `@lid` jid, a LinkedIn
   * member under both a bare member id and a profile URL naming it — and the
   * union consolidates them. All of them belong here, not just whichever the
   * store picked as representative: {@link identityMatchesQuery} searches this
   * list, so an omitted alias is a contact the guardian cannot find by the
   * phone number they know, whenever a saved name hides it.
   */
  channels: IdentityChannel[];
  /**
   * The identity's newest dynamic across every surface, or null when nothing
   * has ever happened. Also the stream's sort key.
   *
   * Always {@link latestDynamic} of this row's own timeline. A producer that
   * computes it any other way can disagree with the timeline the same row
   * pages, and a reader has no way to reconcile the two.
   */
  latest: IdentityDynamic | null;
  /**
   * Every record the producers hold for this identity, summed across its
   * channels.
   *
   * Records, not rendered entries: a WhatsApp reaction counts even though the
   * timeline does not carry it, and an exchange Rome replied to counts the
   * reply. So this is not the length of {@link TimelinePage}, and a client that
   * treats it as one will disagree with the timeline it paged.
   *
   * A group conversation contributes to neither: a timeline entry names no
   * sender, so nothing said in a room of ten people is attributable to one of
   * them, and the union leaves group threads out of every identity's history.
   */
  messageCount: number;
  /**
   * A mirrored address-book identity — a WhatsApp contact, a LinkedIn
   * participant — that has never said (or been sent) anything. Only ever true
   * on level "unknown"; the page hides these behind a toggle so a
   * 9,000-contact address book doesn't bury the four senders actually waiting.
   */
  neverMessaged: boolean;
}

/**
 * How many identities sit at each level, and how many are silent.
 *
 * Counted over everything the query matches rather than the page it returned:
 * the Unknown chip's number is the page's whole signal that someone is
 * waiting, and a count taken over the loaded rows would report none the moment
 * placed people fill the first page.
 *
 * "all" is the placed levels — the chip holds Unknown and Stranger back — so
 * it is not the sum of the others.
 */
export interface IdentityCounts extends Record<IdentityFilterLevel, number> {}

/** A level a caller can filter or count by: the ladder, plus the "all" view
 *  that means the placed levels. */
export type IdentityFilterLevel = "all" | BondLadderLevel;

/**
 * One page of the identity union, newest dynamic first.
 *
 * `nextCursor` is opaque and null on the last page. The endpoint answers in
 * pages so a 9,000-contact address book never has to arrive in one response;
 * a client that only ever reads the first page still holds a valid contract.
 *
 * `counts` and `neverMessagedTotal` describe the whole matching union, not the
 * page — every number the page shows is the server's, so nothing a client
 * renders depends on how far it has paged.
 */
export interface IdentityPage {
  identities: IdentityRow[];
  nextCursor: string | null;
  counts: IdentityCounts;
  /** Per level, every matching identity — what the directory's headings count.
   *  {@link counts} answers the chips' narrower question. */
  totals: IdentityCounts;
  /** Address-book contacts with no dynamic, held behind the directory's toggle. */
  neverMessagedTotal: number;
}

/**
 * What the filter chips count: the identities their views can show.
 *
 * Only identities with a dynamic — a contact that has never done anything is
 * not waiting on a decision, so it is not part of the number beside Unknown —
 * and never the guardian, who has no chip and no decision pending.
 */
export function countIdentities(rows: IdentityRow[]): IdentityCounts {
  const counts: IdentityCounts = {
    all: 0,
    unknown: 0,
    guardian: 0,
    "inner-circle": 0,
    acquaintance: 0,
    other: 0,
    stranger: 0,
  };
  for (const row of rows) {
    if (row.latest === null || row.level === "guardian") continue;
    counts[row.level] += 1;
    if (row.level !== "unknown" && row.level !== "stranger") counts.all += 1;
  }
  return counts;
}

/**
 * What the directory's group headings count: every identity in the group,
 * silent contacts and the guardian included.
 *
 * A roster's heading answers "how many are in here", which is a different
 * question from the chip's "how many are waiting" — the directory shows rows a
 * chip deliberately leaves out of its number.
 */
export function countIdentitiesByLevel(rows: IdentityRow[]): IdentityCounts {
  const totals: IdentityCounts = {
    all: 0,
    unknown: 0,
    guardian: 0,
    "inner-circle": 0,
    acquaintance: 0,
    other: 0,
    stranger: 0,
  };
  for (const row of rows) {
    totals[row.level] += 1;
    if (identityMatchesLevel(row, "all")) totals.all += 1;
  }
  return totals;
}

/** Whether a row belongs to a filter chip's view. "all" is the placed levels:
 *  the two unplaced ends of the ladder are both entered on purpose. */
export function identityMatchesLevel(row: IdentityRow, level: IdentityFilterLevel): boolean {
  return level === "all"
    ? row.level !== "unknown" && row.level !== "stranger"
    : row.level === level;
}

/**
 * Parse a `?level=` value against the levels a surface counts by, or null when
 * it names no view — an unknown filter is a client bug, and answering it as
 * "all" would silently show the wrong rows.
 *
 * Takes the ladder because the surfaces count by different ones: the union has
 * a chip for every position, and a listing of curated people has none for the
 * two positions no person row can hold.
 */
export function parseFilterLevel<L extends string>(
  raw: string | undefined | null,
  levels: readonly L[],
): "all" | L | null {
  if (raw == null || raw === "") return null;
  if (raw === "all") return "all";
  return (levels as readonly string[]).includes(raw) ? (raw as L) : null;
}

export function parseIdentityFilterLevel(
  raw: string | undefined | null,
): IdentityFilterLevel | null {
  return parseFilterLevel(raw, BOND_LADDER);
}

/** How many identities one page carries when the caller names no limit, and
 *  the ceiling it is clamped to. */
export const IDENTITY_PAGE_DEFAULT_LIMIT = 200;
export const IDENTITY_PAGE_MAX_LIMIT = 500;

/** One entry on a person's merged timeline, whichever surface produced it.
 *
 * Deliberately generic: `source` names the producer, `ref` is that producer's
 * own id for the entry, and `body` is the line to render. A Rome App that
 * starts contributing dynamics fills the same five fields instead of
 * extending this shape.
 *
 * `ref` must be unique across everything one `source` can put on one person's
 * timeline, not merely within the conversation it came from. A person holds
 * several channel identities, and a producer whose ids are per-conversation
 * (WhatsApp message ids are unique within a chat, not within an account) has
 * to qualify them — `<chat>:<messageId>` — before writing them here.
 * {@link compareTimelineEntries} settles ties on `(source, ref)`, so two
 * entries sharing one within the same second compare equal, serialize to the
 * same cursor, and lose one of the pair on resume. */
export interface TimelineEntry {
  source: string;
  /** Epoch seconds. */
  timestamp: number;
  body: string | null;
  direction: "inbound" | "outbound";
  ref: string;
}

/** One page of a person's timeline, newest first. `nextCursor` is opaque and
 *  null once the oldest entry has been sent. */
export interface TimelinePage {
  entries: TimelineEntry[];
  nextCursor: string | null;
}

export const TIMELINE_PAGE_DEFAULT_LIMIT = 100;
export const TIMELINE_PAGE_MAX_LIMIT = 300;

/**
 * The timeline's order: newest first, and total.
 *
 * Producers share no key but the timestamp, and timestamps collide — whole
 * seconds from two stores, and a reply Rome sent recorded against the message
 * it answers. So the order is settled past the timestamp: a reply sits above
 * the line it answers, and `source`/`ref` break what remains. Totality is not
 * cosmetic — it is what lets a cursor name a position and resume there without
 * repeating or skipping an entry.
 */
export function compareTimelineEntries(a: TimelineEntry, b: TimelineEntry): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
  if (a.direction !== b.direction) return a.direction === "outbound" ? -1 : 1;
  const bySource = compareCodePoints(a.source, b.source);
  return bySource !== 0 ? bySource : compareCodePoints(a.ref, b.ref);
}

/**
 * The dynamic a row reports as `latest`: the newest entry of that row's own
 * timeline, projected.
 *
 * One definition rather than two. A separate "newest dynamic" comparison
 * settles a same-second tie on its own terms — timestamps are whole seconds and
 * collide — so a row could preview one event while its timeline opened on
 * another, and neither would be wrong. Deriving the preview from the ordering
 * makes that disagreement unrepresentable.
 *
 * `entries` must already be in {@link compareTimelineEntries} order.
 */
export function latestDynamic(entries: readonly TimelineEntry[]): IdentityDynamic | null {
  const newest = entries[0];
  return newest
    ? { source: newest.source, timestamp: newest.timestamp, preview: newest.body }
    : null;
}

/**
 * A cursor naming the exact entry a page ended on.
 *
 * Encoded rather than a bare timestamp: the timestamp alone cannot say *which*
 * of a second's entries was the last one sent, so resuming from it drops the
 * rest of that second.
 *
 * Every part is escaped. `source` is whatever a producer calls itself and a
 * Rome App names its own, so neither it nor `ref` can be trusted to leave the
 * separator alone — an unescaped one shifts the split and resumes the page at
 * a position no entry occupies.
 */
export function timelineCursor(entry: TimelineEntry): string {
  return [entry.timestamp, entry.direction, entry.source, entry.ref]
    .map((part) => encodeURIComponent(String(part)))
    .join("|");
}

/** Decode a {@link timelineCursor}, or null when it is not one. */
export function parseTimelineCursor(raw: string | undefined | null): TimelineEntry | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length !== 4) return null;
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return null;
  }
  const [rawTimestamp, direction, source, ref] = decoded;
  const timestamp = Number(rawTimestamp);
  if (rawTimestamp === "" || !Number.isFinite(timestamp)) return null;
  if (direction !== "inbound" && direction !== "outbound") return null;
  if (!ref) return null;
  return { timestamp, direction, source, ref, body: null };
}

/** Whether an entry falls after a cursor in {@link compareTimelineEntries}
 *  order — i.e. belongs on a later page than the one that cursor ended. */
export function isAfterTimelineCursor(entry: TimelineEntry, cursor: TimelineEntry): boolean {
  return compareTimelineEntries(cursor, entry) < 0;
}

/**
 * Whether a search box's text is anywhere in what a row can be found by.
 *
 * The rule rather than the haystack: each surface knows which of its own
 * fields are searchable, and every one of them has to normalize the same way
 * or one typed string finds different rows on each.
 *
 * NFC first, the way the orderings normalize: a keyboard that composes "José"
 * should find a row that stored it decomposed, and the reverse.
 */
export function matchesQuery(query: string, haystack: readonly string[]): boolean {
  const q = query.normalize("NFC").trim().toLowerCase();
  if (!q) return true;
  return haystack.join(" ").normalize("NFC").toLowerCase().includes(q);
}

/** What `?q=` matches: the display name and every channel identifier, so a
 *  phone number or a handle finds a row the guardian named something else. */
export function identityMatchesQuery(row: IdentityRow, query: string): boolean {
  return matchesQuery(query, [
    row.displayName,
    ...row.channels.flatMap((channel) => [channel.channel, channel.channelUserId]),
  ]);
}

/**
 * Where one identity sits in the stream's order: the tuple the ordering reads,
 * and nothing else. A cursor carries this rather than a row id, so resuming
 * needs a position rather than a row that still exists.
 */
export interface IdentityCursor {
  /** The row's `latest.timestamp`, or null for an identity that has never done
   *  anything — those sort last. */
  timestamp: number | null;
  displayName: string;
  id: string;
}

/** The ordering tuple, for any row that carries one. Widened past
 *  {@link IdentityRow} so a second listing of the same rows orders through
 *  {@link compareIdentityCursors} rather than restating it. */
export function identityCursorOf(
  row: Pick<IdentityRow, "id" | "displayName" | "latest">,
): IdentityCursor {
  return { timestamp: row.latest?.timestamp ?? null, displayName: row.displayName, id: row.id };
}

/**
 * The stream's order: newest dynamic first, identities that have never done
 * anything last, ties broken by name and then id so the sequence is total —
 * which is what lets a cursor resume it.
 */
export function compareIdentityCursors(a: IdentityCursor, b: IdentityCursor): number {
  const aAt = a.timestamp;
  const bAt = b.timestamp;
  if ((aAt == null) !== (bAt == null)) return aAt == null ? 1 : -1;
  if (aAt !== bAt) return (bAt ?? 0) - (aAt ?? 0);
  const byName = compareDisplayNames(a.displayName, b.displayName);
  return byName !== 0 ? byName : compareCodePoints(a.id, b.id);
}

export function compareIdentityRows(a: IdentityRow, b: IdentityRow): number {
  return compareIdentityCursors(identityCursorOf(a), identityCursorOf(b));
}

/**
 * Encode the position a page ended at.
 *
 * The whole ordering tuple, not the last row's id: between two requests a row
 * is moved to another level, merged away, or dismissed — every one of them an
 * ordinary write on this page — and a cursor that has to find that row again
 * answers the next page empty and truncates the stream until the query is
 * restarted. A position is still a position after the row at it is gone.
 *
 * Each part is escaped, because a display name is guardian-supplied text and a
 * `channel:` id carries a jid; neither can be trusted to avoid the separator.
 */
export function encodeIdentityCursor(cursor: IdentityCursor): string {
  return [cursor.timestamp ?? "", cursor.displayName, cursor.id]
    .map((part) => encodeURIComponent(String(part)))
    .join("|");
}

/** Decode an {@link encodeIdentityCursor}, or null when it is not one. */
export function parseIdentityCursor(raw: string | undefined | null): IdentityCursor | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length !== 3) return null;
  let decoded: string[];
  try {
    decoded = parts.map(decodeURIComponent);
  } catch {
    return null;
  }
  const [rawTimestamp, displayName, id] = decoded;
  if (!id) return null;
  const timestamp = rawTimestamp === "" ? null : Number(rawTimestamp);
  if (timestamp !== null && !Number.isFinite(timestamp)) return null;
  return { timestamp, displayName, id };
}

/** Whether a row falls after a cursor in {@link compareIdentityRows} order —
 *  i.e. belongs on a later page than the one that cursor ended. */
export function isAfterIdentityCursor(row: IdentityRow, cursor: IdentityCursor): boolean {
  return compareIdentityCursors(cursor, identityCursorOf(row)) < 0;
}

/**
 * Cut one page out of a fully ordered row list, with the numbers that describe
 * the whole list.
 *
 * The counted scope is `ordered` — every row the query matched — while the
 * page is what survives `id`, `includeNeverMessaged`, `level`, and the cursor.
 * A by-id fetch therefore still answers union-wide counts: a client refreshing
 * one row after a move reads the same envelope as a client that listed, so its
 * chips do not collapse to 1 the moment it refetches a single identity.
 * Counting before filtering is what keeps every chip's number right while one
 * chip's view is on screen, and what lets the directory offer "show N silent
 * contacts" in the very view that hides them: `neverMessagedTotal` reads the
 * union, never the page.
 *
 * The cursor is a position in the order rather than a row: see
 * {@link encodeIdentityCursor}.
 */
export function sliceIdentityPage(
  ordered: IdentityRow[],
  options: {
    cursor?: IdentityCursor | null;
    limit?: number | null;
    level?: IdentityFilterLevel | null;
    /** Whether the page carries address-book contacts that have never done
     *  anything. Off by default: the directory holds them behind a toggle so a
     *  9,000-contact address book doesn't bury the senders actually waiting.
     *  Never affects the counts. */
    includeNeverMessaged?: boolean;
    /** Narrow the page to one identity, for a client refreshing a single row
     *  after it mutates. Answers about that row whatever its level or silence,
     *  and takes precedence over `level` and `includeNeverMessaged`. Scopes the
     *  page only — see the note on the counts. */
    id?: string | null;
  } = {},
): IdentityPage {
  const limit = Math.min(
    Math.max(options.limit ?? IDENTITY_PAGE_DEFAULT_LIMIT, 1),
    IDENTITY_PAGE_MAX_LIMIT,
  );
  const counts = countIdentities(ordered);
  const totals = countIdentitiesByLevel(ordered);
  const neverMessagedTotal = ordered.filter((row) => row.neverMessaged).length;
  // A by-id request answers about that row and nothing else, so it is not
  // filtered further. Making the caller pair `id` with `includeNeverMessaged`
  // and a matching `level` is a rule every implementation has to remember, and
  // forgetting it returns an empty page with correct counts — from which a
  // client refreshing a just-moved or silent row concludes it is gone.
  const scoped = options.id
    ? ordered.filter((row) => row.id === options.id)
    : ordered.filter(
        (row) =>
          (options.includeNeverMessaged || !row.neverMessaged) &&
          (!options.level || identityMatchesLevel(row, options.level)),
      );
  const remaining = options.cursor
    ? scoped.filter((row) => isAfterIdentityCursor(row, options.cursor!))
    : scoped;
  const identities = remaining.slice(0, limit);
  const last = identities.at(-1);
  const nextCursor =
    remaining.length > identities.length && last
      ? encodeIdentityCursor(identityCursorOf(last))
      : null;
  return { identities, nextCursor, counts, totals, neverMessagedTotal };
}

/** Build a `person:` identity id. Throws on an empty person id, which would
 *  mint `person:` — an id {@link parseIdentityId} refuses, so a builder would
 *  otherwise be able to produce a value its own parser rejects. */
export function personIdentityId(personId: string): string {
  if (!personId) throw new Error("personId must be non-empty");
  return `person:${personId}`;
}

/**
 * Whether a value can name a channel in an identity id.
 *
 * Only the first colon of a `channel:` id is structural, so a channel carrying
 * one would make the id ambiguous: "a:b" with user "c" and "a" with user "b:c"
 * both render `channel:a:b:c`. Channel names are short slugs, so refusing the
 * separator costs nothing and removes the ambiguity rather than documenting it.
 */
export function isChannelIdentifier(channel: string): boolean {
  return channel.length > 0 && !channel.includes(":");
}

/** Build a `channel:` identity id. Throws on a channel that cannot be encoded
 *  unambiguously — a caller passing one has a bug that a silently collapsed
 *  row would hide until a write landed on the wrong mapping. */
export function channelIdentityId(channel: string, channelUserId: string): string {
  if (!isChannelIdentifier(channel)) {
    throw new Error(
      `channel must be non-empty and free of ":" — received ${JSON.stringify(channel)}`,
    );
  }
  if (!channelUserId) throw new Error("channelUserId must be non-empty");
  return `channel:${channel}:${channelUserId}`;
}

export type ParsedIdentityId =
  | { kind: "person"; personId: string }
  | { kind: "channel"; channel: string; channelUserId: string };

/**
 * Decode a typed identity id, or null when it is neither form.
 *
 * `channelUserId` may itself contain colons (WhatsApp jids carry `:device`
 * suffixes), so only the first two separators are structural — everything
 * after the second belongs to the user id.
 */
export function parseIdentityId(id: string): ParsedIdentityId | null {
  if (id.startsWith("person:")) {
    const personId = id.slice("person:".length);
    return personId ? { kind: "person", personId } : null;
  }
  if (id.startsWith("channel:")) {
    const rest = id.slice("channel:".length);
    const sep = rest.indexOf(":");
    if (sep <= 0 || sep === rest.length - 1) return null;
    return { kind: "channel", channel: rest.slice(0, sep), channelUserId: rest.slice(sep + 1) };
  }
  return null;
}

/**
 * A phone-shaped rendering of a WhatsApp jid or raw number, or null when the
 * value has no digits to show (`@lid` and group jids carry none).
 *
 * Display-name derivation is server-side (the union endpoint answers with
 * final display names), but the mock backend and the chat dialog derive the
 * same fallback, so the formatter lives with the contract they share.
 */
export function formatWhatsAppPhone(value: string | null | undefined): string | null {
  if (!value || value.endsWith("@lid") || value.endsWith("@g.us")) return null;
  const user = value.replace(/@s\.whatsapp\.net$/, "").replace(/:.+$/, "");
  const digits = user.replace(/\D/g, "");
  if (digits.length === 0) return null;
  // A jid carries the country code, so grouping is only safe where the code is
  // unambiguous. +1 is; a bare 10-digit number is not — it is a Singapore or
  // Hong Kong number as readily as a US one, and guessing renders someone's
  // number as a country they are not in.
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return `+${digits}`;
}

/**
 * The display name for a WhatsApp identity nobody has curated: the guardian's
 * saved name, then the contact's own push name, then the verified business
 * name, then the chat's name, then the formatted phone. Callers append their
 * own last-resort label when even the phone is unrenderable.
 */
export function whatsAppDisplayName(contact: {
  jid: string;
  phoneNumber: string | null;
  name: string | null;
  notify: string | null;
  verifiedName: string | null;
  chatName: string | null;
}): string | null {
  return (
    contact.name ||
    contact.notify ||
    contact.verifiedName ||
    contact.chatName ||
    formatWhatsAppPhone(contact.phoneNumber || contact.jid)
  );
}
