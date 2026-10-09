import { Types } from "mongoose";

/**
 * Money filed under Lent & borrowed is never spending or income, however
 * it got there.
 *
 * The editors say so with a kind - Lent on a payment, Paid back on money
 * in - but a row can reach that category without one: a merchant shortcut
 * named after a friend, a category rule an import applied, a category
 * picked by hand while the kind was left on Normal. Counted as it stands,
 * that row puts a loan to a friend in the monthly budget. So a plain row
 * in the people category is read as what the category says it is, by the
 * write hooks and by the one-off pass that mends the rows already saved.
 *
 * A plain shape rather than a document, like counted.ts, so the same rule
 * runs on a document being saved, on a pending update merged over the
 * stored row, and on a raw row in the backfill.
 */
export interface LendingInput {
  type: string;
  amountMinor: number;
  categoryId?: unknown;
  merchant?: string | null;
  isTransfer?: boolean | null;
  cardPaymentFor?: unknown;
  emiRole?: string | null;
  emiPlanId?: unknown;
  loanId?: unknown;
  isSettlement?: boolean | null;
  split?: { myShareMinor?: number | null } | null;
  refundOf?: unknown[] | null;
  isEarmarked?: boolean | null;
  isSalary?: boolean | null;
  people?: { contactId: unknown; amountMinor: number }[] | null;
}

export type LendingKind = "LENT" | "PAID_BACK";

/**
 * Whether a row says nothing about what kind of money it is - the only
 * rows this rule touches. Anything already marked (a split, settling up, a
 * transfer, a card bill, a loan, an EMI, a refund, money set aside, pay)
 * was marked by someone or something that knew better, and is left alone.
 */
export function isPlain(transaction: LendingInput): boolean {
  if (transaction.isTransfer || transaction.cardPaymentFor || transaction.isSettlement) return false;
  if (transaction.split) return false;
  if (transaction.loanId || transaction.emiRole || transaction.emiPlanId) return false;
  if ((transaction.refundOf ?? []).length > 0) return false;
  if (transaction.isEarmarked || transaction.isSalary) return false;
  return true;
}

/** What a plain row in the people category really is, or null for any other row. */
export function lendingKindOf(
  transaction: LendingInput,
  peopleCategoryId: Types.ObjectId | null
): LendingKind | null {
  if (!peopleCategoryId || !transaction.categoryId) return null;
  if (String(transaction.categoryId) !== peopleCategoryId.toString()) return null;
  if (!isPlain(transaction)) return null;
  return transaction.type === "DEBIT" ? "LENT" : "PAID_BACK";
}

/**
 * The one contact a merchant names, or null.
 *
 * Exact names only, ignoring case and stray spaces. Two contacts called
 * "Rahul" is not a reason to pick one of them: a balance on the wrong
 * person is worse than none, and the row counts as nothing either way.
 */
export function contactForMerchant(
  merchant: string | null | undefined,
  contacts: { _id: Types.ObjectId; name: string }[]
): Types.ObjectId | null {
  const wanted = merchant?.trim().toLowerCase();
  if (!wanted) return null;
  const matches = contacts.filter((contact) => contact.name.trim().toLowerCase() === wanted);
  return matches.length === 1 ? matches[0]._id : null;
}

export interface LendingFields {
  split?: { myShareMinor: number; groupLabel: null };
  isSettlement?: boolean;
  people: { contactId: Types.ObjectId; amountMinor: number }[];
}

/**
 * The fields that make a plain row in the people category what it is:
 * lent, all of it owed back, or paid back. Whoever it was with keeps the
 * whole amount when the row already names them or `contactId` does;
 * otherwise nobody, and it still counts as nothing.
 */
export function lendingFields(
  transaction: LendingInput,
  kind: LendingKind,
  contactId: Types.ObjectId | null
): LendingFields {
  const people =
    transaction.people && transaction.people.length > 0
      ? transaction.people.map((person) => ({
          contactId: new Types.ObjectId(String(person.contactId)),
          amountMinor: person.amountMinor,
        }))
      : contactId
        ? [{ contactId, amountMinor: transaction.amountMinor }]
        : [];
  return kind === "LENT"
    ? { split: { myShareMinor: 0, groupLabel: null }, people }
    : { isSettlement: true, people };
}
