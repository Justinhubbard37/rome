import { eq, and, sql, ne, like, inArray, exists, notExists } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { persons, channelMappings } from "../schema.js";
import type { DrizzleDb, SqliteExec } from "../index.js";
import { STRANGER_PERSON_ID } from "../../constants.js";
import { generatePersonSlug, nextAvailablePersonId } from "@rome/api-types/persons";

// Re-exported so existing importers keep their path. The derivation itself
// lives in the shared package because the dashboard's mock backend has to
// predict the ids this repository mints.
export { generatePersonSlug };

/** An identity cleared for a person to take, with the channel-side name that
 *  travels with it. */
interface ChannelClaim {
  channel: string;
  channelUserId: string;
  displayName: string | null;
}

export interface NewPersonData {
  displayName: string;
  bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other";
  profilePath?: string;
  approved?: boolean;
}

export class PersonMappingRepository {
  constructor(private db: DrizzleDb) {}

  async generatePersonId(displayName: string): Promise<string> {
    const base = generatePersonSlug(displayName);
    if (!base) return uuid();

    const existing = await this.db
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.id, base));
    if (existing.length === 0) return base;

    const conflicts = await this.db
      .select({ id: persons.id })
      .from(persons)
      .where(like(persons.id, `${base}-%`));

    return nextAvailablePersonId(base, [base, ...conflicts.map((row) => row.id)]);
  }

  async findByChannelUser(channel: string, channelUserId: string) {
    const rows = await this.db
      .select({
        person: persons,
        mapping: channelMappings,
      })
      .from(channelMappings)
      .innerJoin(persons, eq(channelMappings.personId, persons.id))
      .where(
        and(eq(channelMappings.channel, channel), eq(channelMappings.channelUserId, channelUserId)),
      );

    if (rows.length === 0) return null;

    const person = rows[0].person;
    const allMappings = await this.db
      .select()
      .from(channelMappings)
      .where(eq(channelMappings.personId, person.id));

    return {
      ...person,
      channelMappings: allMappings.map((m) => ({
        channel: m.channel,
        channelUserId: m.channelUserId,
      })),
    };
  }

  async findById(id: string) {
    const rows = await this.db.select().from(persons).where(eq(persons.id, id));
    if (rows.length === 0) return null;

    const person = rows[0];
    const mappings = await this.db
      .select()
      .from(channelMappings)
      .where(eq(channelMappings.personId, id));

    return {
      ...person,
      channelMappings: mappings.map((m) => ({
        channel: m.channel,
        channelUserId: m.channelUserId,
      })),
    };
  }

  async findByName(displayName: string) {
    const rows = await this.db.select().from(persons).where(eq(persons.displayName, displayName));

    const results = [];
    for (const person of rows) {
      const mappings = await this.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.personId, person.id));
      results.push({
        ...person,
        channelMappings: mappings.map((m) => ({
          channel: m.channel,
          channelUserId: m.channelUserId,
        })),
      });
    }
    return results;
  }

  async findByNameFuzzy(displayName: string) {
    const rows = await this.db
      .select()
      .from(persons)
      .where(
        and(
          sql`LOWER(${persons.displayName}) = LOWER(${displayName})`,
          ne(persons.id, STRANGER_PERSON_ID),
        ),
      );

    if (rows.length === 0) return null;

    const person = rows[0];
    const mappings = await this.db
      .select()
      .from(channelMappings)
      .where(eq(channelMappings.personId, person.id));

    return {
      ...person,
      channelMappings: mappings.map((m) => ({
        channel: m.channel,
        channelUserId: m.channelUserId,
      })),
    };
  }

  async findByBondLevel(bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other") {
    const rows = await this.db.select().from(persons).where(eq(persons.bondLevel, bondLevel));

    const results = [];
    for (const person of rows) {
      const mappings = await this.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.personId, person.id));
      results.push({
        ...person,
        channelMappings: mappings.map((m) => ({
          channel: m.channel,
          channelUserId: m.channelUserId,
        })),
      });
    }
    return results;
  }

  /**
   * Every person with their channel mappings, read as one statement.
   *
   * One statement rather than one per person, and not only to save the reads:
   * a mapping moving between two people mid-read would otherwise land under
   * both of them (or neither), because each person's mappings would arrive in
   * their own autocommit query. Every reader of this table assumes an identity
   * has one owner.
   */
  async findAllWithMappings() {
    const rows = await this.db
      .select({ person: persons, mapping: channelMappings })
      .from(persons)
      .leftJoin(channelMappings, eq(channelMappings.personId, persons.id));

    const byPerson = new Map<
      string,
      typeof persons.$inferSelect & {
        channelMappings: { channel: string; channelUserId: string }[];
      }
    >();
    for (const row of rows) {
      let person = byPerson.get(row.person.id);
      if (!person) {
        person = { ...row.person, channelMappings: [] };
        byPerson.set(row.person.id, person);
      }
      if (row.mapping) {
        person.channelMappings.push({
          channel: row.mapping.channel,
          channelUserId: row.mapping.channelUserId,
        });
      }
    }
    return [...byPerson.values()];
  }

  /**
   * Create a person and claim their channel identities, both or neither.
   *
   * An identity filed under the stranger sentinel is a dismissal rather than a
   * placement, so naming its sender releases it. An identity a real person
   * holds stays held: this refuses instead of stealing it, because creating a
   * person is not a re-point. The refusal is a rollback, not a partial write —
   * a person committed without their identity would be unreachable and
   * permanent, since {@link findByName} would then reject every retry as a
   * duplicate of the wreckage.
   */
  async create(data: {
    displayName: string;
    bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other";
    profilePath?: string;
    approved?: boolean;
    channelMappings?: { channel: string; channelUserId: string }[];
  }) {
    const id = await this.generatePersonId(data.displayName);

    const claims = await this.resolveClaims(data.channelMappings ?? []);

    this.db.transaction((tx) => {
      this.writePerson(tx, id, data);
      for (const claim of claims) this.writeClaim(tx, id, claim);
    });

    return id;
  }

  /**
   * Settle who may take each identity, before any transaction opens, so a
   * refusal can name the holder. An identity filed under the stranger sentinel
   * is a dismissal rather than a placement, so it is released to whoever names
   * its sender; one a real person holds is refused. The unique index still
   * backstops a rival claim landing between this read and the write.
   */
  private async resolveClaims(
    mappings: { channel: string; channelUserId: string; displayName?: string }[],
  ): Promise<ChannelClaim[]> {
    const claims: ChannelClaim[] = [];
    for (const mapping of mappings) {
      const held = await this.findChannelMapping(mapping.channel, mapping.channelUserId);
      if (held && held.personId !== STRANGER_PERSON_ID) {
        throw new Error(
          `Channel identity ${mapping.channel}:${mapping.channelUserId} already belongs to person "${held.personId}"`,
        );
      }
      claims.push({
        channel: mapping.channel,
        channelUserId: mapping.channelUserId,
        // The name belongs to the channel, so a caller with none to offer
        // carries the dismissed row's forward rather than clearing it.
        displayName: mapping.displayName ?? held?.displayName ?? null,
      });
    }
    return claims;
  }

  /** Take an identity {@link resolveClaims} cleared for this person. */
  private writeClaim(exec: SqliteExec, personId: string, claim: ChannelClaim): void {
    this.writeReleaseStrangerClaim(exec, claim.channel, claim.channelUserId);
    exec
      .insert(channelMappings)
      .values({ id: uuid(), personId, ...claim })
      .run();
  }

  /** The row holding a channel identity, or null when nobody holds it. */
  private async findChannelMapping(channel: string, channelUserId: string) {
    const rows = await this.db
      .select()
      .from(channelMappings)
      .where(
        and(eq(channelMappings.channel, channel), eq(channelMappings.channelUserId, channelUserId)),
      );
    return rows[0] ?? null;
  }

  /** Write helper for {@link createWithId}, taking an executor (see
   *  {@link writeChannelMapping}). */
  writePerson(exec: SqliteExec, id: string, data: NewPersonData): string {
    exec
      .insert(persons)
      .values({
        id,
        displayName: data.displayName,
        bondLevel: data.bondLevel,
        profilePath: data.profilePath ?? null,
        approved: data.approved ?? false,
        createdAt: new Date(),
      })
      .run();
    return id;
  }

  async createWithId(id: string, data: NewPersonData) {
    return this.writePerson(this.db, id, data);
  }

  /**
   * Create a person and its first channel mapping in one transaction. A person
   * with no mapping is unreachable — no inbound message resolves to it, and
   * there is no API to repair it — so the two writes must stand or fall
   * together. Used by `POST /api/persons/create`, where the guardian names an
   * unknown sender: the person exists precisely to give that channel account an
   * identity.
   *
   * Claims the identity on the same terms as {@link create}, refusing one a
   * real person already holds. The senders this route offers are unmapped by
   * construction, so reaching a held identity means a race or a stale page —
   * exactly where re-pointing would take the identity from whoever won.
   */
  async createWithChannelMapping(
    id: string,
    data: NewPersonData,
    mapping: { channel: string; channelUserId: string; displayName?: string },
  ) {
    const claims = await this.resolveClaims([mapping]);
    this.db.transaction((tx) => {
      this.writePerson(tx, id, data);
      for (const claim of claims) this.writeClaim(tx, id, claim);
    });
    return id;
  }

  async updatePerson(
    id: string,
    data: Partial<{
      displayName: string;
      bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other";
      profilePath: string | null;
      approved: boolean;
    }>,
  ) {
    await this.db.update(persons).set(data).where(eq(persons.id, id));
  }

  /** Write helper for {@link addChannelMapping}, taking an executor so it runs
   *  standalone (`this.db`) or enlisted in a caller's transaction (the terminal
   *  conferral maps the guardian in the SAME transaction as the credential
   *  write). */
  writeChannelMapping(
    exec: SqliteExec,
    personId: string,
    channel: string,
    channelUserId: string,
    displayName?: string,
  ): string {
    // Claiming an identity is one statement, not a read followed by a write:
    // `(channel, channel_user_id)` is unique, so a second writer re-points the
    // mapping instead of adding a rival one, whatever order the two arrive in.
    const row = exec
      .insert(channelMappings)
      .values({ id: uuid(), personId, channel, channelUserId, displayName: displayName ?? null })
      .onConflictDoUpdate({
        target: [channelMappings.channel, channelMappings.channelUserId],
        set: {
          personId,
          // The display name is the channel's, and every caller that has one
          // took it from an inbound message. A caller without one is reporting
          // no news, not a rename, so the stored name stands.
          displayName: sql`coalesce(excluded.${sql.raw(channelMappings.displayName.name)}, ${channelMappings.displayName})`,
        },
      })
      // Re-pointing keeps the existing row, whose id is not the one minted
      // above. Returning the row's own id keeps the reported mapping real.
      .returning({ id: channelMappings.id })
      .get();
    return row.id;
  }

  /** Release a channel identity that was only dismissed onto the stranger
   *  sentinel, so a caller naming its sender can claim it. Scoped to the
   *  sentinel deliberately: an identity a real person holds is a placement, and
   *  leaving it in place lets the unique index turn an attempt to take it into
   *  a rollback rather than a silent theft. */
  writeReleaseStrangerClaim(exec: SqliteExec, channel: string, channelUserId: string): void {
    exec
      .delete(channelMappings)
      .where(
        and(
          eq(channelMappings.channel, channel),
          eq(channelMappings.channelUserId, channelUserId),
          eq(channelMappings.personId, STRANGER_PERSON_ID),
        ),
      )
      .run();
  }

  async addChannelMapping(
    personId: string,
    channel: string,
    channelUserId: string,
    displayName?: string,
  ) {
    return this.writeChannelMapping(this.db, personId, channel, channelUserId, displayName);
  }

  /** Write helper for {@link updateChannelUserId}, taking an executor (see
   *  {@link writeChannelMapping}). Returns whether the identity moved, so a
   *  caller that decided on `from` earlier can tell that it is gone. */
  writeChannelUserId(
    exec: SqliteExec,
    personId: string,
    channel: string,
    from: string,
    to: string,
  ): boolean {
    // The row this call re-points, as a subquery so the guard runs inside the
    // caller's transaction rather than as a read before it (see
    // {@link writeDeleteGuardianChannelMappings}).
    const rePointed = this.db
      .select({ id: channelMappings.id })
      .from(channelMappings)
      .where(
        and(
          eq(channelMappings.personId, personId),
          eq(channelMappings.channel, channel),
          eq(channelMappings.channelUserId, from),
        ),
      );

    // A rival holding `to` yields it, which is where {@link writeChannelMapping}'s
    // upsert lands a claim on the same identity. Re-pointing onto a held
    // identifier would otherwise collide on the identity index and abort the
    // caller's transaction — the one outcome a claim on this path must not have,
    // since that transaction also carries the credential.
    //
    // Only a rival's. This person holding `to` themselves is a second account of
    // theirs, not a claim to settle, and deleting it here would merge two of
    // their identities into one. Conditioned, too, on the re-pointed row still
    // being there: a `from` that went away leaves the rival holding an identity
    // nothing is about to take.
    exec
      .delete(channelMappings)
      .where(
        and(
          eq(channelMappings.channel, channel),
          eq(channelMappings.channelUserId, to),
          ne(channelMappings.personId, personId),
          exists(rePointed),
        ),
      )
      .run();

    // Whoever still holds `to` after that yield is this person, so the re-point
    // has nothing left to do and says so rather than colliding on the index.
    const stillHeld = this.db
      .select({ id: channelMappings.id })
      .from(channelMappings)
      .where(and(eq(channelMappings.channel, channel), eq(channelMappings.channelUserId, to)));

    // Scoped to the one identity being re-pointed, not to every identity the
    // person holds on the channel: a person may hold several there, and moving
    // them all onto `to` would collide on the identity index too.
    const result = exec
      .update(channelMappings)
      .set({ channelUserId: to })
      .where(
        and(
          eq(channelMappings.personId, personId),
          eq(channelMappings.channel, channel),
          eq(channelMappings.channelUserId, from),
          notExists(stillHeld),
        ),
      )
      .run();
    return result.changes > 0;
  }

  /**
   * Repoint one of a person's channel identities onto a new identifier, leaving
   * their other identities on that channel alone. Used to heal a stale guardian
   * self JID (e.g. a device-suffixed WhatsApp id captured before
   * canonicalization) onto its canonical form on reconnect.
   *
   * Takes `to` from whoever else holds it, on the same terms as
   * {@link writeChannelMapping}: this is the channel reporting the identifier
   * its account answers to now, so a rival claim on it is the stale one.
   * Returns false when the person does not hold `from`, having moved nothing.
   */
  async updateChannelUserId(personId: string, channel: string, from: string, to: string) {
    return this.writeChannelUserId(this.db, personId, channel, from, to);
  }

  async deleteChannelMapping(channel: string, channelUserId: string) {
    await this.db
      .delete(channelMappings)
      .where(
        and(eq(channelMappings.channel, channel), eq(channelMappings.channelUserId, channelUserId)),
      );
  }

  /**
   * Remove only guardian identities for a channel after its Talk grant is
   * explicitly disconnected. Other people mappings remain curated data, and
   * transient transport faults never call this path.
   */
  async deleteGuardianChannelMappings(channel: string): Promise<void> {
    this.writeDeleteGuardianChannelMappings(this.db, channel);
  }

  /**
   * Synchronous form of {@link deleteGuardianChannelMappings} for enlistment in
   * a better-sqlite3 transaction (e.g. connection teardown), so the guardian
   * mapping cleanup commits atomically with the connection/grant deletion rather
   * than as a separate best-effort write that can strand the mapping on failure.
   * The guardian-id lookup is inlined as a subquery, so nothing executes outside
   * `exec`.
   */
  writeDeleteGuardianChannelMappings(exec: SqliteExec, channel: string): void {
    const guardianIds = this.db
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.bondLevel, "guardian"));

    exec
      .delete(channelMappings)
      .where(
        and(eq(channelMappings.channel, channel), inArray(channelMappings.personId, guardianIds)),
      )
      .run();
  }

  async reassignChannelMapping(channel: string, channelUserId: string, newPersonId: string) {
    await this.db
      .update(channelMappings)
      .set({ personId: newPersonId })
      .where(
        and(eq(channelMappings.channel, channel), eq(channelMappings.channelUserId, channelUserId)),
      );
  }
}

export function createPersonMappingRepository(db: DrizzleDb) {
  return new PersonMappingRepository(db);
}
