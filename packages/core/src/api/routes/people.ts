import { Hono, type Context } from "hono";
import {
  comparePeople,
  countPeople,
  linkConflict,
  parseLinkAccountRequest,
  parsePersonFilterLevel,
  parseTimelineCursor,
  personMatchesLevel,
  personMatchesQuery,
  timelinePageLimit,
  type PeopleList,
} from "@rome/api-types/people";
import { findPerson, readPeople, readPerson } from "../../people/resource.js";
import { readPersonTimeline } from "../../people/timeline.js";
import { personTimelineSources, timelineAccounts } from "../../people/timeline-sources.js";
import type { ApiDeps } from "../deps.js";

// The People surface's reads, and the link verb that moves an account between
// people. What a person and their accounts are, how the listing orders and
// counts, when a link may be taken and what a page of history is are the
// contract's (@rome/api-types/people); serializing a person is
// `src/people/resource.ts`; which stores a history is merged from is the rest
// of `src/people/`; the compare-and-swap the link rides on is the person
// repository's, because only a transaction there can decide it. These handlers
// parse requests and hold no rule of their own.

export function peopleRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/people", async (c) => {
    const rawLevel = c.req.query("level");
    const level = parsePersonFilterLevel(rawLevel);
    if (rawLevel != null && rawLevel !== "" && level === null) {
      return c.json({ error: `level must name a bond level or "all"` }, 400);
    }

    // The whole `?q=` match, before `?level=` narrows it: the counts describe
    // it, and every chip's number has to stay true while another chip is the
    // one selected.
    const matching = (await readPeople(deps)).filter((person) =>
      personMatchesQuery(person, c.req.query("q") ?? ""),
    );

    return c.json({
      people: matching
        .filter((person) => personMatchesLevel(person, level ?? "all"))
        .sort(comparePeople),
      counts: countPeople(matching),
    } satisfies PeopleList);
  });

  app.get("/people/:id", async (c) => {
    const person = await readPerson(deps, c.req.param("id"));
    return person ? c.json(person) : c.json({ error: "Unknown person" }, 404);
  });

  app.post("/people/:id/accounts", async (c) => {
    const person = await findPerson(deps, c.req.param("id"));
    if (!person) return c.json({ error: "Unknown person" }, 404);

    const request = parseLinkAccountRequest(await c.req.json().catch(() => null));
    if (!request) return c.json({ error: "channel and channelUserId are required" }, 400);

    const result = await deps.personMappingRepo.linkAccount({
      personId: person.id,
      channel: request.channel,
      channelUserId: request.channelUserId,
      transferFrom: request.transferFrom,
    });
    if (!result.linked) return c.json(linkConflict(request, result.holder), 409);

    return respondWithPerson(deps, c, person.id);
  });

  app.delete("/people/:id/accounts/:channel/:channelUserId", async (c) => {
    const person = await findPerson(deps, c.req.param("id"));
    if (!person) return c.json({ error: "Unknown person" }, 404);

    // A link this person does not hold is one this route cannot drop, whoever
    // else holds it: unlinking is not a way to reach into another person's
    // accounts, and reporting success would tell the caller their view was
    // right when it was stale.
    const unlinked = await deps.personMappingRepo.unlinkAccount(
      person.id,
      c.req.param("channel"),
      c.req.param("channelUserId"),
    );
    if (!unlinked) return c.json({ error: "Unknown account" }, 404);

    return respondWithPerson(deps, c, person.id);
  });

  app.get("/people/:id/messages", async (c) => {
    const person = await findPerson(deps, c.req.param("id"));
    if (!person) return c.json({ error: "Unknown person" }, 404);

    const rawCursor = c.req.query("cursor");
    const cursor = parseTimelineCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return c.json({ error: "cursor is not a timeline cursor" }, 400);
    }

    // A channel this person holds no account on answers an empty page rather
    // than a 400: channels are open — a Rome App brings its own — so there is
    // no set of names to check one against, and "no history there" is the true
    // answer for every name that is not a typo.
    const channel = c.req.query("channel");
    const [accounts] = await timelineAccounts(deps, [person.channelMappings]);

    return c.json(
      await readPersonTimeline(
        personTimelineSources(deps),
        accounts.filter((account) => !channel || account.channel === channel),
        { cursor, limit: timelinePageLimit(c.req.query("limit")) },
      ),
    );
  });

  return app;
}

/** The person a write just changed, read back through the same serializer the
 *  reads answer with, so a client can render the outcome without a second
 *  request. */
async function respondWithPerson(deps: ApiDeps, c: Context, id: string) {
  const person = await readPerson(deps, id);
  return person ? c.json(person) : c.json({ error: "Unknown person" }, 404);
}
