import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Contact, ContactClearance, Transaction } from "../../models";
import { Balance, NO_BALANCE, balances, normalisePhone } from "./contacts.people";

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

/**
 * The people money moves between: who has been lent what, who has paid
 * what back, and so who still owes how much.
 */

/**
 * A person with where they stand: whatever was owed before SpendLog was
 * keeping track, plus everything their transactions have added since.
 */
function withBalance(contact: InstanceType<typeof Contact>, owed: Balance | undefined) {
  const fromTransactions = owed ?? NO_BALANCE;
  const opening = contact.openingBalanceMinor ?? 0;
  return {
    ...contact.toJSON(),
    ...fromTransactions,
    openingBalanceMinor: opening,
    balanceMinor: opening + fromTransactions.balanceMinor,
  };
}

// GET /contacts — everyone, with where they stand. Whoever owes most
// first, then whoever is owed, then everyone square, by name.
contactsRouter.get("/", async (req, res) => {
  const userId = currentUserId(req);
  const [contacts, owed] = await Promise.all([Contact.find({ userId }).sort({ name: 1 }), balances(userId)]);

  const rows = contacts.map((contact) => withBalance(contact, owed.get(contact._id.toString())));
  rows.sort((a, b) => Math.abs(b.balanceMinor) - Math.abs(a.balanceMinor) || a.name.localeCompare(b.name));

  const owedToYou = rows.filter((row) => row.balanceMinor > 0).reduce((sum, row) => sum + row.balanceMinor, 0);
  const youOwe = rows.filter((row) => row.balanceMinor < 0).reduce((sum, row) => sum - row.balanceMinor, 0);

  res.json({ owedToYouMinor: owedToYou, youOweMinor: youOwe, contacts: rows });
});

const contactSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().max(30).nullable().optional(),
  /// Owed before any transaction here: positive they owe you, negative you
  /// owe them.
  openingBalanceMinor: z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00).optional(),
});

// POST /contacts — add someone, typed in or picked off the phone. Picking
// the same number twice gives back the one already here rather than a
// second person with half the history each.
contactsRouter.post("/", async (req, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give them a name." });

  const userId = currentUserId(req);
  const phone = normalisePhone(parsed.data.phone);

  if (phone) {
    const existing = await Contact.findOne({ userId, phone });
    if (existing) {
      const owed = await balances(userId, [existing._id]);
      return res.status(200).json({ ...withBalance(existing, owed.get(existing._id.toString())), existing: true });
    }
  }

  const created = await Contact.create({
    userId,
    name: parsed.data.name,
    phone,
    openingBalanceMinor: parsed.data.openingBalanceMinor ?? 0,
  });
  res.status(201).json(withBalance(created, undefined));
});

// GET /contacts/:id — one person, their balance, and every transaction
// they are on, newest first, with their part of each.
contactsRouter.get("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const contact = await Contact.findOne({ _id: req.params.id, userId });
  if (!contact) return res.status(404).json({ error: "Not found" });

  const [owed, transactions, clearances] = await Promise.all([
    balances(userId, [contact._id]),
    Transaction.find({ userId, "people.contactId": contact._id })
      .sort({ occurredAt: -1 })
      .limit(200)
      .populate("category")
      .populate("account"),
    ContactClearance.find({ userId, contactId: contact._id }).sort({ on: -1, createdAt: -1 }).limit(200),
  ]);

  res.json({
    ...withBalance(contact, owed.get(contact._id.toString())),
    history: transactions.map((transaction) => ({
      transaction,
      // Their part: positive when it added to what they owe, negative when
      // it paid some of it back.
      amountMinor:
        (transaction.people.find((person) => person.contactId.equals(contact._id))?.amountMinor ?? 0) *
        (transaction.type === "DEBIT" ? 1 : -1),
    })),
    // Apart from the history rather than in it, so an app from before
    // clearances still finds a transaction on every history row. Signed
    // the same way: negative when it cleared some of what they owed.
    clearances: clearances.map((clearance) => ({
      ...clearance.toJSON(),
      effectMinor: clearance.direction === "OWED_TO_ME" ? -clearance.amountMinor : clearance.amountMinor,
    })),
  });
});

/** Rupees the way the apps show them: ₹1,000, or ₹999.50 when there are paise. */
function rupees(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

const clearSchema = z.object({
  amountMinor: z.number().int().positive(),
  note: z.string().trim().max(200).nullable().optional(),
  // The day it was settled; today when not given.
  on: z.coerce.date().optional(),
});

// POST /contacts/:id/clear — part or all of what is owed, either way,
// settled without money moving: a watch bought instead of the 1,000 owed.
// Always towards zero, and never past it.
contactsRouter.post("/:id/clear", validObjectIdParam("id"), async (req, res) => {
  const parsed = clearSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter an amount greater than zero." });

  const userId = currentUserId(req);
  const contact = await Contact.findOne({ _id: req.params.id, userId });
  if (!contact) return res.status(404).json({ error: "Not found" });

  const before = withBalance(contact, (await balances(userId, [contact._id])).get(contact._id.toString()));
  const outstanding = before.balanceMinor;
  if (outstanding === 0) {
    return res.status(400).json({ error: `Nothing is owed either way with ${contact.name}.` });
  }
  if (parsed.data.amountMinor > Math.abs(outstanding)) {
    const owing =
      outstanding > 0
        ? `${contact.name} owes you ${rupees(outstanding)}`
        : `You owe ${contact.name} ${rupees(-outstanding)}`;
    return res.status(400).json({ error: `${owing} — you can clear up to that much, not more.` });
  }

  const clearance = await ContactClearance.create({
    userId,
    contactId: contact._id,
    amountMinor: parsed.data.amountMinor,
    direction: outstanding > 0 ? "OWED_TO_ME" : "OWED_BY_ME",
    note: parsed.data.note || null,
    on: parsed.data.on ?? new Date(),
  });

  const owed = await balances(userId, [contact._id]);
  res.status(201).json({ ...withBalance(contact, owed.get(contact._id.toString())), clearance });
});

// DELETE /contacts/:id/clear/:clearanceId — undo a clearance; what it
// cleared is owed again.
contactsRouter.delete(
  "/:id/clear/:clearanceId",
  validObjectIdParam("id"),
  validObjectIdParam("clearanceId"),
  async (req, res) => {
    const userId = currentUserId(req);
    const deleted = await ContactClearance.findOneAndDelete({
      _id: req.params.clearanceId,
      contactId: req.params.id,
      userId,
    });
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.status(204).end();
  }
);

// PATCH /contacts/:id — a new name or number.
contactsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = contactSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give them a name." });

  const userId = currentUserId(req);
  const contact = await Contact.findOne({ _id: req.params.id, userId });
  if (!contact) return res.status(404).json({ error: "Not found" });

  if (parsed.data.name !== undefined) contact.name = parsed.data.name;
  if (parsed.data.openingBalanceMinor !== undefined) contact.openingBalanceMinor = parsed.data.openingBalanceMinor;
  if (parsed.data.phone !== undefined) {
    const phone = normalisePhone(parsed.data.phone);
    if (phone && (await Contact.exists({ userId, phone, _id: { $ne: contact._id } }))) {
      return res.status(409).json({ error: "Someone else here already has that number." });
    }
    contact.phone = phone;
  }
  await contact.save();

  const owed = await balances(userId, [contact._id]);
  res.json(withBalance(contact, owed.get(contact._id.toString())));
});

// DELETE /contacts/:id — takes them off every transaction they were on.
// The transactions themselves stay exactly as they were: a split is still
// a split, only no longer said to be with anyone in particular. What was
// cleared with them goes too: it belonged to their balance alone.
contactsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const contact = await Contact.findOne({ _id: req.params.id, userId });
  if (!contact) return res.status(404).json({ error: "Not found" });

  await Transaction.updateMany(
    { userId, "people.contactId": contact._id },
    { $pull: { people: { contactId: new Types.ObjectId(contact._id) } } }
  );
  await ContactClearance.deleteMany({ userId, contactId: contact._id });
  await contact.deleteOne();
  res.status(204).end();
});
