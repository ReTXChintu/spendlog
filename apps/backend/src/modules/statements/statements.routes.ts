import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { learnCycleFromStatement } from "../cards/cards.learn";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, CardStatement, Transaction } from "../../models";
import { istMonthKey } from "../../time";
import { encryptPassword, encryptionAvailable } from "./statements.crypto";
import { deleteStatementFile, fileStoreAvailable, readStatementFile } from "./statements.files";
import { planStatementReset, resetStatements } from "./statements.reset";
import {
  candidatesForLine,
  reconcileStatement,
  resolveLineByHand,
  unpickStatement,
} from "./statements.reconcile";
import { rereadStatement, statementText, syncStatements } from "./statements.service";
import { upcomingBills } from "./statements.bills";

export const statementsRouter = Router();
statementsRouter.use(requireAuth);

/**
 * A statement in list form: enough to know whether it needs anything doing
 * to it, without the hundreds of lines that would make listing them slow.
 */
function summarise(statement: import("../../models").CardStatementDoc) {
  const counts = { matched: 0, added: 0, uncertain: 0, skipped: 0 };
  for (const line of statement.lines) {
    if (line.resolution === "MATCHED") counts.matched += 1;
    else if (line.resolution === "ADDED") counts.added += 1;
    else if (line.resolution === "UNCERTAIN") counts.uncertain += 1;
    else counts.skipped += 1;
  }

  return {
    id: statement._id.toString(),
    accountId: statement.accountId?.toString() ?? null,
    status: statement.status,
    kind: statement.kind,
    problem: statement.problem ?? null,
    subject: statement.subject ?? null,
    fileName: statement.fileName ?? null,
    issuer: statement.issuer ?? null,
    statementDate: statement.statementDate,
    receivedAt: statement.receivedAt ?? null,
    dueDate: statement.dueDate,
    periodStart: statement.periodStart,
    periodEnd: statement.periodEnd,
    totalDueMinor: statement.totalDueMinor,
    minimumDueMinor: statement.minimumDueMinor,
    waivedMinor: statement.waivedMinor ?? null,
    waivedNote: statement.waivedNote ?? null,
    statementSpendMinor: statement.statementSpendMinor,
    knownSpendMinor: statement.knownSpendMinor,
    reconciledAt: statement.reconciledAt ?? null,
    monthKey: statement.monthKey ?? null,
    /// Whether the PDF can be opened, not how big it is - the size is not
    /// worth a line of screen, but a button that may not work is.
    hasFile: Boolean(statement.fileBytes),
    fileBytes: statement.fileBytes ?? null,
    rowCount: statement.rows?.length ?? 0,
    lineCount: statement.lines.length,
    counts,
  };
}

// GET /statements — every statement seen, newest first.
statementsRouter.get("/", async (req, res) => {
  // Sorted here rather than in Mongo. A statement that could not be read
  // has no statementDate at all, so a `{ statementDate: -1 }` sort put
  // every unread one in a heap ordered by createdAt - and since Gmail
  // lists newest mail first, the newest statement is the one created
  // first, which turned the whole list upside down. Capped at 60, so
  // ordering them in hand costs nothing.
  const statements = await CardStatement.find({ userId: currentUserId(req) })
    .sort({ createdAt: -1 })
    .limit(60);

  const byDate = statements
    .slice()
    .sort((left, right) => newestDate(right).getTime() - newestDate(left).getTime());

  res.json(byDate.map(summarise));
});

/**
 * The date a statement belongs under: its own if it was read, otherwise
 * the day its mail arrived.
 */
function newestDate(statement: import("../../models").CardStatementDoc): Date {
  return statement.statementDate ?? statement.periodEnd ?? statement.receivedAt ?? statement.createdAt;
}

/** The group a statement with no card yet is filed under. */
const UNFILED = "unfiled";

/**
 * One card's statements, split into months, newest month first and newest
 * statement first inside each.
 *
 * A month a card has no statement for is not a group: this lists what is
 * there rather than drawing a calendar, so a gap shows as a gap.
 */
function monthsOf(statements: import("../../models").CardStatementDoc[]) {
  const byMonth = new Map<string, import("../../models").CardStatementDoc[]>();

  for (const statement of statements) {
    // Derived on save, but a statement written before that rule existed
    // has none - so it is worked out here too rather than falling into an
    // "Undated" bucket that only means "read by an older version".
    const key = statement.monthKey ?? istMonthKey(newestDate(statement));
    byMonth.set(key, [...(byMonth.get(key) ?? []), statement]);
  }

  return [...byMonth.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([month, rows]) => ({
      month,
      statements: rows
        .slice()
        .sort((left, right) => newestDate(right).getTime() - newestDate(left).getTime())
        .map(summarise),
    }));
}

// POST /statements/sync — go and look for statements that are new.
//
// Separate from the transaction sync next door: that one reads alerts as
// they arrive, this reads the monthly summary that says what the alerts
// missed.
statementsRouter.post("/sync", async (req, res) => {
  const days = Number(req.body?.days);
  const result = await syncStatements(
    currentUserId(req),
    Number.isFinite(days) && days > 0 ? { days: Math.min(days, 400) } : undefined
  );
  res.json(result);
});

// GET /statements/bills - card bills that have been read and not yet paid.
//
// A statement is the first moment the app can know what a bill actually is,
// so it is the moment worth saying so.
statementsRouter.get("/bills", async (req, res) => {
  res.json(await upcomingBills(currentUserId(req)));
});

/**
 * GET /statements/filed — every statement, under the card it belongs to and
 * the month it is for.
 *
 * The flat list this replaces was fine at five statements and useless at
 * fifty: every card's statements interleaved by date, with the only way to
 * find June's HDFC bill being to read the subjects. The shape is the same
 * one the screen draws, because working it out on the client would mean
 * writing the same grouping and the same ordering rules twice.
 *
 * A statement whose card is not known yet lands in a group of its own
 * rather than being hidden - that group is a to-do list.
 */
statementsRouter.get("/filed", async (req, res) => {
  const userId = currentUserId(req);

  const [statements, accounts] = await Promise.all([
    CardStatement.find({ userId }).sort({ createdAt: -1 }),
    Account.find({ userId, accountType: { $in: ["CARD", "BANK"] } }).sort({ bankName: 1 }),
  ]);

  const byAccount = new Map<string, typeof statements>();
  for (const statement of statements) {
    const key = statement.accountId?.toString() ?? UNFILED;
    byAccount.set(key, [...(byAccount.get(key) ?? []), statement]);
  }

  const groups = accounts
    .filter((account) => byAccount.has(account._id.toString()))
    .map((account) => ({
      accountId: account._id.toString(),
      name: account.nickname || account.bankName,
      bankName: account.bankName,
      last4: account.last4,
      accountType: account.accountType,
      network: account.cardNetwork ?? null,
      months: monthsOf(byAccount.get(account._id.toString()) ?? []),
    }));

  const unfiled = byAccount.get(UNFILED) ?? [];
  if (unfiled.length > 0) {
    groups.push({
      accountId: UNFILED,
      name: "Not on a card yet",
      bankName: "",
      last4: "",
      accountType: "CARD",
      network: null,
      months: monthsOf(unfiled),
    });
  }

  res.json(groups);
});

// GET /statements/reset — what starting over would cost, without doing it.
statementsRouter.get("/reset", async (req, res) => {
  res.json(await planStatementReset(currentUserId(req)));
});

/**
 * POST /statements/reset — forget every statement and everything it added.
 *
 * For the ledger left behind by the period when every sync read every
 * statement again. Guarded by a body that has to say so in words, because
 * this deletes several hundred rows and a mis-click is not a thing to
 * discover afterwards.
 */
statementsRouter.post("/reset", async (req, res) => {
  if (req.body?.confirm !== "start over") {
    return res.status(400).json({
      error: 'This deletes every statement and everything it added. Send { "confirm": "start over" }.',
    });
  }

  res.json(await resetStatements(currentUserId(req)));
});

// GET /statements/:id/file — the statement PDF itself.
//
// Sent inline so a browser opens it in a tab rather than downloading it,
// and never cached by anything in between: this is a bank statement.
statementsRouter.get("/:id/file", validObjectIdParam("id"), async (req, res) => {
  const statement = await CardStatement.findOne({
    _id: req.params.id,
    userId: currentUserId(req),
  });
  if (!statement) return res.status(404).json({ error: "Not found" });

  const pdf = await readStatementFile(statement._id);
  if (!pdf) {
    return res.status(404).json({
      error: !fileStoreAvailable()
        ? "STATEMENT_ENCRYPTION_KEY is not set on the server, so no statement file could be stored."
        : "This statement was read before SpendLog kept the file. Read it again to store one.",
    });
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${(statement.fileName ?? "statement.pdf").replace(/[^\w.\- ]/g, "_")}"`
  );
  res.send(pdf);
});

// GET /statements/:id — one statement, with every line and what became of it.
statementsRouter.get("/:id", validObjectIdParam("id"), async (req, res) => {
  const statement = await CardStatement.findOne({
    _id: req.params.id,
    userId: currentUserId(req),
  }).populate("accountId");

  if (!statement) return res.status(404).json({ error: "Not found" });

  // The transactions the lines point at, so the client can show what a line
  // was matched to without a request per line.
  const transactionIds = statement.lines
    .map((line) => line.transactionId)
    .filter((id): id is Types.ObjectId => Boolean(id));

  const transactions = await Transaction.find({ _id: { $in: transactionIds } }).populate("category");
  const byId = new Map(transactions.map((transaction) => [transaction._id.toString(), transaction]));

  res.json({
    ...summarise(statement),
    account: statement.accountId,
    // The text the readers saw, kept from when it was read. This is what
    // a line is checked against when it looks wrong, and it used to mean
    // fetching the whole PDF from Gmail again to find out.
    rows: statement.rows ?? [],
    lines: statement.lines.map((line) => ({
      id: line._id.toString(),
      date: line.date,
      description: line.description,
      amountMinor: line.amountMinor,
      type: line.type,
      kind: line.kind,
      resolution: line.resolution,
      transaction: line.transactionId ? (byId.get(line.transactionId.toString()) ?? null) : null,
    })),
  });
});

// POST /statements/:id/reread — fetch and read it again.
//
// What you press after setting a password or adding the card a statement
// belongs to. The attachment is fetched from Gmail each time rather than
// kept: a statement PDF is the most sensitive file in the mailbox, and
// there is no reason for this app to hold a copy.
statementsRouter.post("/:id/reread", validObjectIdParam("id"), async (req, res) => {
  const result = await rereadStatement(currentUserId(req), new Types.ObjectId(req.params.id));
  if (!result) return res.status(404).json({ error: "Not found" });

  if (result === "alreadyDone") {
    return res.status(409).json({
      error: "This statement has already been read. Undo what it added first, then read it again.",
    });
  }

  res.json(result);
});

// POST /statements/:id/reconcile — match again without re-downloading.
statementsRouter.post("/:id/reconcile", validObjectIdParam("id"), async (req, res) => {
  const statement = await CardStatement.findOne({ _id: req.params.id, userId: currentUserId(req) });
  if (!statement) return res.status(404).json({ error: "Not found" });

  res.json(await reconcileStatement(statement));
});

// DELETE /statements/:id/added — take back the rows this statement created.
//
// For when a statement was read against the wrong card. Only ever removes
// what it added; a line that matched an existing transaction is left alone,
// because that row was not created here.
statementsRouter.delete("/:id/added", validObjectIdParam("id"), async (req, res) => {
  const removed = await unpickStatement(currentUserId(req), new Types.ObjectId(req.params.id));
  res.json({ removed });
});

// DELETE /statements/:id - forget a statement entirely.
//
// Takes back anything it added on the way out, because leaving those rows
// behind would leave transactions in the ledger pointing at a statement
// that no longer exists - and nothing to say where they came from or how
// to be rid of them.
statementsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const statementId = new Types.ObjectId(req.params.id);

  const removed = await unpickStatement(userId, statementId);
  const deleted = await CardStatement.findOneAndDelete({ _id: statementId, userId });
  if (!deleted) return res.status(404).json({ error: "Not found" });

  // The file is kept for as long as its statement and no longer. Deleting
  // the record and leaving the PDF would be the worst of both: a bank
  // statement still on the disk that nothing in the app can reach or remove.
  await deleteStatementFile(statementId);

  res.json({ removed });
});

const lineActionSchema = z.object({
  action: z.enum(["link", "add", "ignore", "reset"]),
  transactionId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .optional(),
});

// GET /statements/:id/lines/:lineId/candidates - what this line might be.
//
// Asked precisely when the automatic answer was wrong, so the window is
// wider than the matcher's own: holding it to the same bounds would offer
// the same wrong shortlist again.
statementsRouter.get("/:id/lines/:lineId/candidates", validObjectIdParam("id"), async (req, res) => {
  res.json(
    await candidatesForLine(currentUserId(req), new Types.ObjectId(req.params.id), req.params.lineId)
  );
});

// GET /statements/:id/text - the text this statement extracts to.
//
// For when one opens but nothing is found in it. "No transaction table
// could be found" is a true statement about the readers and a useless one
// about the file; this is the file.
statementsRouter.get("/:id/text", validObjectIdParam("id"), async (req, res) => {
  const result = await statementText(currentUserId(req), new Types.ObjectId(req.params.id));
  if (!result) return res.status(404).json({ error: "Not found, or it could not be opened" });
  res.json(result);
});

// PATCH /statements/:id/lines/:lineId - say what a line is, by hand.
//
// The matcher works on amount, direction, account and a few days either
// way, and never reads the merchant - so renaming one cannot break it. But
// two payments of the same amount in the same week are indistinguishable
// from the statement's side, and only a person knows which was which.
statementsRouter.patch("/:id/lines/:lineId", validObjectIdParam("id"), async (req, res) => {
  const parsed = lineActionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  if (parsed.data.action === "link" && !parsed.data.transactionId) {
    return res.status(400).json({ error: "Say which transaction it is" });
  }

  const result = await resolveLineByHand({
    userId: currentUserId(req),
    statementId: new Types.ObjectId(req.params.id),
    lineId: req.params.lineId,
    action: parsed.data.action,
    transactionId: parsed.data.transactionId,
  });

  if (!result) return res.status(404).json({ error: "Not found" });
  res.json(result);
});

const assignSchema = z.object({
  accountId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Not a card id"),
});

const waiveSchema = z.object({
  // null clears it, which is how somebody undoes a mistaken entry.
  waivedMinor: z.number().int().nonnegative().nullable(),
  note: z.string().max(120).nullable().optional(),
});

// PATCH /statements/:id/waive - record that part of the bill was covered
// by something other than a payment: cashback, reward points, a fee the
// bank waived.
//
// SpendLog only ever sees money that actually moved, so a bill settled
// partly by points looks exactly like a bill nobody finished paying - the
// gap is real and permanent no matter how long the ledger is watched.
// This is the one place that gap can be explained rather than left to
// read as unpaid forever.
statementsRouter.patch("/:id/waive", validObjectIdParam("id"), async (req, res) => {
  const parsed = waiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const userId = currentUserId(req);
  const statement = await CardStatement.findOne({ _id: req.params.id, userId });
  if (!statement) return res.status(404).json({ error: "Not found" });

  if (parsed.data.waivedMinor !== null) {
    if (!statement.totalDueMinor) {
      return res.status(400).json({ error: "This statement has no bill to cover part of yet." });
    }
    if (parsed.data.waivedMinor > statement.totalDueMinor) {
      return res.status(400).json({ error: "That is more than the bill itself." });
    }
  }

  statement.waivedMinor = parsed.data.waivedMinor;
  statement.waivedNote = parsed.data.waivedMinor === null ? null : (parsed.data.note?.trim() || null);
  await statement.save();

  res.json(summarise(statement));
});

// PATCH /statements/:id - say by hand which card this statement is for.
//
// Needed because not every issuer prints the card number on the page the
// transactions are on. Reconciles straight away, since being unable to say
// which card it was is the only thing that was stopping it.
statementsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const userId = currentUserId(req);
  const statement = await CardStatement.findOne({ _id: req.params.id, userId });
  if (!statement) return res.status(404).json({ error: "Not found" });

  // Moving an already-reconciled statement would leave the rows it added
  // sitting on the old card, so the rows have to come back first.
  if (statement.reconciledAt) {
    return res.status(409).json({
      error: "This statement has already been read. Undo what it added first, then move it.",
    });
  }

  const card = await Account.findOne({ _id: parsed.data.accountId, userId });
  if (!card) return res.status(404).json({ error: "No such card" });

  statement.accountId = card._id;
  statement.status = statement.lines.length > 0 ? "PARSED" : statement.status;
  statement.problem = null;
  await statement.save();

  // The same lesson a statement teaches when it arrives on its own. Missed
  // here until now: a statement mapped by hand is exactly the one whose
  // card SpendLog knew least about, so it is the one whose billing day was
  // most likely still a guess.
  await learnCycleFromStatement(card, statement);

  res.json(await reconcileStatement(statement));
});

const passwordSchema = z.object({
  // Empty clears it. Long enough to cover the DDMMYYYY and NAME+DDMM
  // shapes issuers use, capped so nothing silly gets stored.
  password: z.string().max(128),
});

// PUT /accounts/:id/statement-password — set or clear a card's password.
//
// Lives here rather than on the accounts router so everything that touches
// a statement password is in one place. Never readable back: the response
// says only whether one is set.
statementsRouter.put("/password/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const password = parsed.data.password.trim();
  if (password && !encryptionAvailable()) {
    return res.status(503).json({
      error:
        "STATEMENT_ENCRYPTION_KEY is not set on the server, so a statement password cannot be stored. " +
        "Generate one with `openssl rand -hex 32` and put it in the .env at the repo root.",
    });
  }

  const card = await Account.findOneAndUpdate(
    { _id: req.params.id, userId: currentUserId(req) },
    { $set: { statementPassword: password ? encryptPassword(password) : null } },
    { new: true }
  );
  if (!card) return res.status(404).json({ error: "Not found" });

  res.json({ id: card._id.toString(), hasStatementPassword: Boolean(card.statementPassword) });
});
