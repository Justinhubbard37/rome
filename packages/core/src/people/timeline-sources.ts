// One adapter per message store a person's history can come from, and the
// order they claim an account in. The seam and the merge are in timeline.ts;
// the SQL plumbing every adapter here shares is in timeline-sql.ts.
//
// Direct threads only. Each adapter scopes itself by the account's own
// addresses, so a group conversation — addressed by the group rather than by
// the person — never reaches a person's timeline.

import { sql } from "drizzle-orm";
import type { TalkAccounts } from "../channels/accounts.js";
import type { DrizzleDb } from "../db/index.js";
import type { MessagePart } from "../types.js";
import type { TimelineAccount, TimelineSource } from "./timeline.js";
import { accountPairs, addressesOn, inList, sqlTimelineSource } from "./timeline-sql.js";

/**
 * The stores a person's timeline is read from, in the order they claim an
 * account.
 *
 * The order is the precedence the seam's {@link TimelineSource} contract
 * describes: a channel mirror holds the conversation as the channel has it, so
 * it outranks Rome's own transcript of the same messages, which in turn
 * outranks the sentinel's triage record. An account only the sentinel saw still
 * gets its exchanges — the sentinel is last, not excluded.
 *
 * The cost of that precedence: an account with a mirrored conversation shows
 * the conversation, and the sentinel's own record of an exchange inside it
 * stays behind Rome's reply as the channel delivered it.
 */
export function personTimelineSources(deps: { db: DrizzleDb }): TimelineSource[] {
  return [
    whatsAppMirrorSource(deps.db),
    linkedInMirrorSource(deps.db),
    agentMessagesSource(deps.db),
    sentinelLogSource(deps.db),
  ];
}

/** `wa_messages`, the WhatsApp thread as the mirror holds it. */
export function whatsAppMirrorSource(db: DrizzleDb): TimelineSource {
  return sqlTimelineSource({
    name: "wa_messages",
    db,
    view(accounts) {
      const chats = inList(sql`m.chat_jid`, addressesOn(accounts, "whatsapp"));
      if (chats === null) return null;
      return sql`
        SELECT
          'whatsapp' AS source,
          m.chat_jid AS address,
          m.timestamp AS at,
          CASE WHEN m.from_me THEN 1 ELSE 0 END AS outbound,
          m.chat_jid || ':' || m.id AS ref,
          m.text AS body
        FROM wa_messages m
        WHERE ${chats}
          AND m.chat_jid NOT LIKE '%@g.us'
          -- A reaction answers a line rather than being one, and the identity
          -- union already leaves it out of what an identity last did. Carrying
          -- it here would let a row preview one event and open on another.
          AND coalesce(m.type, '') <> 'reaction'`;
    },
  });
}

/** `linkedin_messages`, restricted to threads that are a conversation between
 *  two people. */
export function linkedInMirrorSource(db: DrizzleDb): TimelineSource {
  return sqlTimelineSource({
    name: "linkedin_messages",
    db,
    view(accounts) {
      const memberIds = addressesOn(accounts, "linkedin");
      const members = inList(sql`tp.participant_id`, memberIds);
      const alsoOnThread = inList(sql`a.participant_id`, memberIds);
      if (members === null || alsoOnThread === null) return null;
      return sql`
        SELECT
          'linkedin' AS source,
          -- The thread's member the caller asked about. A thread reaches this
          -- view because one of them is on it, so the subquery always finds
          -- one; min() settles the case where the person holds two member ids
          -- and both are, which would otherwise be one message twice.
          (SELECT min(a.participant_id)
             FROM linkedin_thread_participants a
             WHERE a.thread_id = m.thread_id
               AND ${alsoOnThread}
          ) AS address,
          coalesce(m.sent_at, m.created_at) AS at,
          CASE WHEN m.sender_is_self THEN 1 ELSE 0 END AS outbound,
          m.thread_id || ':' || m.message_id AS ref,
          m.text AS body
        FROM linkedin_messages m
        JOIN linkedin_threads t ON t.thread_id = m.thread_id
        WHERE m.thread_id IN (
            SELECT tp.thread_id FROM linkedin_thread_participants tp WHERE ${members}
          )
          -- LinkedIn's own flag is null until a thread has been snapshotted, so
          -- the membership decides the threads it has not answered for yet.
          AND coalesce(t.is_group, 0) = 0
          AND (
            SELECT count(*) FROM linkedin_thread_participants x WHERE x.thread_id = m.thread_id
          ) <= 2`;
    },
  });
}

/**
 * `rome_agent_messages` on a channel session — what Rome was told and what it
 * said back, for every channel with no mirror of its own.
 *
 * Reached through the session's channel address: a channel session is keyed by
 * the thread it belongs to, so a session addressed by the account is that
 * account's direct conversation, and a group's session is addressed by the
 * group and never matches.
 */
export function agentMessagesSource(db: DrizzleDb): TimelineSource {
  return sqlTimelineSource({
    name: "rome_agent_messages",
    db,
    view(accounts) {
      const addressed = accountPairs(accounts, sql`s.source_channel`, sql`s.source_thread_id`);
      if (addressed === null) return null;
      return sql`
        SELECT
          s.source_channel AS source,
          s.source_thread_id AS address,
          m.created_at AS at,
          CASE WHEN m.role = 'assistant' THEN 1 ELSE 0 END AS outbound,
          'agent:' || m.id AS ref,
          m.content AS body
        FROM rome_agent_messages m
        JOIN rome_sessions s ON s.id = m.session_id
        WHERE s.type = 'channel'
          AND ${addressed}
          -- 'notification' is an inbound message that did not wake the agent;
          -- it is still something the person said. 'trace' is the turn's
          -- machinery and belongs to no conversation.
          AND m.role IN ('user', 'assistant', 'notification')`;
    },
    body: messageContentText,
  });
}

/**
 * `sentinel_log` — the triage record, and the only place an exchange the
 * sentinel handled alone is written down.
 *
 * One row is two entries: what the sender said, and what Rome answered.
 */
export function sentinelLogSource(db: DrizzleDb): TimelineSource {
  return sqlTimelineSource({
    name: "sentinel_log",
    db,
    view(accounts) {
      const addressed = accountPairs(accounts, sql`l.channel`, sql`l.channel_user_id`);
      if (addressed === null) return null;
      // A log row names its sender but not whether they were alone. The
      // session that recorded the same thread does, so a thread Rome knows to
      // be a group is what the scope subtracts — a row whose thread no session
      // covers is a direct exchange until something says otherwise.
      const direct = sql`
        ${addressed}
        AND NOT EXISTS (
          SELECT 1 FROM rome_sessions s
          WHERE s.type = 'channel'
            AND s.source_channel = l.channel
            AND s.source_thread_id = l.thread_id
            AND s.source_thread_type = 'group'
        )`;
      return sql`
        SELECT
          l.channel AS source,
          l.channel_user_id AS address,
          l.created_at AS at,
          0 AS outbound,
          'sentinel:' || l.id AS ref,
          l.text AS body
        FROM sentinel_log l
        WHERE ${direct}
        UNION ALL
        SELECT
          l.channel,
          l.channel_user_id,
          l.created_at,
          1,
          'sentinel:' || l.id || ':reply',
          l.response
        FROM sentinel_log l
        WHERE ${direct} AND l.response IS NOT NULL AND l.response <> ''`;
    },
  });
}

/**
 * Every account each group of mappings is reachable at, with every address the
 * channel folds onto it — one result per group, in the order given.
 *
 * Two mappings that name two addressings of one account collapse to one
 * account, so a person mapped under both a WhatsApp phone JID and its `@lid`
 * form reads one timeline rather than two halves of one.
 *
 * A channel with no account plane contributes the mapping's own address and
 * nothing else, which is all the channel can say about who it can reach.
 *
 * Positional and over every group at once, like `AccountNames.displayNames`
 * next door: each channel's address book costs a full read, so one caller
 * asking about a directory of people must not pay for one read per row.
 */
export async function timelineAccounts(
  deps: { whatsAppAccounts: TalkAccounts },
  groups: readonly (readonly ChannelMapping[])[],
): Promise<TimelineAccount[][]> {
  const channels = new Set(groups.flatMap((group) => group.map((mapping) => mapping.channel)));
  const books = await readAddressBooks(deps, channels);
  return groups.map((group) => foldAccounts(books, group));
}

interface ChannelMapping {
  channel: string;
  channelUserId: string;
}

/** Every address a channel folds onto an account, grouped by the account —
 *  the address map read the way the fold needs it, inverted once per request
 *  rather than re-scanned per person.
 *
 *  Read only for the channels the mappings name, since a plane costs a full
 *  address-book read. LinkedIn has a plane too but is deliberately absent: it
 *  stores a member under its member id and nothing else, so folding it would
 *  buy a whole mirror read and change no answer. It joins here when it starts
 *  storing a second addressing. */
async function readAddressBooks(
  deps: { whatsAppAccounts: TalkAccounts },
  channels: ReadonlySet<string>,
): Promise<Map<string, AddressBook>> {
  const planes = new Map<string, TalkAccounts>([["whatsapp", deps.whatsAppAccounts]]);
  const books = new Map<string, AddressBook>();
  for (const [channel, accounts] of planes) {
    if (!channels.has(channel)) continue;
    const addresses = await accounts.listAddresses();
    const byAccount = new Map<string, string[]>();
    for (const [address, accountId] of addresses) {
      const folded = byAccount.get(accountId);
      if (folded) folded.push(address);
      else byAccount.set(accountId, [address]);
    }
    books.set(channel, { of: addresses, folded: byAccount });
  }
  return books;
}

/** One channel's address map, and the same map read the other way round. */
interface AddressBook {
  /** Which account each address belongs to. */
  of: Map<string, string>;
  /** Every address of each account. */
  folded: Map<string, string[]>;
}

function foldAccounts(
  books: Map<string, AddressBook>,
  mappings: readonly ChannelMapping[],
): TimelineAccount[] {
  const byAccount = new Map<string, TimelineAccount>();
  for (const mapping of mappings) {
    const book = books.get(mapping.channel);
    const accountId = book?.of.get(mapping.channelUserId) ?? mapping.channelUserId;
    const key = `${mapping.channel}\n${accountId}`;
    if (byAccount.has(key)) continue;
    byAccount.set(key, {
      channel: mapping.channel,
      addresses: [...new Set([mapping.channelUserId, ...(book?.folded.get(accountId) ?? [])])],
    });
  }
  return [...byAccount.values()];
}

/** The line a stored agent message renders as: its text parts, joined.
 *  Non-text parts (cards, recaps, errors) carry no conversation, and content
 *  that does not parse is a row with nothing to show rather than a failed read. */
function messageContentText(raw: string | null): string | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const text = parsed
    .filter((part): part is Extract<MessagePart, { type: "text" }> => {
      if (typeof part !== "object" || part === null) return false;
      const candidate = part as { type?: unknown; content?: unknown };
      return candidate.type === "text" && typeof candidate.content === "string";
    })
    .map((part) => part.content)
    .join("\n");
  return text.length > 0 ? text : null;
}
