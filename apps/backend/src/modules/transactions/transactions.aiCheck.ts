import { Types } from "mongoose";
import { Account, AI_FLAG_KINDS, AiFlagKind, Transaction, User } from "../../models";
import { runDailyJob } from "../../jobs/daily";
import { AiError, askForJson, withModel } from "../ai/ai.gemini";
import { sendNotification } from "../family/family.push";
import { decryptPassword } from "../statements/statements.crypto";

/**
 * A second reading of what the parser recorded, by Gemini, every morning.
 *
 * The parser reads bank messages by their words, and some messages that
 * are not payments use a payment's words: "Get a personal loan of Rs.
 * 3,000 on Meesho sent directly to your bank account" became a ₹3,000
 * debit, and sat in the month's spending until someone noticed. A model
 * reading the message and the row it became side by side notices that
 * kind of thing - an advert, a reminder, a failed payment, an amount or a
 * direction read wrong, the same payment twice - which no single rule
 * written in advance does.
 *
 * It only ever flags. Nothing is deleted or changed without the user: a
 * flagged row waits on Home with the reason, to be deleted, fixed or said
 * to be right. A row said to be right is never flagged again, and every
 * row is read once (aiCheckedAt), so the cost each morning is the day's
 * new messages. It runs on the user's own Gemini key; without one there
 * is no check.
 */

const JOB_KEY = "aiEntryCheck";
/// The morning, after the night's messages are in and before the day's
/// first look at the app.
export const AI_CHECK_HOUR_IST = 7;
/// How far back a first check reads. Older rows have been looked at in
/// the months since; reading years of them would cost a lot to find little.
export const AI_CHECK_LOOKBACK_DAYS = 60;
/// Rows per question. Sorted by time, so a payment and its repeat usually
/// share a batch.
export const AI_CHECK_BATCH = 60;
const MAX_TEXT = 400;

export interface CheckRow {
  id: string;
  occurredAt: Date;
  type: string;
  amountMinor: number;
  merchant: string | null;
  account: string | null;
  /// What the row was made from: every message that reported it.
  text: string;
}

export interface ModelFlag {
  row: number;
  kind: string;
  reason: string;
  duplicateOfRow?: number | null;
}

export interface Flag {
  id: string;
  kind: AiFlagKind;
  reason: string;
  duplicateOf: string | null;
}

const INSTRUCTION = [
  "You check an Indian personal finance app's transactions against the bank SMS and emails they were read from.",
  "Each row is what the app recorded: its number, date, DEBIT (money out) or CREDIT (money in), amount in rupees,",
  "merchant, account, and the original message text. Flag a row only when the message shows the app got it wrong:",
  "- NOT_A_TRANSACTION: the message is not a completed payment - an advert or loan offer, an OTP, a reminder that",
  "  something is due or will be debited, a failed, declined or reversed attempt, a balance enquiry, a collect request.",
  "- WRONG_AMOUNT: the amount recorded differs from the amount the message says was paid or received.",
  "- WRONG_DIRECTION: recorded as money out when the message says money came in, or the other way round.",
  "- DUPLICATE: the same payment as another row in this list - same amount, same account, same reference or within",
  "  minutes - recorded twice. Give the row it repeats in duplicateOfRow. Two payments with different references or",
  "  times are not duplicates, even to the same person for the same amount.",
  "Do not flag a row for anything else. Credit card bill payments, transfers between the user's own accounts, loan",
  "repayments, SIPs, rent and small repeated purchases are all normal. When unsure, do not flag.",
  "Write each reason as one short plain sentence to the user, quoting what in the message shows the problem.",
  "Return {\"flags\": []} when nothing is wrong.",
].join("\n");

const SCHEMA = {
  type: "OBJECT",
  properties: {
    flags: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          row: { type: "INTEGER" },
          kind: { type: "STRING", enum: [...AI_FLAG_KINDS] },
          reason: { type: "STRING" },
          duplicateOfRow: { type: "INTEGER", nullable: true },
        },
        required: ["row", "kind", "reason"],
      },
    },
  },
  required: ["flags"],
};

const rupees = (minor: number) => (minor / 100).toFixed(2);

/** The rows as the model reads them, one numbered line each. */
export function checkPrompt(rows: CheckRow[]): string {
  return rows
    .map((row, index) =>
      JSON.stringify({
        row: index + 1,
        date: row.occurredAt.toISOString(),
        type: row.type,
        amount: rupees(row.amountMinor),
        merchant: row.merchant,
        account: row.account,
        message: row.text.replace(/\s+/g, " ").slice(0, MAX_TEXT),
      })
    )
    .join("\n");
}

/**
 * The model's answer as flags on real rows. Anything that does not name a
 * row in the batch, or a kind there is, is dropped rather than trusted;
 * so is a duplicate that names itself or no other row.
 */
export function readFlags(rows: CheckRow[], answer: { flags?: ModelFlag[] } | null): Flag[] {
  const seen = new Set<string>();
  const flags: Flag[] = [];
  for (const flag of answer?.flags ?? []) {
    const row = rows[flag.row - 1];
    if (!Number.isInteger(flag.row) || !row || seen.has(row.id)) continue;
    if (!(AI_FLAG_KINDS as readonly string[]).includes(flag.kind)) continue;
    const reason = (flag.reason ?? "").trim().slice(0, 300);
    if (!reason) continue;

    let duplicateOf: string | null = null;
    if (flag.kind === "DUPLICATE") {
      const other = flag.duplicateOfRow ? rows[flag.duplicateOfRow - 1] : undefined;
      if (!other || other.id === row.id) continue;
      duplicateOf = other.id;
    }
    seen.add(row.id);
    flags.push({ id: row.id, kind: flag.kind as AiFlagKind, reason, duplicateOf });
  }
  return flags;
}

export type CheckResult =
  | { ran: false; reason: "no-key" }
  | { ran: true; checked: number; flagged: number };

/** Every row of this user's not read yet, read now. */
export async function checkEntries(userId: Types.ObjectId, now = new Date()): Promise<CheckResult> {
  const user = await User.findById(userId).select("geminiApiKeyEnc geminiModel").orFail();
  const key = decryptPassword(user.geminiApiKeyEnc);
  if (!key) return { ran: false, reason: "no-key" };

  const since = new Date(now.getTime() - AI_CHECK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  // Only rows read from a message: one typed in by hand, or made from a
  // group payment someone else made, has no message to check it against.
  const unread = await Transaction.find({
    userId,
    aiCheckedAt: null,
    occurredAt: { $gte: since },
    source: { $in: ["SMS", "EMAIL", "STATEMENT"] },
    mirrorOf: null,
    offLedger: { $ne: true },
  })
    .sort({ occurredAt: 1 })
    .select("occurredAt type amountMinor merchant accountId rawText sources editedAt aiFlagDismissedAt")
    .lean();
  if (unread.length === 0) return { ran: true, checked: 0, flagged: 0 };

  const accounts = new Map(
    (await Account.find({ userId }).select("bankName nickname last4 accountType").lean()).map((account) => [
      account._id.toString(),
      [account.nickname || account.bankName, account.accountType, account.last4].filter(Boolean).join(" "),
    ])
  );

  let flagged = 0;
  for (let start = 0; start < unread.length; start += AI_CHECK_BATCH) {
    const batch = unread.slice(start, start + AI_CHECK_BATCH);
    const rows: CheckRow[] = batch.map((tx) => ({
      id: tx._id.toString(),
      occurredAt: tx.occurredAt,
      type: tx.type,
      amountMinor: tx.amountMinor,
      merchant: tx.merchant ?? null,
      account: tx.accountId ? (accounts.get(tx.accountId.toString()) ?? null) : null,
      text: (tx.sources ?? []).map((source) => source.rawText).filter(Boolean).join(" || ") || tx.rawText || "",
    }));

    const { result } = await withModel(user.geminiModel ?? null, (model) =>
      askForJson<{ flags?: ModelFlag[] }>(key, model, INSTRUCTION, checkPrompt(rows), SCHEMA)
    );

    // A row a person already corrected, or said was right, is theirs.
    const settled = new Set(batch.filter((tx) => tx.editedAt || tx.aiFlagDismissedAt).map((tx) => tx._id.toString()));
    const flags = readFlags(rows, result).filter((flag) => !settled.has(flag.id));

    await Transaction.updateMany({ _id: { $in: batch.map((tx) => tx._id) } }, { $set: { aiCheckedAt: now } });
    for (const flag of flags) {
      const written = await Transaction.updateOne(
        { _id: flag.id, userId, aiFlag: null },
        {
          $set: {
            aiFlag: {
              kind: flag.kind,
              reason: flag.reason,
              duplicateOf: flag.duplicateOf ? new Types.ObjectId(flag.duplicateOf) : null,
              flaggedAt: now,
            },
          },
        }
      );
      flagged += written.modifiedCount;
    }
  }

  return { ran: true, checked: unread.length, flagged };
}

/** "2 entries look wrong", when a check found any. */
async function tellAbout(userId: Types.ObjectId, flagged: number) {
  if (flagged === 0) return;
  await sendNotification(userId, {
    title: flagged === 1 ? "1 entry looks wrong" : `${flagged} entries look wrong`,
    body: "SpendLog's check thinks it read something wrong. Tap to delete or fix it, or say it's right.",
    data: { type: "ENTRY_CHECK" },
  }).catch(() => undefined);
}

/** Every owner with a Gemini key, once a morning. Asked every half hour; runs when due. */
export async function runAiEntryChecks(now = new Date()): Promise<{ ran: boolean; users: number; flagged: number }> {
  const run = await runDailyJob(JOB_KEY, { hour: AI_CHECK_HOUR_IST }, now, async () => {
    const owners = await User.find({ role: { $ne: "KID" }, geminiApiKeyEnc: { $ne: null } }).select("_id");
    let flagged = 0;
    for (const owner of owners) {
      try {
        const result = await checkEntries(owner._id, now);
        if (result.ran) {
          flagged += result.flagged;
          await tellAbout(owner._id, result.flagged);
        }
      } catch (error) {
        // One person's key being wrong or out of quota is not everyone's.
        console.error(`AI entry check failed for ${owner._id}:`, error instanceof AiError ? error.message : error);
      }
    }
    return { users: owners.length, flagged };
  });
  return run.ran ? { ran: true, ...run.result } : { ran: false, users: 0, flagged: 0 };
}
