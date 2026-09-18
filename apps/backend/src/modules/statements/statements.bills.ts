import { Types } from "mongoose";
import { Account, CardStatement, Transaction } from "../../models";
import { TransactionType } from "../../types";
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
  /// Covered by something other than a payment - cashback, reward points,
  /// a fee the bank waived. SpendLog only ever sees money that actually
  /// moved, so a bill settled partly this way looks exactly like one
  /// nobody finished paying; this is marked by hand, because nothing else
  /// can see the difference.
  waivedMinor: number;
  waivedNote: string | null;
  /// What is genuinely still owed: the bill, less what was paid, less
  /// what was waived. Never negative. This is the figure everything else
  /// - the card bar, the to-do strip - should ask for, rather than
  /// working paidMinor and waivedMinor out again for itself.
  owedMinor: number;
  isPaid: boolean;
  /// Whether totalDueMinor is the figure the bank printed or one worked
  /// out from the statement's own rows. Said out loud rather than hidden,
  /// because the two deserve different amounts of trust.
  isEstimate: boolean;
}

/**
 * What a statement's own rows come to, for a bill whose total was not found.
 *
 * "Total Amount Due" is found by matching a printed label, and a label is
 * a thing an issuer is free to word differently or lay out in a way the
 * reader cannot follow. When that happens the bill used to be invisible:
 * upcomingBills required a total above zero, so a statement whose summary
 * block could not be read reported no bill at all, and a card showed its
 * whole limit as free while a real one was outstanding.
 *
 * The rows are the bill, near enough. Purchases less any credits on the
 * same statement is what the bank is asking for, provided the last one
 * was cleared - it misses an unpaid balance carried forward, interest and
 * fees, so it is marked as an estimate wherever it is shown.
 */
function billFromRows(lines: { amountMinor: number; type: TransactionType }[]): number {
  const net = lines.reduce(
    (total, line) => total + (line.type === "DEBIT" ? line.amountMinor : -line.amountMinor),
    0
  );

  return Math.max(0, net);
}

/**
 * When a statement was drawn, as best it can be known.
 *
 * The same order the model files a statement under a month by, and for
 * the same reason: a statement never counts as a bill from one month and
 * sorts as though it were from another.
 */
function drawnOn(statement: {
  statementDate?: Date | null;
  periodEnd?: Date | null;
  receivedAt?: Date | null;
}): Date | null {
  return statement.statementDate ?? statement.periodEnd ?? statement.receivedAt ?? null;
}

/** How far back to look for a bill still worth mentioning. */
const STALE_AFTER_DAYS = 60;

export async function upcomingBills(userId: Types.ObjectId, now = new Date()): Promise<UpcomingBill[]> {
  const since = new Date(now.getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000);

  // Deliberately filtered on neither totalDueMinor nor statementDate. A
  // statement whose total could not be read is still a bill, and one whose
  // date could not be read is still a bill - and each of those filters,
  // in turn, was what made a real bill vanish from the card it belongs to.
  // Dated here the way the model files it: its own date, then the close
  // of its period, then the day its mail arrived. Sorted in hand for the
  // same reason, since Mongo cannot sort on "whichever of three is set".
  const statements = (
    await CardStatement.find({ userId, kind: "CARD", status: "PARSED" })
      .sort({ createdAt: -1 })
      .limit(60)
  )
    .map((statement) => ({ statement, drawnOn: drawnOn(statement) }))
    .filter((row): row is { statement: typeof row.statement; drawnOn: Date } =>
      row.drawnOn !== null && row.drawnOn.getTime() >= since.getTime()
    )
    .sort((left, right) => right.drawnOn.getTime() - left.drawnOn.getTime());

  if (statements.length === 0) return [];

  const accounts = await Account.find({
    _id: { $in: statements.map(({ statement }) => statement.accountId).filter(Boolean) },
  });
  const nameById = new Map(
    accounts.map((account) => [account._id.toString(), account.nickname?.trim() || account.bankName])
  );

  // Only the newest statement per card matters. An older one is a bill that
  // has been superseded, and saying anything about it would be pointing at
  // a figure the bank no longer wants.
  const seen = new Set<string>();
  const bills: UpcomingBill[] = [];

  for (const { statement, drawnOn: statementDate } of statements) {
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
          occurredAt: { $gte: statementDate },
        },
      },
      { $group: { _id: null, total: { $sum: "$amountMinor" } } },
    ]);

    const paidMinor = paid?.total ?? 0;

    // The bank's own figure where it was found, and the rows where it was
    // not. A statement that yields neither has nothing to say.
    const printedMinor = statement.totalDueMinor ?? 0;
    const totalDueMinor = printedMinor > 0 ? printedMinor : billFromRows(statement.lines);
    if (totalDueMinor <= 0) continue;

    const waivedMinor = statement.waivedMinor ?? 0;
    const owedMinor = Math.max(0, totalDueMinor - paidMinor - waivedMinor);

    bills.push({
      statementId: statement._id.toString(),
      accountId,
      cardName: nameById.get(accountId) ?? "A card",
      totalDueMinor,
      minimumDueMinor: statement.minimumDueMinor ?? null,
      statementDate,
      dueDate: statement.dueDate ?? null,
      daysUntilDue: statement.dueDate ? daysBetween(now, statement.dueDate) : null,
      paidMinor,
      waivedMinor,
      waivedNote: statement.waivedNote ?? null,
      owedMinor,
      isPaid: owedMinor <= 0,
      isEstimate: printedMinor <= 0,
    });
  }

  // Soonest first, and anything with no due date last - it cannot be
  // ordered against the rest and is not urgent by definition.
  return bills.sort((a, b) => (a.daysUntilDue ?? 9999) - (b.daysUntilDue ?? 9999));
}

/**
 * The same bills, keyed by the card they belong to.
 *
 * For anyone asking about one card rather than listing them all - chiefly
 * cardStatuses, which needs to know how much of a credit limit last
 * month's bill is still holding on to. Built on upcomingBills rather than
 * beside it, so "newest statement, less whatever has been paid against it"
 * is worked out in one place and cannot drift into two answers.
 */
export async function outstandingByCard(
  userId: Types.ObjectId,
  now = new Date()
): Promise<Map<string, UpcomingBill>> {
  const bills = await upcomingBills(userId, now);
  return new Map(bills.map((bill) => [bill.accountId, bill]));
}

/** Whole days from the start of today, in IST, to a date. */
function daysBetween(now: Date, to: Date): number {
  const today = Date.parse(`${istDayKey(now)}T00:00:00.000+05:30`);
  return Math.round((to.getTime() - today) / (24 * 60 * 60 * 1000));
}
