import { Hono } from "hono";
import {
  comparePeople,
  countPeople,
  parseCreatePersonRequest,
  parsePersonFilterLevel,
  parseTimelineCursor,
  personMatchesLevel,
  personMatchesQuery,
  timelinePageLimit,
  type PeopleList,
} from "@rome/api-types/people";
import { createPerson } from "../../people/create.js";
import { findPerson, readPeople, readPerson } from "../../people/resource.js";
import { readPersonTimeline } from "../../people/timeline.js";
import { personTimelineSources, timelineAccounts } from "../../people/timeline-sources.js";
import type { ApiDeps } from "../deps.js";

// The People surface. What a person and their accounts are, how the listing
// orders and counts, what a valid create is and what a refused link answers
// are the contract's (@rome/api-types/people); serializing a person is
// `src/people/resource.ts`, creating one is `src/people/create.ts`, and which
// stores a history is merged from is the rest of `src/people/`. These handlers
// read the request and pick a status code, and hold no rule of their own.

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

  app.post("/people", async (c) => {
    const parsed = parseCreatePersonRequest(await c.req.json().catch(() => null));
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const created = await createPerson(deps, parsed.person);
    // 409 rather than 400: the body is well formed and the guardian may well
    // have meant it. A held account is a fact about Rome's state, which a
    // transfer can change, rather than a mistake in the request.
    return "conflict" in created ? c.json(created.conflict, 409) : c.json(created.person, 201);
  });

  app.get("/people/:id", async (c) => {
    const person = await readPerson(deps, c.req.param("id"));
    return person ? c.json(person) : c.json({ error: "Unknown person" }, 404);
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
