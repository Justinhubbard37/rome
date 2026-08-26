// What each person has done, across every account they are linked to: the
// newest thing, and how much there is of it — the two numbers a directory row
// shows without opening the dossier.
//
// Read from the same stores as the page in timeline.ts, claimed in the order
// `assignAccounts` defines and for the reason stated there, and summarized in
// one read per store however many people are asked about.

import {
  compareTimelineEntries,
  latestDynamic,
  type IdentityDynamic,
} from "@rome/api-types/people";
import {
  assignAccounts,
  type AccountDigest,
  type TimelineAccount,
  type TimelineSource,
} from "./timeline.js";

/** A person's history at a glance. `latest` is null exactly when
 *  `messageCount` is zero — a person nobody has ever written to. */
export interface PersonActivity {
  latest: IdentityDynamic | null;
  messageCount: number;
}

/**
 * One activity per group of accounts, in the order the groups were given.
 *
 * Positional, and over every group at once: the stores are read for all of
 * them together, so a listing of curated people costs the same handful of
 * queries as a single person.
 */
export async function readPeopleActivity(
  sources: readonly TimelineSource[],
  accountsByPerson: readonly (readonly TimelineAccount[])[],
): Promise<PersonActivity[]> {
  const digests = new Map<TimelineAccount, AccountDigest>();
  for (const [source, held] of await assignAccounts(sources, accountsByPerson.flat())) {
    for (const digest of await source.digest(held)) digests.set(digest.account, digest);
  }

  return accountsByPerson.map((accounts) => {
    const held = accounts
      .map((account) => digests.get(account))
      .filter((digest) => digest !== undefined);
    return {
      // Through `latestDynamic`, over entries in the timeline's own order, so
      // a person whose two accounts last spoke in the same second previews the
      // entry their merged timeline opens on rather than whichever account the
      // fold reached first.
      latest: latestDynamic(held.map((digest) => digest.latest).sort(compareTimelineEntries)),
      messageCount: held.reduce((total, digest) => total + digest.messageCount, 0),
    };
  });
}
