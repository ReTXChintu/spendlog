import { HydratedDocument } from "mongoose";
import { AccountDoc } from "../../models";
import { StatementKind } from "../../types";
import { istDayKey } from "../../time";

/**
 * Teaching a card its own billing cycle, from the statements that arrive.
 *
 * Everything about a credit card in SpendLog hangs off statementDay: the
 * cycle, the float, and - the one that is felt daily - the period the
 * personal spend limit is measured over. Until now it was only ever typed
 * in by hand, and a card that had never been told its statement day fell
 * back to the calendar month. So the limit reset on the 1st, which for a
 * card that bills on the 17th is wrong for three weeks of every four.
 *
 * The statement itself knows. It is the bank's own document, it prints the
 * date it was drawn, and it arrives every month without being asked - so
 * the day it names outranks anything typed in, and this keeps the two in
 * step for as long as the card lives.
 *
 * Deliberately not the same thing as resetting the counter when the mail
 * lands. The nominal day, learned from reality, still rolls the cycle over
 * on time in a month when Gmail is down, the sync is broken or the bank
 * simply sends late; a counter that waited for an email would sit there
 * showing last month's spending against this month's limit, and the whole
 * point of the limit is that it is right at a till.
 */

/** The IST day of the month an instant falls on, and that month's length. */
function dayAndMonthEnd(instant: Date): { day: number; monthEnd: number } {
  const key = istDayKey(instant);
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));

  // Day 0 of the next month is the last day of this one, so a month's
  // length never has to be a table or a leap-year rule.
  return {
    day: Number(key.slice(8, 10)),
    monthEnd: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
}

/**
 * The day to store, or null to leave what is there.
 *
 * The trap is the short month. A card that bills on the 31st has a
 * February statement dated the 28th, because the bank clamps it exactly
 * the way cycleFor does - and learning 28 from that would move the cycle
 * permanently, in February, on the strength of a date that was never the
 * card's real billing day.
 *
 * So a day that is its own month's last never overrides a larger one
 * already known. It still overrides a smaller one: 28 against a stored 15
 * is a correction, not a clamp, because nothing clamps 15 up.
 */
export function dayFromStatement(printed: Date, stored: number | null | undefined): number | null {
  const { day, monthEnd } = dayAndMonthEnd(printed);

  if (day === monthEnd && (stored ?? 0) > day) return null;

  return day === stored ? null : day;
}

/** What an arriving statement taught the card, for saying so afterwards. */
export interface CycleLearned {
  statementDay?: number;
  dueDay?: number;
}

/**
 * Update a card's cycle from a statement that has just been read.
 *
 * Card statements only. A bank statement has a period but no billing
 * cycle, and no personal spend limit resetting on the back of it.
 *
 * Returns what changed, or null when the card already knew - which is the
 * usual answer, since a card's statement day is the same every month.
 */
export async function learnCycleFromStatement(
  card: HydratedDocument<AccountDoc>,
  statement: { kind: StatementKind; statementDate?: Date | null; dueDate?: Date | null }
): Promise<CycleLearned | null> {
  if (statement.kind !== "CARD" || card.accountType !== "CARD") return null;

  const learned: CycleLearned = {};

  const statementDay = statement.statementDate
    ? dayFromStatement(statement.statementDate, card.statementDay)
    : null;
  if (statementDay !== null) learned.statementDay = statementDay;

  const dueDay = statement.dueDate ? dayFromStatement(statement.dueDate, card.dueDay) : null;
  if (dueDay !== null) learned.dueDay = dueDay;

  if (learned.statementDay === undefined && learned.dueDay === undefined) return null;

  // Assigned to the document as well as saved, because a sync reads several
  // statements against one array of cards. Leaving the copy in memory stale
  // would hand the next statement of the same card an out-of-date `stored`
  // to compare against, which is exactly the value the short-month guard
  // above depends on being right.
  if (learned.statementDay !== undefined) card.statementDay = learned.statementDay;
  if (learned.dueDay !== undefined) card.dueDay = learned.dueDay;
  await card.save();

  return learned;
}
