import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, CardStatement, Transaction } from "../../models";
import { encryptPassword, encryptionAvailable } from "./statements.crypto";
import {
  candidatesForLine,
  reconcileStatement,
  resolveLineByHand,
  unpickStatement,
} from "./statements.reconcile";
import { rereadStatement, syncStatements } from "./statements.service";
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
    problem: statement.problem ?? null,
    subject: statement.subject ?? null,
    fileName: statement.fileName ?? null,
    issuer: statement.issuer ?? null,
    statementDate: statement.statementDate,
    dueDate: statement.dueDate,
    periodStart: statement.periodStart,
    periodEnd: statement.periodEnd,
    totalDueMinor: statement.totalDueMinor,
    minimumDueMinor: statement.minimumDueMinor,
    statementSpendMinor: statement.statementSpendMinor,
    knownSpendMinor: statement.knownSpendMinor,
    reconciledAt: statement.reconciledAt ?? null,
    lineCount: statement.lines.length,
    counts,
  };
}

// GET /statements — every statement seen, newest first.
statementsRouter.get("/", async (req, res) => {
  const statements = await CardStatement.find({ userId: currentUserId(req) })
    .sort({ statementDate: -1, createdAt: -1 })
    .limit(60);

  res.json(statements.map(summarise));
});

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
