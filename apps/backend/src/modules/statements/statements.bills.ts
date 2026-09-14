import { Types } from "mongoose";
import { Account, CardStatement, Transaction } from "../../models";
import { istDayKey } from "../../time";

/**
 * Card bills that have been read and not yet paid.
 *
 * A statement is the first moment the app can know what a bill actually is.
 * Before it arrives there is only an estimate from the transactions seen;
 * afterwards there is the figure the bank will take. So this is the moment
 * worth telling someone about, and it is worth telling them once.
 *
 * Whether it has been paid is answered the way the rest of the app answers
 * it - by a payment marked against that card. There is no other way to
 * know: paying a bill produces one message, from the bank being debited,
 * and nothing on the card side to pair it with.
 */

export interface UpcomingBill {
  statementId: string;
  accountId: string;
  cardName: string;
  totalDueMinor: number;
  minimumDueMinor: number | null;
  statementDate: Date | null;
  dueDate: Date | null;
  /// Negative once the due date has gone past.
  daysUntilDue: number | null;
  paidMinor: number;
  isPaid: boolean;
}

/** How far back to look for a bill still worth mentioning. */
const STALE_AFTER_DAYS = 60;

export async function upcomingBills(userId: Types.ObjectId, now = new Date()): Promise<UpcomingBill[]> {
  const since = new Date(now.getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  const statements = await CardStatement.find({
    userId,
    kind: "CARD",
    status: "PARSED",
    totalDueMinor: { $gt: 0 },
    statementDate: { $gte: since },
  })
    .sort({ statementDate: -1 })
    .limit(20);

  if (statements.length === 0) return [];

  const accounts = await Account.find({
    _id: { $in: statements.map((statement) => statement.accountId).filter(Boolean) },
  });
  const nameById = new Map(
    accounts.map((account) => [account._id.toString(), account.nickname?.trim() || account.bankName])
  );

  // Only the newest statement per card matters. An older one is a bill that
  // has been superseded, and saying anything about it would be pointing at
  // a figure the bank no longer wants.
  const seen = new Set<string>();
  const bills: UpcomingBill[] = [];

  for (const statement of statements) {
    const accountId = statement.accountId?.toString();
    if (!accountId || seen.has(accountId)) continue;
    seen.add(accountId);

    // Anything marked as paying this card since the statement was drawn.
    // Summed, because a bill can be cleared in more than one go.
    const [paid] = await Transaction.aggregate<{ total: number }>([
      {
        $match: {
          userId,
          cardPaymentFor: statement.accountId,
          type: "DEBIT",
          occurredAt: { $gte: statement.statementDate ?? since },
        },
      },
      { $group: { _id: null, total: { $sum: "$amountMinor" } } },
    ]);

    const paidMinor = paid?.total ?? 0;
    const totalDueMinor = statement.totalDueMinor ?? 0;

    bills.push({
      statementId: statement._id.toString(),
      accountId,
      cardName: nameById.get(accountId) ?? "A card",
      totalDueMinor,
      minimumDueMinor: statement.minimumDueMinor ?? null,
      statementDate: statement.statementDate ?? null,
      dueDate: statement.dueDate ?? null,
      daysUntilDue: statement.dueDate ? daysBetween(now, statement.dueDate) : null,
      paidMinor,
      isPaid: paidMinor >= totalDueMinor,
    });
  }

  // Soonest first, and anything with no due date last - it cannot be
  // ordered against the rest and is not urgent by definition.
  return bills.sort((a, b) => (a.daysUntilDue ?? 9999) - (b.daysUntilDue ?? 9999));
}

/** Whole days from the start of today, in IST, to a date. */
function daysBetween(now: Date, to: Date): number {
  const today = Date.parse(`${istDayKey(now)}T00:00:00.000+05:30`);
  return Math.round((to.getTime() - today) / (24 * 60 * 60 * 1000));
}
