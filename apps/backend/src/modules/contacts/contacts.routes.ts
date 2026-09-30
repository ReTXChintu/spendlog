import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Contact, Transaction } from "../../models";
import { NO_BALANCE, balances, normalisePhone } from "./contacts.people";

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

/**
 * The people money moves between: who has been lent what, who has paid
 * what back, and so who still owes how much.
 */

// GET /contacts — everyone, with where they stand. Whoever owes most
// first, then whoever is owed, then everyone square, by name.
contactsRouter.get("/", async (req, res) => {
  const userId = currentUserId(req);
  const [contacts, owed] = await Promise.all([Contact.find({ userId }).sort({ name: 1 }), balances(userId)]);

  const rows = contacts.map((contact) => ({
    ...contact.toJSON(),
    ...(owed.get(contact._id.toString()) ?? NO_BALANCE),
  }));
  rows.sort((a, b) => Math.abs(b.balanceMinor) - Math.abs(a.balanceMinor) || a.name.localeCompare(b.name));

  const owedToYou = rows.filter((row) => row.balanceMinor > 0).reduce((sum, row) => sum + row.balanceMinor, 0);
  const youOwe = rows.filter((row) => row.balanceMinor < 0).reduce((sum, row) => sum - row.balanceMinor, 0);

  res.json({ owedToYouMinor: owedToYou, youOweMinor: youOwe, contacts: rows });
});

const contactSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().max(30).nullable().optional(),
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
    if (existing) return res.status(200).json({ ...existing.toJSON(), ...NO_BALANCE, existing: true });
  }

  const created = await Contact.create({ userId, name: parsed.data.name, phone });
  res.status(201).json({ ...created.toJSON(), ...NO_BALANCE });
});

// GET /contacts/:id — one person, their balance, and every transaction
// they are on, newest first, with their part of each.
contactsRouter.get("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const contact = await Contact.findOne({ _id: req.params.id, userId });
  if (!contact) return res.status(404).json({ error: "Not found" });

  const [owed, transactions] = await Promise.all([
    balances(userId, [contact._id]),
    Transaction.find({ userId, "people.contactId": contact._id })
      .sort({ occurredAt: -1 })
      .limit(200)
      .populate("category")
      .populate("account"),
  ]);

  res.json({
    ...contact.toJSON(),
    ...(owed.get(contact._id.toString()) ?? NO_BALANCE),
    history: transactions.map((transaction) => ({
      transaction,
      // Their part: positive when it added to what they owe, negative when
      // it paid some of it back.
      amountMinor:
        (transaction.people.find((person) => person.contactId.equals(contact._id))?.amountMinor ?? 0) *
        (transaction.type === "DEBIT" ? 1 : -1),
    })),
  });
});

// PATCH /contacts/:id — a new name or number.
contactsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = contactSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give them a name." });

  const userId = currentUserId(req);
  const contact = await Contact.findOne({ _id: req.params.id, userId });
  if (!contact) return res.status(404).json({ error: "Not found" });

  if (parsed.data.name !== undefined) contact.name = parsed.data.name;
  if (parsed.data.phone !== undefined) {
    const phone = normalisePhone(parsed.data.phone);
    if (phone && (await Contact.exists({ userId, phone, _id: { $ne: contact._id } }))) {
      return res.status(409).json({ error: "Someone else here already has that number." });
    }
    contact.phone = phone;
  }
  await contact.save();

  const owed = await balances(userId, [contact._id]);
  res.json({ ...contact.toJSON(), ...(owed.get(contact._id.toString()) ?? NO_BALANCE) });
});

// DELETE /contacts/:id — takes them off every transaction they were on.
// The transactions themselves stay exactly as they were: a split is still
// a split, only no longer said to be with anyone in particular.
contactsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const contact = await Contact.findOne({ _id: req.params.id, userId });
  if (!contact) return res.status(404).json({ error: "Not found" });

  await Transaction.updateMany(
    { userId, "people.contactId": contact._id },
    { $pull: { people: { contactId: new Types.ObjectId(contact._id) } } }
  );
  await contact.deleteOne();
  res.status(204).end();
});
