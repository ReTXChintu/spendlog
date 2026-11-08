import { Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Account, CardStatement, CardStatementDoc, EmailConnection, User } from "../../models";
import { sendNotification } from "../family/family.push";
import { GmailNeedsReconnectError } from "../ingestion/gmail.service";
import { syncStatements } from "./statements.service";

/**
 * Statements read from the mailbox by themselves, and said when they come.
 *
 * The payment alerts are read every quarter of an hour; statements used to
 * wait for someone to press "read statements". Now the mailbox is looked
 * at for them every hour too - only the last fortnight's mail, since one
 * arrives a month - and each statement found is said once: read and
 * matched (with the bill and its due date, for a card), waiting for its
 * password, or for an account SpendLog doesn't have yet.
 */

/// How often the mailbox is looked at for statements.
export const STATEMENT_WATCH_MS = 60 * 60 * 1000;
/// How far back each look goes.
const WATCH_DAYS = 14;

const rupees = (minor: number) => `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;
const shortDate = (date: Date) =>
  date.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/** What to say about a statement that has just come in. */
export function statementNotice(
  statement: Pick<CardStatementDoc, "status" | "kind" | "totalDueMinor" | "dueDate" | "fileName" | "subject"> & {
    lines: readonly { resolution: string }[];
  },
  accountLabel: string | null
): { title: string; body: string } {
  const what = accountLabel ?? statement.fileName ?? statement.subject ?? "a statement";
  if (statement.status === "LOCKED") {
    return {
      title: "A statement needs its password",
      body: `${what}. Add the statement password on the card or account, and it's read next time.`,
    };
  }
  if (statement.status !== "PARSED") {
    return {
      title: "A statement SpendLog couldn't place",
      body: `${what}: no card or account of yours matches it. Add it, then read the statement again.`,
    };
  }

  const matched = statement.lines.filter((line) => line.resolution === "MATCHED" || line.resolution === "UNCERTAIN").length;
  const added = statement.lines.filter((line) => line.resolution === "ADDED").length;
  const counts = `${matched} ${matched === 1 ? "payment" : "payments"} matched${added > 0 ? `, ${added} added that SpendLog hadn't seen` : ""}.`;
  if (statement.kind === "CARD" && statement.totalDueMinor) {
    return {
      title: `${accountLabel ?? "Card"} bill: ${rupees(statement.totalDueMinor)}${statement.dueDate ? `, due ${shortDate(statement.dueDate)}` : ""}`,
      body: `Statement read. ${counts}`,
    };
  }
  return { title: `${accountLabel ?? "Account"} statement read`, body: counts };
}

/** Tells the user about each statement of theirs not yet told about. Returns how many. */
export async function notifyNewStatements(userId: Types.ObjectId, now = new Date()): Promise<number> {
  const fresh = await CardStatement.find({
    userId,
    notifiedAt: null,
    createdAt: { $gte: new Date(now.getTime() - WATCH_DAYS * 24 * 60 * 60 * 1000) },
  });
  let told = 0;
  for (const statement of fresh) {
    // Claimed first, so two runs at once say it once.
    const claimed = await CardStatement.updateOne({ _id: statement._id, notifiedAt: null }, { $set: { notifiedAt: now } });
    if (claimed.modifiedCount === 0) continue;
    // A PDF that couldn't be read at all is mostly not a statement - an
    // invoice whose subject says "bill" - and not worth a notification.
    if (statement.status === "UNREADABLE") continue;
    const account = statement.accountId
      ? await Account.findById(statement.accountId).select("nickname bankName last4").lean()
      : null;
    const label = account ? `${account.nickname || account.bankName}${account.last4 ? ` ••${account.last4}` : ""}` : null;
    await sendNotification(userId, {
      ...statementNotice(statement, label),
      data: { type: "STATEMENT", ...(statement.accountId ? { accountId: statement.accountId.toString() } : {}) },
    }).catch(() => undefined);
    told += 1;
  }
  return told;
}

/** Every owner with a mailbox connected: their last fortnight's statements read, and the new ones said. */
export async function runStatementWatch(now = new Date()): Promise<void> {
  const owners = await EmailConnection.distinct("userId");
  for (const userId of owners as Types.ObjectId[]) {
    const user = await User.findById(userId).select("role").lean();
    if (!user || user.role === "KID") continue;
    try {
      await syncStatements(userId, { days: WATCH_DAYS });
    } catch (error) {
      // A dropped sign-in waits for the user, and is flagged on the
      // connection already; anything else is worth a line.
      if (!(error instanceof GmailNeedsReconnectError)) console.error(`Statement watch failed for ${userId}:`, error);
    }
    await notifyNewStatements(userId, now).catch((error) => console.error(`Statement notice failed for ${userId}:`, error));
  }
}

export const STATEMENT_NOTICE_BACKFILL = "statementNoticeStart";

/** Statements already in when this began are not news: marked as told. */
export async function runStatementNoticeBackfill(): Promise<{ users: number; changed: number }> {
  return runOncePerUser(STATEMENT_NOTICE_BACKFILL, 1, async (userId) => {
    const result = await CardStatement.updateMany({ userId, notifiedAt: null }, { $set: { notifiedAt: new Date() } });
    return result.modifiedCount;
  });
}
