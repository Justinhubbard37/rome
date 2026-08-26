import { describe, it, expect } from "vitest";
import {
  compareTimelineEntries,
  isAfterTimelineCursor,
  parseTimelineCursor,
  type TimelineEntry,
} from "@rome/api-types/people";
import { readPersonTimeline, type TimelineAccount, type TimelineSource } from "./timeline.js";
import { readPeopleActivity } from "./activity.js";

// The merge above the stores: what a page is, how it resumes, and which store
// owns an account. Every source here is a fake, so nothing below is about SQL —
// a store that answers the seam's contract is a store this merge can page.

const account = (channel: string, ...addresses: string[]): TimelineAccount => ({
  channel,
  addresses,
});

const entry = (
  source: string,
  timestamp: number,
  ref: string,
  direction: "inbound" | "outbound" = "inbound",
): TimelineEntry => ({ source, timestamp, ref, direction, body: `${ref}@${timestamp}` });

/**
 * A store held in memory, answering the seam exactly as its contract asks:
 * only entries strictly after the cursor, in order, at most `limit` of them.
 */
function fakeSource(
  name: string,
  held: Record<string, TimelineEntry[]>,
  calls: string[] = [],
): TimelineSource & { calls: string[] } {
  const addressesHeld = new Set(Object.keys(held));
  return {
    name,
    calls,
    async holds(accounts) {
      return accounts.filter((a) => a.addresses.some((address) => addressesHeld.has(address)));
    },
    async digest(accounts) {
      return accounts.flatMap((a) => {
        const entries = a.addresses.flatMap((address) => held[address] ?? []);
        if (entries.length === 0) return [];
        return [
          {
            account: a,
            latest: [...entries].sort(compareTimelineEntries)[0],
            messageCount: entries.length,
          },
        ];
      });
    },
    async read(request) {
      calls.push(name);
      const entries = request.accounts
        .flatMap((a) => a.addresses)
        .flatMap((address) => held[address] ?? []);
      return entries
        .filter((e) => request.cursor === null || isAfterTimelineCursor(e, request.cursor))
        .sort(compareTimelineEntries)
        .slice(0, request.limit);
    },
  };
}

describe("readPersonTimeline", () => {
  const whatsapp = fakeSource("wa", {
    "wa-1": [entry("whatsapp", 300, "wa:c"), entry("whatsapp", 100, "wa:a")],
  });
  const telegram = fakeSource("tg", {
    "tg-1": [entry("telegram", 200, "tg:b"), entry("telegram", 400, "tg:d")],
  });
  const accounts = [account("whatsapp", "wa-1"), account("telegram", "tg-1")];

  it("merges every account of a person into one newest-first page", async () => {
    const page = await readPersonTimeline([whatsapp, telegram], accounts, { limit: 10 });
    expect(page.entries.map((e) => e.ref)).toEqual(["tg:d", "wa:c", "tg:b", "wa:a"]);
    expect(page.nextCursor).toBeNull();
  });

  it("pages by nextCursor with no duplicate and no missing entry", async () => {
    const whole = (await readPersonTimeline([whatsapp, telegram], accounts, { limit: 10 })).entries;

    const walked: TimelineEntry[] = [];
    let cursor: TimelineEntry | null = null;
    for (let page = 0; page < 10; page += 1) {
      const next = await readPersonTimeline([whatsapp, telegram], accounts, { cursor, limit: 1 });
      walked.push(...next.entries);
      if (next.nextCursor === null) break;
      cursor = parseTimelineCursor(next.nextCursor);
      expect(cursor).not.toBeNull();
    }
    expect(walked).toEqual(whole);
  });

  it("resumes inside a second rather than after it", async () => {
    // Four entries share one timestamp, so a cursor carrying the timestamp
    // alone could only resume before or after all of them.
    const crowded = fakeSource("crowd", {
      "c-1": [
        entry("whatsapp", 100, "a"),
        entry("whatsapp", 100, "b", "outbound"),
        entry("whatsapp", 100, "c"),
        entry("whatsapp", 100, "d"),
      ],
    });
    const one = [account("whatsapp", "c-1")];
    const first = await readPersonTimeline([crowded], one, { limit: 2 });
    const rest = await readPersonTimeline([crowded], one, {
      cursor: parseTimelineCursor(first.nextCursor),
      limit: 10,
    });
    expect([...first.entries, ...rest.entries].map((e) => e.ref)).toEqual(["b", "a", "c", "d"]);
    expect(rest.nextCursor).toBeNull();
  });

  it("reports a next page whenever one exists", async () => {
    // The page is full and the history is exhausted at the same entry: a
    // caller told there is more reads one empty page, a caller told there is
    // not loses everything after it.
    const exact = await readPersonTimeline([whatsapp, telegram], accounts, { limit: 4 });
    expect(exact.entries).toHaveLength(4);
    expect(exact.nextCursor).toBeNull();

    const short = await readPersonTimeline([whatsapp, telegram], accounts, { limit: 3 });
    expect(short.nextCursor).not.toBeNull();
  });

  it("gives an account to the first store that holds it and asks no other", async () => {
    const calls: string[] = [];
    const mirror = fakeSource("mirror", { "wa-1": [entry("whatsapp", 500, "mirrored")] }, calls);
    const transcript = fakeSource(
      "transcript",
      { "wa-1": [entry("whatsapp", 500, "transcribed")] },
      calls,
    );
    const page = await readPersonTimeline([mirror, transcript], [account("whatsapp", "wa-1")], {
      limit: 10,
    });
    expect(page.entries.map((e) => e.ref)).toEqual(["mirrored"]);
    expect(calls).toEqual(["mirror"]);
  });

  it("falls through to a later store for an account the earlier one lacks", async () => {
    const mirror = fakeSource("mirror", { "wa-1": [entry("whatsapp", 500, "mirrored")] });
    const transcript = fakeSource("transcript", { "tg-1": [entry("telegram", 400, "typed")] });
    const page = await readPersonTimeline([mirror, transcript], accounts, { limit: 10 });
    expect(page.entries.map((e) => e.ref)).toEqual(["mirrored", "typed"]);
  });

  it("takes a new store as one more adapter, with nothing above it changed", async () => {
    // What "adding a source is one adapter" means: a store of a kind this file
    // has never heard of, appended to the list, and its entries page with the
    // rest through the same cursor.
    const app = fakeSource("some-rome-app", {
      "app-1": [entry("bookings", 250, "booking:7", "outbound")],
    });
    const page = await readPersonTimeline(
      [whatsapp, telegram, app],
      [...accounts, account("bookings", "app-1")],
      { limit: 10 },
    );
    expect(page.entries.map((e) => e.ref)).toEqual(["tg:d", "wa:c", "booking:7", "tg:b", "wa:a"]);
  });

  it("answers an empty page for a person with no accounts", async () => {
    const page = await readPersonTimeline([whatsapp, telegram], [], { limit: 10 });
    expect(page).toEqual({ entries: [], nextCursor: null });
  });
});

// The same precedence, read as a summary instead of a page: what a directory
// row shows for a person without opening their dossier.
describe("readPeopleActivity", () => {
  const waAccount = account("whatsapp", "wa-1");
  const tgAccount = account("telegram", "tg-1");

  it("summarizes each account from the first store that claims it", async () => {
    // One exchange written down twice, as the real stores overlap. Counting
    // both would report an inbox the dossier does not have.
    const mirror = fakeSource("mirror", { "wa-1": [entry("whatsapp", 500, "mirrored")] });
    const transcript = fakeSource("transcript", {
      "wa-1": [entry("whatsapp", 500, "copy"), entry("whatsapp", 200, "older copy")],
      "tg-1": [entry("telegram", 400, "typed")],
    });

    const [whatsapp, telegram] = await readPeopleActivity(
      [mirror, transcript],
      [[waAccount], [tgAccount]],
    );
    expect(whatsapp).toEqual({
      messageCount: 1,
      latest: { source: "whatsapp", timestamp: 500, preview: "mirrored@500" },
    });
    expect(telegram.messageCount).toBe(1);
  });

  it("folds a person's accounts into one history", async () => {
    const store = fakeSource("store", {
      "wa-1": [entry("whatsapp", 300, "wa:c"), entry("whatsapp", 100, "wa:a")],
      "tg-1": [entry("telegram", 400, "tg:d")],
    });

    const [both] = await readPeopleActivity([store], [[waAccount, tgAccount]]);
    expect(both).toEqual({
      messageCount: 3,
      // The head of the merged timeline, not of whichever account came first.
      latest: { source: "telegram", timestamp: 400, preview: "tg:d@400" },
    });
  });

  it("answers one activity per group, in the order given", async () => {
    const store = fakeSource("store", { "tg-1": [entry("telegram", 400, "tg:d")] });
    expect(await readPeopleActivity([store], [[waAccount], [], [tgAccount]])).toEqual([
      { latest: null, messageCount: 0 },
      { latest: null, messageCount: 0 },
      { latest: { source: "telegram", timestamp: 400, preview: "tg:d@400" }, messageCount: 1 },
    ]);
  });
});
