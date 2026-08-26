// A person's history, merged across every account they are linked to. The
// entry shape, the ordering and the cursor are the contract's
// (@rome/api-types/people); this module is the seam the stores plug into and
// the merge above it.

import {
  compareTimelineEntries,
  isAfterTimelineCursor,
  timelineCursor,
  type TimelineEntry,
  type TimelinePage,
} from "@rome/api-types/people";

/**
 * One account a person is reachable at, as a timeline read addresses it.
 *
 * `addresses` is every identifier the channel folds onto that account — a
 * WhatsApp contact is reachable under both a phone JID and a `@lid` JID, and
 * history hangs off either. A store that reads only the identifier the person
 * mapping happens to name would answer an empty timeline for a conversation
 * that plainly exists.
 */
export interface TimelineAccount {
  channel: string;
  /** Non-empty. Order carries no meaning. */
  addresses: string[];
}

export interface TimelineRead {
  /** Only accounts this source holds — see {@link TimelineSource.holds}. */
  accounts: readonly TimelineAccount[];
  cursor: TimelineEntry | null;
  limit: number;
}

/** One account's history as a store summarizes it — see
 *  {@link TimelineSource.digest}. */
export interface AccountDigest {
  /** The element of the `accounts` the store was given, not a copy of it. */
  account: TimelineAccount;
  /** The newest entry, first in {@link compareTimelineEntries} order. */
  latest: TimelineEntry;
  /** Every entry the store holds for the account. */
  messageCount: number;
}

/**
 * One message store, as a person's timeline reads it.
 *
 * Adding a store is one implementation of this interface listed alongside the
 * others; nothing above here knows how many there are or what they read.
 *
 * The store answers which accounts it holds as well as what it holds for them,
 * because the stores overlap rather than partition. One inbound WhatsApp
 * message is a `wa_messages` row, a `rome_agent_messages` row on the channel
 * session, and — when the sentinel triaged it — a `sentinel_log` row as well.
 * Merging all three renders one message three times, and the copies carry
 * different ids at different timestamps, so no after-the-fact dedupe survives
 * a page boundary. Instead each account's timeline comes from exactly one
 * store: the stores are asked in order, and the first one that holds an
 * account owns it — for the page ({@link holds}, then {@link read}) and for
 * the summary ({@link digest}) alike.
 */
export interface TimelineSource {
  /** Stable, for tests and logs. Never {@link TimelineEntry.source}, which
   *  names the channel an entry arrived on — one store serves several. */
  readonly name: string;

  /** Which of `accounts` this store holds any entry for. Order and identity of
   *  the returned accounts are the caller's own; a store returns the elements
   *  it was given. */
  holds(accounts: readonly TimelineAccount[]): Promise<TimelineAccount[]>;

  /**
   * The same timeline {@link read} pages, summarized: the newest entry of each
   * account, and how many entries it has in all.
   *
   * One read for a whole listing rather than one per person, and the newest
   * entry is picked under {@link read}'s own ordering — so a directory row
   * previews exactly the entry its dossier opens on, and its count is the
   * length of exactly the history the dossier pages.
   *
   * Asked only about accounts {@link holds} has already given this store, so
   * an account it holds nothing for is a person with no history rather than
   * one whose history the next store down should have answered for.
   */
  digest(accounts: readonly TimelineAccount[]): Promise<AccountDigest[]>;

  /**
   * This store's newest entries for `accounts`, at most `limit` of them, every
   * one strictly after `cursor`, in {@link compareTimelineEntries} order.
   *
   * "Strictly after `cursor`" is the store's own obligation and not the
   * merge's: a store that answered its newest `limit` entries and left the
   * filtering above it would spend that budget on entries the caller has
   * already seen, and the entries it dropped to make room are the ones no page
   * ever shows.
   */
  read(request: TimelineRead): Promise<TimelineEntry[]>;
}

/**
 * One page of `accounts`' merged history, newest first, resuming after
 * `cursor`.
 *
 * `nextCursor` is null only when the whole remaining history fit. Filter
 * `accounts` before calling to narrow the page to one channel — every entry a
 * store produces belongs to the account it was read for, so the accounts are
 * the only scope there is.
 */
export async function readPersonTimeline(
  sources: readonly TimelineSource[],
  accounts: readonly TimelineAccount[],
  options: { cursor?: TimelineEntry | null; limit: number },
): Promise<TimelinePage> {
  const cursor = options.cursor ?? null;
  const limit = Math.max(1, Math.floor(options.limit));

  const pages = await Promise.all(
    // One extra entry per store, which is what makes `nextCursor` honest: a
    // page of exactly `limit` merged entries is otherwise indistinguishable
    // from an exhausted history, and answering null there truncates the
    // timeline at a boundary the client cannot resume past.
    (await assignAccounts(sources, accounts)).map(([source, held]) =>
      source.read({ accounts: held, cursor, limit: limit + 1 }),
    ),
  );

  // Every store answered its own newest `limit + 1`, so any of the merged
  // newest `limit` that a store could contribute is among the entries it sent.
  const merged = pages
    .flat()
    .filter((entry) => cursor === null || isAfterTimelineCursor(entry, cursor))
    .sort(compareTimelineEntries);
  const entries = merged.slice(0, limit);
  const oldest = entries.at(-1);
  return {
    entries,
    nextCursor: merged.length > entries.length && oldest ? timelineCursor(oldest) : null,
  };
}

/**
 * Each store paired with the accounts it owns: the first store that holds an
 * account takes it, and no later store is offered it.
 *
 * The one place that rule is applied. Every read of a person's history — the
 * page here, the summary in activity.ts — goes through this, because a summary
 * that claimed accounts on its own terms could count an exchange the page
 * attributes to a different store.
 */
export async function assignAccounts(
  sources: readonly TimelineSource[],
  accounts: readonly TimelineAccount[],
): Promise<Array<[TimelineSource, TimelineAccount[]]>> {
  const assigned: Array<[TimelineSource, TimelineAccount[]]> = [];
  let unclaimed = [...accounts];
  for (const source of sources) {
    if (unclaimed.length === 0) break;
    const held = new Set(await source.holds(unclaimed));
    const taken = unclaimed.filter((account) => held.has(account));
    if (taken.length > 0) assigned.push([source, taken]);
    unclaimed = unclaimed.filter((account) => !held.has(account));
  }
  return assigned;
}
