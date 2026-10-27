import { Router } from "express";
import { FilterQuery, HydratedDocument, Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { AccountDoc, CategoryDoc, Contact, Group, GroupDoc, Transaction, TransactionDoc, User } from "../../models";
import { accountLabel } from "../accounts/accounts.label";
import { normalisePhone } from "../contacts/contacts.people";
import {
  GROUP_AMOUNT,
  GroupOpeningError,
  GroupPaymentError,
  assertGroupMember,
  autoAdds,
  claimTransactions,
  createPaidByContact,
  dropContactOpenings,
  generateJoinCode,
  groupOpeningsJson,
  groupSettlement,
  groupSpendSummary,
  isGroupRunning,
  resyncGroup,
  runningAt,
  setOpenings,
  syncGroupSplit,
} from "./groups.service";
import { isLikelyTravel } from "./groups.travel";
import { noteJoined } from "./groups.notify";

/**
 * Groups: people who share spending - "Goa trip", "Flatmates", "Office
 * lunch" - with SpendLog users and contacts alike in them.
 *
 * The same router answers on /groups and, for one release, on /trips,
 * where an app from before groups still calls it. `legacy` keeps the few
 * things such an app relied on meaning what they meant: isActive is
 * "running" (trip mode), /active is the one running trip, and starting a
 * second running trip is refused.
 */
export function buildGroupsRouter(options: { legacy: boolean }): Router {
  const { legacy } = options;
  const router = Router();
  router.use(requireAuth);

  /** A group as the clients get it. */
  function groupJson(group: HydratedDocument<GroupDoc>, extra: Record<string, unknown> = {}) {
    const json = group.toJSON() as Record<string, unknown>;
    // Named and turned to the viewer's side where they are shown (detail,
    // summary), never as stored.
    delete json.openingBalances;
    return {
      ...json,
      // An app from before groups reads a start date on every trip.
      ...(legacy && !group.startedAt ? { startedAt: group.createdAt } : {}),
      isActive: legacy ? isGroupRunning(group) : !group.archivedAt,
      isArchived: Boolean(group.archivedAt),
      isRunning: isGroupRunning(group),
      autoAdds: autoAdds(group),
      memberCount: group.members.length + (group.contactMembers?.length ?? 0),
      ...extra,
    };
  }

  /** Totals per group, so a list means something without opening each one. */
  async function withTotals(groups: HydratedDocument<GroupDoc>[]) {
    const totals = await Transaction.aggregate<{ _id: Types.ObjectId; total: number; count: number }>([
      { $match: { groupId: { $in: groups.map((g) => g._id) }, type: "DEBIT", mirrorOf: null } },
      { $group: { _id: "$groupId", total: { $sum: GROUP_AMOUNT }, count: { $sum: 1 } } },
    ]);
    return groups.map((group) => {
      const totalsFor = totals.find((t) => t._id.equals(group._id));
      return groupJson(group, { totalMinor: totalsFor?.total ?? 0, transactionCount: totalsFor?.count ?? 0 });
    });
  }

  /** The group with who is in it, named, from the caller's side. */
  async function detailJson(group: HydratedDocument<GroupDoc>, userId: Types.ObjectId) {
    const contactIds = group.contactMembers.map((m) => m.contactId);
    const [users, contacts, openingBalances] = await Promise.all([
      User.find({ _id: { $in: [...group.members.map((m) => m.userId), ...group.contactMembers.map((m) => m.addedBy)] } })
        .select("name email")
        .lean(),
      Contact.find({ _id: { $in: contactIds } }).select("name phone").lean(),
      groupOpeningsJson(group, userId),
    ]);
    const nameOfUser = (id: Types.ObjectId) => {
      const user = users.find((u) => u._id.equals(id));
      return user?.name ?? user?.email ?? "Someone";
    };

    return groupJson(group, {
      members: group.members.map((member) => ({
        id: member.userId.toString(),
        kind: "user",
        userId: member.userId,
        joinedAt: member.joinedAt,
        name: nameOfUser(member.userId),
        isOwner: group.ownerId.equals(member.userId),
        isMe: member.userId.equals(userId),
      })),
      contacts: group.contactMembers.map((member) => {
        const contact = contacts.find((c) => c._id.equals(member.contactId));
        return {
          id: member.contactId.toString(),
          kind: "contact",
          contactId: member.contactId,
          joinedAt: member.joinedAt,
          name: contact?.name ?? "Someone",
          phone: member.addedBy.equals(userId) ? (contact?.phone ?? null) : null,
          addedBy: member.addedBy,
          addedByName: nameOfUser(member.addedBy),
          isMine: member.addedBy.equals(userId),
        };
      }),
      openingBalances,
    });
  }

  // GET / — every group the user is in: the active ones first, newest
  // first, then the archived.
  router.get("/", async (req, res) => {
    const userId = currentUserId(req);
    const groups = await Group.find({ "members.userId": userId });
    const when = (g: GroupDoc) => (g.startedAt ?? g.createdAt).getTime();
    groups.sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)) || when(b) - when(a));
    res.json(await withTotals(groups));
  });

  // GET /active — every group not archived, for the editor to offer. On
  // the old /trips path, the one running trip, or null.
  router.get("/active", async (req, res) => {
    const userId = currentUserId(req);
    if (legacy) {
      const trip = await Group.findOne({ "members.userId": userId, ...runningAt() }).sort({ startedAt: -1 });
      return res.json(trip ? groupJson(trip, { isActive: true }) : null);
    }
    const groups = await Group.find({ "members.userId": userId, archivedAt: null }).sort({ updatedAt: -1 });
    res.json(groups.map((group) => groupJson(group)));
  });

  const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

  /**
   * One opening balance, from the setter's side. A contact is named by
   * contactId and a SpendLog user by userId; `memberId` names either, for a
   * client that keeps one list of everyone.
   */
  const openingSchema = z
    .object({
      memberKind: z.enum(["contact", "user"]),
      contactId: z.string().regex(OBJECT_ID).nullable().optional(),
      userId: z.string().regex(OBJECT_ID).nullable().optional(),
      memberId: z.string().regex(OBJECT_ID).optional(),
      direction: z.enum(["owes_me", "i_owe"]),
      amountMinor: z.number().int().min(0).max(1_000_000_000_00),
      note: z.string().trim().max(200).nullable().optional(),
    })
    .transform(({ memberId, ...entry }) => ({
      ...entry,
      contactId: entry.memberKind === "contact" ? (entry.contactId ?? memberId ?? null) : null,
      userId: entry.memberKind === "user" ? (entry.userId ?? memberId ?? null) : null,
    }));
  const openingsSchema = z.array(openingSchema).max(100);

  const createGroupSchema = z.object({
    name: z.string().trim().min(1).max(80),
    startedAt: z.coerce.date().nullable().optional(),
    endedAt: z.coerce.date().nullable().optional(),
    /** Contacts of the caller's to put in it from the start. */
    contactIds: z.array(z.string().regex(OBJECT_ID)).max(50).optional(),
    /** What was already owed with each of them when the group began here. */
    openingBalances: openingsSchema.optional(),
  });

  // POST / — a new group, with whoever of the caller's contacts is in it.
  // Nothing goes into it by itself: payments are picked for it.
  router.post("/", async (req, res) => {
    const parsed = createGroupSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const userId = currentUserId(req);

    // An old app's "Start a trip" is a switch, and it was refused while
    // another trip was running. Kept on that path only.
    if (legacy) {
      const running = await Group.findOne({ ownerId: userId, ...runningAt() });
      if (running) {
        return res.status(409).json({
          error: `"${running.name}" is still running. End it before starting another.`,
          tripId: running.id,
        });
      }
    }

    const startedAt = parsed.data.startedAt !== undefined ? parsed.data.startedAt : legacy ? new Date() : null;
    const endedAt = parsed.data.endedAt ?? null;
    if (startedAt && endedAt && endedAt < startedAt) {
      return res.status(400).json({ error: "A group cannot end before it starts" });
    }

    const contactIds = [...new Set(parsed.data.contactIds ?? [])];
    if (contactIds.length > 0) {
      const owned = await Contact.countDocuments({ userId, _id: { $in: contactIds } });
      if (owned !== contactIds.length) return res.status(400).json({ error: "Unknown contact" });
    }

    const now = new Date();
    const group = new Group({
      ownerId: userId,
      name: parsed.data.name,
      startedAt,
      endedAt,
      archivedAt: null,
      members: [{ userId, joinedAt: now }],
      contactMembers: contactIds.map((contactId) => ({ contactId, addedBy: userId, joinedAt: now })),
      joinCode: generateJoinCode(),
    });
    if (parsed.data.openingBalances?.length) {
      try {
        setOpenings(group, userId, parsed.data.openingBalances);
      } catch (error) {
        if (error instanceof GroupOpeningError) return res.status(400).json({ error: error.message });
        throw error;
      }
    }
    await group.save();

    res.status(201).json(groupJson(group, { claimedCount: 0, totalMinor: 0, transactionCount: 0 }));
  });

  const updateGroupSchema = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    startedAt: z.coerce.date().nullable().optional(),
    endedAt: z.coerce.date().nullable().optional(),
    /** true archives it, false brings it back. */
    archived: z.boolean().optional(),
  });

  /** Dates moved on a group that takes payments in by its dates: re-claimed. */
  async function afterDates(group: HydratedDocument<GroupDoc>) {
    return autoAdds(group) ? claimTransactions(group) : 0;
  }

  router.patch("/:id", validObjectIdParam("id"), async (req, res) => {
    const parsed = updateGroupSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const userId = currentUserId(req);
    const group = await Group.findOne({ _id: req.params.id, ownerId: userId });
    if (!group) return res.status(404).json({ error: "Not found" });

    if (parsed.data.name !== undefined) group.name = parsed.data.name;
    if (parsed.data.startedAt !== undefined) group.startedAt = parsed.data.startedAt;
    if (parsed.data.endedAt !== undefined) group.endedAt = parsed.data.endedAt;
    if (parsed.data.archived !== undefined) group.archivedAt = parsed.data.archived ? (group.archivedAt ?? new Date()) : null;

    if (group.endedAt && group.startedAt && group.endedAt < group.startedAt) {
      return res.status(400).json({ error: "A group cannot end before it starts" });
    }

    await group.save();
    const claimed = await afterDates(group);
    res.json(groupJson(group, { claimedCount: claimed }));
  });

  // POST /:id/archive and /:id/unarchive — a group is active, and offered
  // in the editor, until its owner archives it. Nothing on it changes.
  for (const [action, archived] of [
    ["archive", true],
    ["unarchive", false],
  ] as const) {
    router.post(`/:id/${action}`, validObjectIdParam("id"), async (req, res) => {
      const group = await Group.findOne({ _id: req.params.id, ownerId: currentUserId(req) });
      if (!group) return res.status(404).json({ error: "Not found" });
      group.archivedAt = archived ? (group.archivedAt ?? new Date()) : null;
      await group.save();
      res.json(groupJson(group));
    });
  }

  // DELETE /:id — the group goes, the spending stays. Nobody's ledger
  // should lose rows because a label was removed; what the group split
  // with its contacts goes back to being the payer's own.
  router.delete("/:id", validObjectIdParam("id"), async (req, res) => {
    const group = await Group.findOne({ _id: req.params.id, ownerId: currentUserId(req) });
    if (!group) return res.status(404).json({ error: "Not found" });

    // The shares of its payments written into other members' ledgers go
    // with it: they were only ever the group's arithmetic.
    await Transaction.deleteMany({ groupId: group._id, mirrorOf: { $ne: null } });
    const split = await Transaction.find({ groupId: group._id, groupSplit: true, offLedger: { $ne: true } });
    for (const row of split) {
      row.groupId = null;
      await syncGroupSplit(row, null);
    }
    await Transaction.updateMany({ groupId: group._id }, { $set: { groupId: null } });
    await group.deleteOne();

    res.status(204).end();
  });

  // POST /:id/rescan — for a group that takes payments in by its dates,
  // sweeps the window for anything not already in it: a phone that was
  // offline, a start date moved earlier. Any other group has nothing to
  // sweep.
  router.post("/:id/rescan", validObjectIdParam("id"), async (req, res) => {
    const group = await assertGroupMember(req.params.id, currentUserId(req));
    if (!group) return res.status(404).json({ error: "Not found" });

    const claimed = autoAdds(group) ? await claimTransactions(group, currentUserId(req)) : 0;
    res.json({ claimedCount: claimed });
  });

  // GET /:id/summary — what the group cost, and where it went.
  router.get("/:id/summary", validObjectIdParam("id"), async (req, res) => {
    const userId = currentUserId(req);
    const group = await assertGroupMember(req.params.id, userId);
    if (!group) return res.status(404).json({ error: "Not found" });

    const json = groupJson(group);
    const [spend, openingBalances] = await Promise.all([groupSpendSummary(group), groupOpeningsJson(group, userId)]);
    res.json({ group: json, trip: json, ...spend, openingBalances });
  });

  const putOpeningsSchema = z.object({ openingBalances: openingsSchema });

  // PUT /:id/openings — everything the caller says was owed between them
  // and the others when the group began here: "Rahul owes me 1,200", "I owe
  // Priya 450". Replaces all of the caller's own (an empty list takes them
  // all away); nobody else's are touched. Not spending or income: only
  // who owes whom moves - the group's settlement and, with a contact, the
  // caller's People balance.
  router.put("/:id/openings", validObjectIdParam("id"), async (req, res) => {
    const parsed = putOpeningsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const userId = currentUserId(req);
    const group = await assertGroupMember(req.params.id, userId);
    if (!group) return res.status(404).json({ error: "Not found" });

    try {
      setOpenings(group, userId, parsed.data.openingBalances);
    } catch (error) {
      if (error instanceof GroupOpeningError) return res.status(400).json({ error: error.message });
      throw error;
    }
    await group.save();

    res.json(await detailJson(group, userId));
  });

  // GET /:id/transactions — everyone's spending in the group.
  router.get("/:id/transactions", validObjectIdParam("id"), async (req, res) => {
    const userId = currentUserId(req);
    const group = await assertGroupMember(req.params.id, userId);
    if (!group) return res.status(404).json({ error: "Not found" });

    // Without the mirrors: each is one member's share of a payment that is
    // already in the list, from its payer's side.
    const transactions = await Transaction.find({ groupId: group._id, mirrorOf: null })
      .sort({ occurredAt: -1 })
      .limit(500)
      .populate("category")
      .populate("account")
      .populate<{ paidByContact: { name: string } | null }>("paidByContact", "name")
      .populate<{ userId: { _id: Types.ObjectId; name?: string | null; email: string } }>({
        path: "userId",
        select: "name email",
      });

    // userId is the owner's name once populated, so whether a row is the
    // caller's own - the only ones they can edit or take out - is said
    // here, and who actually paid next to it.
    res.json(
      transactions.map((row) => ({
        ...row.toJSON(),
        isMine: Boolean(row.userId?._id?.equals(userId)),
        paidByName: row.paidByContact?.name ?? row.userId?.name ?? row.userId?.email ?? "Someone",
      }))
    );
  });

  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Enough to scroll through; a search narrows anything past it. */
  const CANDIDATE_LIMIT = 300;

  const candidatesQuerySchema = z.object({
    // How far back to look: before the start, for a dated group (tickets
    // are often booked months out), or from today for one without dates.
    // A year at most; asking for more gets a year rather than an error.
    days: z.coerce
      .number()
      .int()
      .min(0)
      .default(60)
      .transform((days) => Math.min(days, 365)),
    q: z.string().trim().max(80).optional(),
  });

  /** Escapes regex metacharacters so a search term can't alter the pattern. */
  function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // GET /:id/candidates — the caller's own payments that could be put in
  // the group by hand.
  //
  // Only the caller's, never another member's: adding a payment to a group
  // publishes it to everyone in it, and that is each person's own call.
  router.get("/:id/candidates", validObjectIdParam("id"), async (req, res) => {
    const parsed = candidatesQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const userId = currentUserId(req);
    const group = await assertGroupMember(req.params.id, userId);
    if (!group) return res.status(404).json({ error: "Not found" });

    const from = group.startedAt ?? new Date();
    const filter: FilterQuery<TransactionDoc> = {
      userId,
      type: "DEBIT",
      // In no group yet. Moving a payment between groups is the edit
      // sheet's job, where the group it is leaving is in plain sight.
      groupId: null,
      // Money that only moved between the user's own accounts, or paid off a
      // card whose purchases are already here, was never group spending.
      isTransfer: { $ne: true },
      cardPaymentFor: null,
      occurredAt: { $gte: new Date(from.getTime() - parsed.data.days * DAY_MS), $lte: new Date() },
    };
    if (parsed.data.q) {
      const term = { $regex: escapeRegex(parsed.data.q), $options: "i" };
      filter.$or = [{ merchant: term }, { note: term }];
    }

    const rows = await Transaction.find(filter)
      .sort({ occurredAt: -1 })
      .limit(CANDIDATE_LIMIT)
      .populate<{ category: CategoryDoc | null }>("category")
      .populate<{ account: AccountDoc | null }>("account");

    const candidates = rows.map((row) => {
      const categoryName = row.category?.name ?? null;
      return {
        id: row.id as string,
        occurredAt: row.occurredAt,
        merchant: row.merchant ?? null,
        amountMinor: row.amountMinor,
        accountLabel: row.account ? accountLabel(row.account) : null,
        categoryName,
        likelyTravel: isLikelyTravel({ merchant: row.merchant, categoryName }),
      };
    });

    // The tickets and rooms first, each half still newest first - sort() is
    // stable, so the order from the query survives within each.
    candidates.sort((a, b) => Number(b.likelyTravel) - Number(a.likelyTravel));

    res.json(candidates);
  });

  const addSchema = z.object({
    transactionIds: z.array(z.string().regex(OBJECT_ID)).min(1).max(500),
  });

  // POST /:id/add — puts payments in the group by hand, whatever their
  // dates.
  //
  // Marked as edited, the same as an edit sheet's save, so no re-scan or
  // change of dates ever takes them back out. Only the caller's own rows
  // move; anything else in the list is counted as skipped rather than
  // refused outright, so one stale id does not lose the rest.
  router.post("/:id/add", validObjectIdParam("id"), async (req, res) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const userId = currentUserId(req);
    const group = await assertGroupMember(req.params.id, userId);
    if (!group) return res.status(404).json({ error: "Not found" });

    const ids = [...new Set(parsed.data.transactionIds)];
    const own = await Transaction.find({ _id: { $in: ids }, userId });
    for (const row of own) {
      if (row.groupId?.equals(group._id)) continue;
      // A payment somebody else made belongs to the group it was made in.
      if (row.offLedger) continue;
      row.groupId = group._id;
      // "Just me" was said about whichever group it was in before, and
      // names people who may not be in this one.
      row.groupShareWith = null;
      row.groupShareAmounts = null;
      row.editedAt = new Date();
      await row.save();
      await syncGroupSplit(row, group);
    }

    res.json({ added: own.length, skipped: ids.length - own.length });
  });

  const paymentSchema = z.object({
    paidBy: z.object({ contactId: z.string().regex(OBJECT_ID) }),
    amountMinor: z.number().int().positive(),
    occurredAt: z.coerce.date(),
    merchant: z.string().trim().max(120).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    categoryId: z.string().regex(OBJECT_ID).nullable().optional(),
    currency: z.string().min(1).max(8).optional(),
    /** null: everyone equally. [own user id]: just mine. Any members: equal among them. */
    shareWith: z.array(z.string().regex(OBJECT_ID)).max(100).nullable().optional(),
    // Each member's part, typed by hand instead of equal.
    shareAmounts: z
      .array(z.object({ memberId: z.string().regex(OBJECT_ID), amountMinor: z.number().int().min(0) }))
      .max(100)
      .nullable()
      .optional(),
  });

  // POST /:id/payments — a payment somebody else made for the group:
  // "Rahul paid 2,000 for dinner". The caller's share counts as their
  // spending and is owed to Rahul; no account of theirs moves.
  router.post("/:id/payments", validObjectIdParam("id"), async (req, res) => {
    const parsed = paymentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const userId = currentUserId(req);
    const group = await assertGroupMember(req.params.id, userId);
    if (!group) return res.status(404).json({ error: "Not found" });

    try {
      const created = await createPaidByContact(userId, group, {
        contactId: parsed.data.paidBy.contactId,
        amountMinor: parsed.data.amountMinor,
        occurredAt: parsed.data.occurredAt,
        merchant: parsed.data.merchant || null,
        note: parsed.data.note || null,
        categoryId: parsed.data.categoryId ?? null,
        currency: parsed.data.currency,
        shareWith: parsed.data.shareWith,
        shareAmounts: parsed.data.shareAmounts,
      });
      const tx = await Transaction.findById(created._id)
        .populate("category")
        .populate("account")
        .populate("group")
        .populate("paidByContact", "name");
      res.status(201).json(tx);
    } catch (error) {
      if (error instanceof GroupPaymentError) return res.status(400).json({ error: error.message });
      throw error;
    }
  });

  const addContactSchema = z.union([
    z.object({ contactId: z.string().regex(OBJECT_ID) }),
    z.object({ name: z.string().trim().min(1).max(80), phone: z.string().max(30).nullable().optional() }),
  ]);

  // POST /:id/contacts — someone without SpendLog, from the caller's own
  // contacts, or typed in or picked off the phone (made a contact on the
  // way, the same as on the People page). Their share of what the caller
  // pays in the group is owed to the caller.
  router.post("/:id/contacts", validObjectIdParam("id"), async (req, res) => {
    const parsed = addContactSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Pick a contact, or give them a name." });

    const userId = currentUserId(req);
    const group = await assertGroupMember(req.params.id, userId);
    if (!group) return res.status(404).json({ error: "Not found" });

    let contactId: Types.ObjectId;
    if ("contactId" in parsed.data) {
      const contact = await Contact.findOne({ _id: parsed.data.contactId, userId }).select("_id");
      if (!contact) return res.status(400).json({ error: "Unknown contact" });
      contactId = contact._id;
    } else {
      const phone = normalisePhone(parsed.data.phone);
      const existing = phone ? await Contact.findOne({ userId, phone }).select("_id") : null;
      contactId = existing?._id ?? (await Contact.create({ userId, name: parsed.data.name, phone }))._id;
    }

    if (group.contactMembers.some((member) => member.contactId.equals(contactId))) {
      return res.json(await detailJson(group, userId));
    }

    group.contactMembers.push({ contactId, addedBy: userId, joinedAt: new Date() });
    await group.save();
    await resyncGroup(group._id);

    res.status(201).json(await detailJson(group, userId));
  });

  // DELETE /:id/contacts/:contactId — a contact out of the group, by whoever
  // added them or the owner. Their share of everything is worked out again
  // among whoever is left; payments they made stay.
  router.delete(
    "/:id/contacts/:contactId",
    validObjectIdParam("id"),
    validObjectIdParam("contactId"),
    async (req, res) => {
      const userId = currentUserId(req);
      const group = await assertGroupMember(req.params.id, userId);
      if (!group) return res.status(404).json({ error: "Not found" });

      const member = group.contactMembers.find((m) => m.contactId.equals(req.params.contactId));
      if (!member) return res.status(404).json({ error: "Not found" });
      if (!member.addedBy.equals(userId) && !group.ownerId.equals(userId)) {
        return res.status(403).json({ error: "Only whoever added them, or the group's owner, can take them out." });
      }

      group.contactMembers = group.contactMembers.filter((m) => !m.contactId.equals(member.contactId));
      // What was owed with them when the group began goes with them, as
      // their shares of its payments do.
      dropContactOpenings(group, member.contactId);
      await group.save();
      await resyncGroup(group._id);

      res.status(204).end();
    }
  );

  // GET /:id — the group and who is in it.
  router.get("/:id", validObjectIdParam("id"), async (req, res) => {
    const userId = currentUserId(req);
    const group = await assertGroupMember(req.params.id, userId);
    if (!group) return res.status(404).json({ error: "Not found" });

    res.json(await detailJson(group, userId));
  });

  const joinSchema = z.object({
    code: z.string().min(4).max(12),
  });

  // POST /join — the other half of a code read out or scanned.
  //
  // Joining shares the group from this moment on. It deliberately does not
  // reach back and hand over what was already spent: someone joining on day
  // three has agreed to share a holiday, not to publish the week before it.
  // Their earlier payments can still be added on purpose (POST /:id/add).
  router.post("/join", async (req, res) => {
    const parsed = joinSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const userId = currentUserId(req);
    const group = await Group.findOne({ joinCode: parsed.data.code.trim().toUpperCase() });
    if (!group) return res.status(404).json({ error: `No ${legacy ? "trip" : "group"} with that code` });

    if (group.members.some((member) => member.userId.equals(userId))) {
      return res.json(groupJson(group, { alreadyJoined: true }));
    }

    group.members.push({ userId, joinedAt: new Date() });
    await group.save();
    // One more person to share everything with.
    await resyncGroup(group._id);
    if (!group.ownerId.equals(userId)) {
      const joiner = await User.findById(userId).select("name email").lean();
      noteJoined(group.ownerId, joiner?.name ?? joiner?.email ?? "Someone", group);
    }

    res.json(groupJson(group, { alreadyJoined: false }));
  });

  // POST /:id/rotate-code — for a code that has ended up somewhere it
  // should not have. Everyone already in the group stays in it.
  router.post("/:id/rotate-code", validObjectIdParam("id"), async (req, res) => {
    const group = await Group.findOne({ _id: req.params.id, ownerId: currentUserId(req) });
    if (!group) return res.status(404).json({ error: "Not found" });

    group.joinCode = generateJoinCode();
    await group.save();

    res.json({ joinCode: group.joinCode });
  });

  // POST /:id/leave — stop seeing a group someone else owns.
  //
  // What they spent stays in it: the total should not quietly drop
  // because a person walked away. The owner cannot leave, since somebody
  // has to be able to archive or delete it.
  router.post("/:id/leave", validObjectIdParam("id"), async (req, res) => {
    const userId = currentUserId(req);
    const group = await assertGroupMember(req.params.id, userId);
    if (!group) return res.status(404).json({ error: "Not found" });

    if (group.ownerId.equals(userId)) {
      return res
        .status(400)
        .json({ error: `You started this ${legacy ? "trip" : "group"}. Archive or delete it instead.` });
    }

    group.members = group.members.filter((member) => !member.userId.equals(userId));
    await group.save();
    await resyncGroup(group._id);

    res.status(204).end();
  });

  // DELETE /:id/members/:memberId — the owner removing a SpendLog user.
  router.delete(
    "/:id/members/:memberId",
    validObjectIdParam("id"),
    validObjectIdParam("memberId"),
    async (req, res) => {
      const userId = currentUserId(req);
      const group = await Group.findOne({ _id: req.params.id, ownerId: userId });
      if (!group) return res.status(404).json({ error: "Not found" });

      if (group.ownerId.equals(new Types.ObjectId(req.params.memberId))) {
        return res.status(400).json({ error: `The owner cannot be removed from their own ${legacy ? "trip" : "group"}` });
      }

      group.members = group.members.filter((member) => !member.userId.equals(new Types.ObjectId(req.params.memberId)));
      await group.save();
      await resyncGroup(group._id);

      res.status(204).end();
    }
  );

  // GET /:id/settlement — who owes whom, and the payments that square it
  // off. The arithmetic and its rules live in groupSettlement.
  router.get("/:id/settlement", validObjectIdParam("id"), async (req, res) => {
    const userId = currentUserId(req);
    const group = await assertGroupMember(req.params.id, userId);
    if (!group) return res.status(404).json({ error: "Not found" });

    res.json(await groupSettlement(group, userId));
  });

  return router;
}

export const groupsRouter = buildGroupsRouter({ legacy: false });
/** The same, on /trips, for apps from before groups. One release. */
export const tripsRouter = buildGroupsRouter({ legacy: true });
