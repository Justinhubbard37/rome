import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import {
  latestDynamic,
  type PeopleList,
  type PersonResource,
  type TimelinePage,
} from "@rome/api-types/people";
import { peopleRoutes } from "./people.js";
import { createTestDb, buildTestDeps, type TestDb, type TestDeps } from "../../test/helpers.js";
import { seedBaseline, type BaselineIds } from "../../test/seeds.js";
import { romeAgentMessages } from "../../db/schema.js";
import { STRANGER_PERSON_ID } from "../../constants.js";

// GET /people/:id/messages — one person's history merged across every account
// they are linked to. These tests pin what the merge answers over real stores:
// which of the overlapping ones an account's entries come from, that a channel
// filter narrows to one, and that walking the cursor visits each entry once.

const WA_JID = "15550009999@s.whatsapp.net";
const WA_LID = "88881111@lid";
const TG_THREAD = "tg-timeline";
const GROUP_THREAD = "tg-group-timeline";

const at = (iso: string) => new Date(iso);
const textContent = (text: string) => JSON.stringify([{ type: "text", content: text }]);

describe("People timeline API", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let baseline: BaselineIds;
  let personId: string;
  let telegramSessionId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    baseline = await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", peopleRoutes(deps));

    personId = await deps.personMappingRepo.create({
      displayName: "Nadia Cross",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [
        { channel: "whatsapp", channelUserId: WA_JID },
        { channel: "telegram", channelUserId: TG_THREAD },
      ],
    });

    // WhatsApp: a mirrored direct thread, plus a group chat she is not read
    // through, plus a reaction the timeline does not render.
    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: WA_JID, phoneNumber: "15550009999", name: "Nadia Cross" },
    ]);
    await deps.whatsAppStoreRepo.upsertMessages([
      {
        id: "wa-old",
        chatJid: WA_JID,
        senderJid: WA_JID,
        fromMe: false,
        timestamp: at("2026-08-01T09:00:00Z"),
        type: "text",
        text: "are we still on for friday",
        hasMedia: false,
      },
      {
        id: "wa-reply",
        chatJid: WA_JID,
        senderJid: WA_JID,
        fromMe: true,
        timestamp: at("2026-08-01T09:05:00Z"),
        type: "text",
        text: "yes — 7pm",
        hasMedia: false,
      },
      {
        id: "wa-react",
        chatJid: WA_JID,
        senderJid: WA_JID,
        fromMe: false,
        timestamp: at("2026-08-01T09:06:00Z"),
        type: "reaction",
        text: "👍",
        hasMedia: false,
        reactsToId: "wa-reply",
      },
      {
        id: "wa-group",
        chatJid: "120363000000000009@g.us",
        senderJid: WA_JID,
        fromMe: false,
        timestamp: at("2026-08-02T10:00:00Z"),
        type: "text",
        text: "posted in the group",
        hasMedia: false,
      },
    ]);

    // Telegram: no mirror, so her direct conversation is the channel session's
    // own transcript.
    const conversation = await deps.webchatRepo.ensureChannelConversation({
      channel: "telegram",
      threadId: TG_THREAD,
      threadType: "private",
      agentName: "main",
    });
    await deps.webchatRepo.addConversationMessage({
      sessionId: conversation.id,
      role: "user",
      content: textContent("did you see the invite"),
      platformMessageId: "tg-100",
      senderId: TG_THREAD,
      senderName: "Nadia Cross",
      createdAt: at("2026-08-03T08:00:00Z"),
    });
    telegramSessionId = conversation.id;
    await testDb.db.insert(romeAgentMessages).values({
      id: "tg-100-reply",
      sessionId: conversation.id,
      role: "assistant",
      content: textContent("just did — replying now"),
      createdAt: at("2026-08-03T08:01:00Z"),
    });
  });

  afterEach(() => testDb.close());

  async function fetchTimeline(id: string, query = ""): Promise<TimelinePage> {
    const res = await app.request(`/people/${id}/messages${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as TimelinePage;
  }

  it("returns entries across every account of the person, newest first", async () => {
    const page = await fetchTimeline(personId);
    expect(page.entries.map((entry) => [entry.source, entry.body])).toEqual([
      ["telegram", "just did — replying now"],
      ["telegram", "did you see the invite"],
      ["whatsapp", "yes — 7pm"],
      ["whatsapp", "are we still on for friday"],
    ]);
    expect(page.entries.map((entry) => entry.direction)).toEqual([
      "outbound",
      "inbound",
      "outbound",
      "inbound",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("leaves out group conversations and reactions", async () => {
    const bodies = (await fetchTimeline(personId)).entries.map((entry) => entry.body);
    expect(bodies).not.toContain("posted in the group");
    expect(bodies).not.toContain("👍");
  });

  it("pages by nextCursor with no duplicate and no missing entry", async () => {
    const whole = (await fetchTimeline(personId)).entries;

    const walked: TimelinePage["entries"] = [];
    let query = "?limit=1";
    for (let page = 0; page < 10; page += 1) {
      const next = await fetchTimeline(personId, query);
      expect(next.entries).toHaveLength(1);
      walked.push(...next.entries);
      if (next.nextCursor === null) break;
      query = `?limit=1&cursor=${encodeURIComponent(next.nextCursor)}`;
    }
    expect(walked).toEqual(whole);
  });

  it("resumes inside a second that two stores both wrote to", async () => {
    // Whole seconds collide across stores, so the cursor has to name an entry
    // rather than a moment: resuming from the bare timestamp would drop
    // whatever else landed in the same second.
    const collide = at("2026-08-07T11:11:11Z");
    await deps.whatsAppStoreRepo.upsertMessages([
      {
        id: "wa-tie-in",
        chatJid: WA_JID,
        senderJid: WA_JID,
        fromMe: false,
        timestamp: collide,
        type: "text",
        text: "whatsapp inbound",
        hasMedia: false,
      },
      {
        id: "wa-tie-out",
        chatJid: WA_JID,
        senderJid: WA_JID,
        fromMe: true,
        timestamp: collide,
        type: "text",
        text: "whatsapp outbound",
        hasMedia: false,
      },
    ]);
    await deps.webchatRepo.addConversationMessage({
      sessionId: telegramSessionId,
      role: "user",
      content: textContent("telegram inbound"),
      platformMessageId: "tg-tie",
      senderId: TG_THREAD,
      createdAt: collide,
    });

    const whole = (await fetchTimeline(personId)).entries;
    const tied = whole.filter((entry) => entry.timestamp === Math.floor(collide.getTime() / 1000));
    expect(tied.map((entry) => entry.body)).toEqual([
      "whatsapp outbound",
      "telegram inbound",
      "whatsapp inbound",
    ]);

    const walked: TimelinePage["entries"] = [];
    let query = "?limit=1";
    for (let page = 0; page < 20; page += 1) {
      const next = await fetchTimeline(personId, query);
      walked.push(...next.entries);
      if (next.nextCursor === null) break;
      query = `?limit=1&cursor=${encodeURIComponent(next.nextCursor)}`;
    }
    expect(walked).toEqual(whole);
  });

  it("narrows to one source with ?channel=", async () => {
    const page = await fetchTimeline(personId, "?channel=whatsapp");
    expect(page.entries.map((entry) => entry.source)).toEqual(["whatsapp", "whatsapp"]);

    // A channel the person holds no account on is an empty history rather than
    // a bad request — channels are open-ended.
    expect((await fetchTimeline(personId, "?channel=discord")).entries).toEqual([]);
  });

  it("gives a sender with only sentinel history both halves of the exchange", async () => {
    const sentinelOnly = await deps.personMappingRepo.create({
      displayName: "Sentinel Only",
      bondLevel: "other",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: "tg-triaged" }],
    });
    await deps.sentinelLogRepo.create({
      messageId: "tg-900",
      channel: "telegram",
      channelUserId: "tg-triaged",
      displayName: "Sentinel Only",
      threadId: "tg-triaged",
      text: "is this the right number for bookings?",
      action: "replied",
      response: "it is — sending you the link",
    });

    const page = await fetchTimeline(sentinelOnly);
    expect(page.entries.map((entry) => [entry.direction, entry.body])).toEqual([
      ["outbound", "it is — sending you the link"],
      ["inbound", "is this the right number for bookings?"],
    ]);
  });

  it("reads a mirrored account from the mirror and never twice", async () => {
    // One WhatsApp exchange, written down three times: by the mirror, by Rome's
    // own transcript of the channel session, and by the sentinel that triaged
    // it. Production stores the same words in all three; the wording differs
    // here only so the assertion can say which store answered.
    const conversation = await deps.webchatRepo.ensureChannelConversation({
      channel: "whatsapp",
      threadId: WA_JID,
      threadType: "private",
      agentName: "main",
    });
    await deps.webchatRepo.addConversationMessage({
      sessionId: conversation.id,
      role: "notification",
      content: textContent("as the transcript has it"),
      platformMessageId: "wa-old",
      senderId: WA_JID,
      createdAt: at("2026-08-01T09:00:02Z"),
    });
    await deps.sentinelLogRepo.create({
      messageId: "wa-old",
      channel: "whatsapp",
      channelUserId: WA_JID,
      threadId: WA_JID,
      text: "as the sentinel logged it",
      action: "replied",
      response: "as the sentinel answered it",
    });

    const whatsapp = (await fetchTimeline(personId, "?channel=whatsapp")).entries;
    expect(whatsapp.map((entry) => entry.body)).toEqual([
      "yes — 7pm",
      "are we still on for friday",
    ]);
  });

  it("falls back to the channel transcript for an account no mirror holds", async () => {
    // The same overlap without a mirror: the transcript outranks the sentinel,
    // so the exchange reads as Rome's own record of it.
    const triaged = await deps.personMappingRepo.create({
      displayName: "Triaged Talker",
      bondLevel: "other",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: "tg-both" }],
    });
    const conversation = await deps.webchatRepo.ensureChannelConversation({
      channel: "telegram",
      threadId: "tg-both",
      threadType: "private",
      agentName: "main",
    });
    await deps.webchatRepo.addConversationMessage({
      sessionId: conversation.id,
      role: "notification",
      content: textContent("as the transcript has it"),
      platformMessageId: "tg-800",
      senderId: "tg-both",
      createdAt: at("2026-08-04T08:00:00Z"),
    });
    await deps.sentinelLogRepo.create({
      messageId: "tg-800",
      channel: "telegram",
      channelUserId: "tg-both",
      threadId: "tg-both",
      text: "as the sentinel logged it",
      action: "replied",
      response: "as the sentinel answered it",
    });

    const bodies = (await fetchTimeline(triaged)).entries.map((entry) => entry.body);
    expect(bodies).toEqual(["as the transcript has it"]);
  });

  it("holds a sentinel row back when the thread it names is a group", async () => {
    const inGroup = await deps.personMappingRepo.create({
      displayName: "Group Talker",
      bondLevel: "other",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: "tg-in-group" }],
    });
    await deps.webchatRepo.ensureChannelConversation({
      channel: "telegram",
      threadId: GROUP_THREAD,
      threadType: "group",
      agentName: "main",
    });
    await deps.sentinelLogRepo.create({
      messageId: "tg-901",
      channel: "telegram",
      channelUserId: "tg-in-group",
      threadId: GROUP_THREAD,
      text: "said in a group",
      action: "ignored",
    });
    await deps.sentinelLogRepo.create({
      messageId: "tg-902",
      channel: "telegram",
      channelUserId: "tg-in-group",
      threadId: "tg-in-group",
      text: "said to rome",
      action: "ignored",
    });

    const bodies = (await fetchTimeline(inGroup)).entries.map((entry) => entry.body);
    expect(bodies).toEqual(["said to rome"]);
  });

  it("reads one account through every address the channel folds onto it", async () => {
    // She is mapped under the LID, and the conversation hangs off the phone
    // JID. Both address one account, so the timeline is one conversation.
    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: WA_LID, phoneNumber: "15550009999", notify: "Nadia" },
    ]);
    const byLid = await deps.personMappingRepo.create({
      displayName: "Nadia By LID",
      bondLevel: "other",
      approved: true,
      channelMappings: [{ channel: "whatsapp", channelUserId: WA_LID }],
    });

    const page = await fetchTimeline(byLid);
    expect(page.entries.map((entry) => entry.body)).toEqual([
      "yes — 7pm",
      "are we still on for friday",
    ]);
  });

  it("reads LinkedIn direct threads and leaves group threads out", async () => {
    const member = "ACoAAtimeline01";
    await deps.linkedInStoreRepo.upsertThreads([
      { threadId: "li-direct", threadUrl: "https://x/li-direct", unread: false },
      { threadId: "li-group", threadUrl: "https://x/li-group", unread: false },
      { threadId: "li-unread-group", threadUrl: "https://x/li-ug", unread: false },
    ]);
    await deps.linkedInStoreRepo.markThreadSynced("li-direct", { isGroup: false });
    // Flagged a group before its membership was read whole, so the flag is the
    // only thing that keeps it out.
    await deps.linkedInStoreRepo.markThreadSynced("li-unread-group", { isGroup: true });
    await deps.linkedInStoreRepo.upsertThreadParticipants("li-direct", [
      { participantId: member, name: "Priya Nair", isSelf: false },
      { participantId: "ACoAAself", name: "Guardian", isSelf: true },
    ]);
    await deps.linkedInStoreRepo.upsertThreadParticipants("li-group", [
      { participantId: member, name: "Priya Nair", isSelf: false },
      { participantId: "ACoAAself", name: "Guardian", isSelf: true },
      { participantId: "ACoAAthird", name: "Someone Else", isSelf: false },
    ]);
    await deps.linkedInStoreRepo.upsertThreadParticipants("li-unread-group", [
      { participantId: member, name: "Priya Nair", isSelf: false },
      { participantId: "ACoAAself", name: "Guardian", isSelf: true },
    ]);
    await deps.linkedInStoreRepo.upsertMessages([
      {
        messageId: "li-1",
        threadId: "li-direct",
        sentAt: at("2026-08-05T12:00:00Z"),
        senderIsSelf: false,
        text: "sent you a note about the role",
      },
      {
        messageId: "li-2",
        threadId: "li-direct",
        sentAt: at("2026-08-05T12:30:00Z"),
        senderIsSelf: true,
        text: "thanks — reading it now",
      },
      {
        messageId: "li-3",
        threadId: "li-group",
        sentAt: at("2026-08-06T12:00:00Z"),
        senderIsSelf: false,
        text: "posted in the group thread",
      },
      {
        messageId: "li-4",
        threadId: "li-unread-group",
        sentAt: at("2026-08-06T13:00:00Z"),
        senderIsSelf: false,
        text: "posted in the unread group",
      },
    ]);
    const priya = await deps.personMappingRepo.create({
      displayName: "Priya Nair",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "linkedin", channelUserId: member }],
    });

    const page = await fetchTimeline(priya);
    expect(page.entries.map((entry) => [entry.source, entry.direction, entry.body])).toEqual([
      ["linkedin", "outbound", "thanks — reading it now"],
      ["linkedin", "inbound", "sent you a note about the role"],
    ]);
  });

  it("answers 404 for an unknown person and for the stranger sentinel", async () => {
    expect((await app.request("/people/nobody-here/messages")).status).toBe(404);
    expect((await app.request(`/people/${STRANGER_PERSON_ID}/messages`)).status).toBe(404);
    expect(baseline.persons.strangerId).toBe(STRANGER_PERSON_ID);
  });

  it("refuses a cursor that is not one", async () => {
    const res = await app.request(`/people/${personId}/messages?cursor=not-a-cursor`);
    expect(res.status).toBe(400);
  });

  it("answers an empty page for a person with no accounts", async () => {
    const unreachable = await deps.personMappingRepo.create({
      displayName: "No Channels",
      bondLevel: "other",
      approved: true,
      channelMappings: [],
    });
    expect(await fetchTimeline(unreachable)).toEqual({ entries: [], nextCursor: null });
  });
});

// GET /people and GET /people/:id — the curated people, their accounts as each
// platform names them, and the activity a row shows without opening the
// dossier. What the numbers count is the point of most of these: a person's
// history is written down in several overlapping stores, so a row that adds
// them up reports an inbox nobody has.

describe("People API", () => {
  const NADIA_JID = "15550001111@s.whatsapp.net";
  const NADIA_LID = "77771111@lid";

  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let baseline: BaselineIds;
  let nadiaId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    baseline = await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", peopleRoutes(deps));

    // One WhatsApp account reachable two ways, which the mirror folds onto the
    // phone JID, and a person mapped under both of them.
    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: NADIA_JID, phoneNumber: "15550001111", name: "Nadia Cross" },
      { jid: NADIA_LID, phoneNumber: "15550001111", notify: "Nadia" },
    ]);
    await deps.whatsAppStoreRepo.upsertMessages([
      {
        id: "wa-n1",
        chatJid: NADIA_JID,
        senderJid: NADIA_JID,
        fromMe: false,
        timestamp: at("2026-08-10T09:00:00Z"),
        type: "text",
        text: "are we still on for friday",
        hasMedia: false,
      },
      {
        id: "wa-n2",
        chatJid: NADIA_JID,
        senderJid: NADIA_JID,
        fromMe: true,
        timestamp: at("2026-08-10T09:05:00Z"),
        type: "text",
        text: "yes — 7pm",
        hasMedia: false,
      },
      {
        id: "wa-n-react",
        chatJid: NADIA_JID,
        senderJid: NADIA_JID,
        fromMe: false,
        timestamp: at("2026-08-10T09:06:00Z"),
        type: "reaction",
        text: "👍",
        hasMedia: false,
        reactsToId: "wa-n2",
      },
      {
        id: "wa-n-group",
        chatJid: "120363000000000011@g.us",
        senderJid: NADIA_JID,
        fromMe: false,
        timestamp: at("2026-08-11T10:00:00Z"),
        type: "text",
        text: "posted in the group",
        hasMedia: false,
      },
    ]);

    nadiaId = await deps.personMappingRepo.create({
      displayName: "Nadia Cross",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [
        { channel: "whatsapp", channelUserId: NADIA_JID },
        { channel: "whatsapp", channelUserId: NADIA_LID },
      ],
    });
  });

  afterEach(() => testDb.close());

  async function fetchList(query = ""): Promise<PeopleList> {
    const res = await app.request(`/people${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as PeopleList;
  }

  async function fetchPerson(id: string): Promise<PersonResource> {
    const res = await app.request(`/people/${id}`);
    expect(res.status).toBe(200);
    return (await res.json()) as PersonResource;
  }

  it("lists every curated person with their accounts, and never the sentinel", async () => {
    const { people } = await fetchList();
    const ids = people.map((person) => person.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        baseline.persons.guardianId,
        baseline.persons.innerCircleId,
        baseline.persons.acquaintanceId,
        baseline.persons.otherId,
        nadiaId,
      ]),
    );
    // The sentinel is the row dismissed accounts are linked to, not someone
    // the guardian knows.
    expect(ids).not.toContain(STRANGER_PERSON_ID);

    const alice = people.find((person) => person.id === baseline.persons.innerCircleId);
    expect(alice?.accounts).toEqual([
      // Telegram mirrors no address book, so the name is the one the sender put
      // on their own messages — the directory seam's second fallback.
      { channel: "telegram", channelUserId: "tg-alice", displayName: "Alice Inner" },
    ]);

    const carol = people.find((person) => person.id === baseline.persons.otherId);
    // Nothing has ever named this account, so it is rendered as its identifier
    // rather than as an empty string.
    expect(carol?.accounts).toEqual([
      { channel: "whatsapp", channelUserId: "wa-carol", displayName: "wa-carol" },
    ]);
  });

  it("names an account as its platform does, over every addressing of it", async () => {
    const nadia = await fetchPerson(nadiaId);
    // One account, two mappings: a client addresses the link it stored, and
    // both carry the mirror's name for the account rather than the raw jid.
    expect(nadia.accounts).toEqual([
      { channel: "whatsapp", channelUserId: NADIA_JID, displayName: "Nadia Cross" },
      { channel: "whatsapp", channelUserId: NADIA_LID, displayName: "Nadia Cross" },
    ]);
  });

  it("answers 404 for the stranger sentinel and for an id naming no person", async () => {
    expect((await app.request(`/people/${STRANGER_PERSON_ID}`)).status).toBe(404);
    expect((await app.request("/people/nobody-here")).status).toBe(404);
    expect(baseline.persons.strangerId).toBe(STRANGER_PERSON_ID);
  });

  it("keeps a stored bond level the ladder does not name, and counts it as other", async () => {
    // Older rows carry levels outside today's enum. Rewriting one on the way
    // out would make a person's own level unreadable.
    await testDb.db.run(
      sql`UPDATE persons SET bond_level = 'colleague' WHERE id = ${baseline.persons.otherId}`,
    );

    expect((await fetchPerson(baseline.persons.otherId)).bondLevel).toBe("colleague");

    const filtered = await fetchList("?level=other");
    expect(filtered.people.map((person) => person.id)).toContain(baseline.persons.otherId);
  });

  it("counts the whole match rather than the rows it returned", async () => {
    const whole = await fetchList();
    const narrowed = await fetchList("?level=inner-circle");

    expect(narrowed.people.map((person) => person.id)).toEqual([baseline.persons.innerCircleId]);
    // The chips are how the guardian leaves the level they are on, so every
    // number stays true while one of them is selected.
    expect(narrowed.counts).toEqual(whole.counts);
    expect(whole.counts.guardian).toBe(1);
    expect(whole.counts["inner-circle"]).toBe(1);
    expect(whole.counts.acquaintance).toBe(2);
    expect(whole.counts.other).toBe(1);
    expect(whole.counts.all).toBe(5);
  });

  it("narrows the match with ?q=, including by an account's identifier", async () => {
    const byName = await fetchList("?q=nadia");
    expect(byName.people.map((person) => person.id)).toEqual([nadiaId]);
    expect(byName.counts.all).toBe(1);
    expect(byName.counts.acquaintance).toBe(1);

    // A guardian searches with what they have — the phone number they were
    // given, not the name Rome saved.
    const byNumber = await fetchList("?q=15550001111");
    expect(byNumber.people.map((person) => person.id)).toEqual([nadiaId]);
  });

  it("refuses a level that names no view", async () => {
    const res = await app.request("/people?level=colleague");
    expect(res.status).toBe(400);
  });

  it("previews the head of the person's own timeline and counts its entries", async () => {
    const { people } = await fetchList();

    for (const person of people) {
      const timeline = (await fetchTimelineFor(person.id)).entries;
      expect(person.latest).toEqual(latestDynamic(timeline));
      expect(person.messageCount).toBe(timeline.length);
    }
  });

  it("counts one account's history once, whatever it is addressed by", async () => {
    const nadia = await fetchPerson(nadiaId);
    // Two mappings onto one mirrored account, and one conversation on it: the
    // reaction and the group message are not entries, and the two addressings
    // are not two histories.
    expect(nadia.messageCount).toBe(2);
    expect(nadia.latest).toEqual({
      source: "whatsapp",
      timestamp: Math.floor(at("2026-08-10T09:05:00Z").getTime() / 1000),
      preview: "yes — 7pm",
    });
  });

  it("counts one exchange once when three stores wrote it down", async () => {
    // The mirror, Rome's own transcript of the channel session, and the
    // sentinel that triaged it all hold the same WhatsApp message. Adding them
    // would treble the number beside her name.
    const conversation = await deps.webchatRepo.ensureChannelConversation({
      channel: "whatsapp",
      threadId: NADIA_JID,
      threadType: "private",
      agentName: "main",
    });
    await deps.webchatRepo.addConversationMessage({
      sessionId: conversation.id,
      role: "notification",
      content: JSON.stringify([{ type: "text", content: "as the transcript has it" }]),
      platformMessageId: "wa-n1",
      senderId: NADIA_JID,
      createdAt: at("2026-08-10T09:00:02Z"),
    });
    await deps.sentinelLogRepo.create({
      messageId: "wa-n1",
      channel: "whatsapp",
      channelUserId: NADIA_JID,
      threadId: NADIA_JID,
      text: "as the sentinel logged it",
      action: "replied",
      response: "as the sentinel answered it",
    });

    expect((await fetchPerson(nadiaId)).messageCount).toBe(2);
  });

  it("orders by newest activity, with people who have said nothing last", async () => {
    const { people } = await fetchList();
    const silent = people.filter((person) => person.latest === null).map((person) => person.id);
    const spoken = people.filter((person) => person.latest !== null);

    expect(spoken.map((person) => person.latest?.timestamp)).toEqual(
      [...spoken.map((person) => person.latest?.timestamp ?? 0)].sort((a, b) => b - a),
    );
    expect(people.slice(people.length - silent.length).map((person) => person.id)).toEqual(silent);
    // The seed has both kinds, so the two assertions above are not vacuous.
    expect(spoken.length).toBeGreaterThan(1);
    expect(silent.length).toBeGreaterThan(0);
  });

  it("answers a person with no accounts as one with no history", async () => {
    const unreachable = await deps.personMappingRepo.create({
      displayName: "No Channels",
      bondLevel: "other",
      approved: true,
      channelMappings: [],
    });
    const person = await fetchPerson(unreachable);
    expect(person.accounts).toEqual([]);
    expect(person.messageCount).toBe(0);
    expect(person.latest).toBeNull();
  });

  async function fetchTimelineFor(id: string): Promise<TimelinePage> {
    const res = await app.request(`/people/${id}/messages?limit=300`);
    expect(res.status).toBe(200);
    return (await res.json()) as TimelinePage;
  }
});

// POST /people — the guardian names someone, and says which accounts are
// theirs. Both halves land or neither does, so most of these tests check what
// is in the database after a refusal rather than only the status code.

describe("People create API", () => {
  const ALICE_JID = "15550002222@s.whatsapp.net";
  const BOB_JID = "15550003333@s.whatsapp.net";

  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;

  beforeEach(async () => {
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", peopleRoutes(deps));

    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: ALICE_JID, phoneNumber: "15550002222", name: "Alice Marsh" },
      { jid: BOB_JID, phoneNumber: "15550003333", name: "Bob Reyes" },
    ]);
  });

  afterEach(() => testDb.close());

  it("creates the person and both links, named as each platform names them", async () => {
    const res = await create({
      displayName: "Bob Reyes",
      bondLevel: "inner-circle",
      accounts: [
        { channel: "whatsapp", channelUserId: BOB_JID },
        { channel: "telegram", channelUserId: "tg-bob-reyes" },
      ],
    });

    expect(res.status).toBe(201);
    const person = (await res.json()) as PersonResource;
    expect(person.id).toBe("bob-reyes");
    expect(person.bondLevel).toBe("inner-circle");
    expect(person.accounts).toEqual([
      { channel: "whatsapp", channelUserId: BOB_JID, displayName: "Bob Reyes" },
      // No mirror answers for telegram, so the address is the only name there
      // is — the person's own name never stands in for it.
      { channel: "telegram", channelUserId: "tg-bob-reyes", displayName: "tg-bob-reyes" },
    ]);

    // The response is a read of what was written, not a copy of the request.
    expect(await fetchPerson("bob-reyes")).toEqual(person);
    const { people } = await fetchList();
    expect(people.map((p) => p.id)).toContain("bob-reyes");
  });

  it("places a person at 'other' when the request names no bond level", async () => {
    const res = await create({ displayName: "Unranked" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as PersonResource).bondLevel).toBe("other");
  });

  it("refuses the whole request over one held account, and writes nothing", async () => {
    const alice = await deps.personMappingRepo.create({
      displayName: "Alice Marsh",
      bondLevel: "inner-circle",
      approved: true,
      channelMappings: [{ channel: "whatsapp", channelUserId: ALICE_JID }],
    });

    const res = await create({
      displayName: "Bob Reyes",
      accounts: [
        { channel: "telegram", channelUserId: "tg-bob-reyes" },
        { channel: "whatsapp", channelUserId: ALICE_JID },
      ],
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: expect.stringContaining("Alice Marsh"),
      channel: "whatsapp",
      channelUserId: ALICE_JID,
      linkedPersonId: alice,
      linkedPersonName: "Alice Marsh",
    });

    // Neither half of the request survived: no person, and the account that
    // was free before the call is still free.
    expect((await fetchPeopleRes("bob-reyes")).status).toBe(404);
    expect(await deps.personMappingRepo.findByChannelUser("telegram", "tg-bob-reyes")).toBeNull();
    expect((await deps.personMappingRepo.findByChannelUser("whatsapp", ALICE_JID))?.id).toBe(alice);
  });

  it("links an account that only a dismissal held", async () => {
    await deps.personMappingRepo.addChannelMapping(
      STRANGER_PERSON_ID,
      "whatsapp",
      BOB_JID,
      "Bob Reyes",
    );

    const res = await create({
      displayName: "Bob Reyes",
      accounts: [{ channel: "whatsapp", channelUserId: BOB_JID }],
    });

    expect(res.status).toBe(201);
    expect((await deps.personMappingRepo.findByChannelUser("whatsapp", BOB_JID))?.id).toBe(
      "bob-reyes",
    );
    const sentinel = await deps.personMappingRepo.findById(STRANGER_PERSON_ID);
    expect(sentinel!.channelMappings).toHaveLength(0);
  });

  it("numbers people who share a name, counting the first as one", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await create({ displayName: "Ada Lovelace" });
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as PersonResource).id);
    }
    expect(ids).toEqual(["ada-lovelace", "ada-lovelace-2", "ada-lovelace-3"]);
  });

  it("links an account once when the request names it twice", async () => {
    const res = await create({
      displayName: "Bob Reyes",
      accounts: [
        { channel: "whatsapp", channelUserId: BOB_JID },
        { channel: "whatsapp", channelUserId: BOB_JID },
      ],
    });

    expect(res.status).toBe(201);
    expect(((await res.json()) as PersonResource).accounts).toHaveLength(1);
  });

  it("answers 400 with an error body for a request nobody can act on", async () => {
    for (const body of [
      {},
      { displayName: "   " },
      { displayName: "Bob", bondLevel: "guardian" },
      { displayName: "Bob", bondLevel: "colleague" },
      { displayName: "Bob", accounts: [{ channel: "whatsapp" }] },
      { displayName: "Bob", accounts: "whatsapp" },
    ]) {
      const res = await create(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    }

    // A body that is not JSON at all reads as a request with no name in it.
    const malformed = await app.request("/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    // None of the above left a row behind.
    expect((await fetchList()).people.map((person) => person.displayName)).not.toContain("Bob");
  });

  function create(body: unknown) {
    return app.request("/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function fetchPeopleRes(id: string) {
    return app.request(`/people/${id}`);
  }

  async function fetchPerson(id: string): Promise<PersonResource> {
    const res = await fetchPeopleRes(id);
    expect(res.status).toBe(200);
    return (await res.json()) as PersonResource;
  }

  async function fetchList(): Promise<PeopleList> {
    const res = await app.request("/people");
    expect(res.status).toBe(200);
    return (await res.json()) as PeopleList;
  }
});
