import { Types } from "mongoose";
import { Account, Transaction } from "../../models";
import { TransactionType } from "../../types";
import { findAccount } from "../../parsing/accounts";
import { billPaymentAccount } from "../../parsing/parser";
import { recogniseCardBill } from "../cards/cards.billPayment";
import { cardBillContext } from "../cards/cards.billPayment.service";
import { AccountLedger, DRIFT_TOLERANCE_MINOR, StatedPoint } from "./accounts.balance";

/**
 * Why an account's balance might be off from the bank's, before anyone
 * writes an adjustment.
 *
 * The passbook says where the app and the bank parted; this says what,
 * near there, could account for it. Each detector looks for one shape of
 * mistake the ledger is known to make - a message filed twice, a transfer
 * counted on both accounts, a card bill filed under the card, a payment
 * nobody could place - and says so in words, with the one change that
 * would put it right where there is one. Diagnosis first; the adjustment
 * at the end of the screen is for whatever is left.
 *
 * Pure where it can be. Every detector works on plain rows handed to it,
 * so each shape of mistake can be tested with a fixture; the service at
 * the bottom is what reads the database.
 */

export type SuspectKind =
  | "unknown_account"
  | "duplicate"
  | "one_sided_transfer"
  | "card_bill_on_card"
  | "missing_days"
  | "exact_match"
  | "missing_credit";

/** The one request that would put a suspect right, ready to send. */
export interface SuspectFix {
  method: "PATCH" | "POST";
  path: string;
  body: Record<string, unknown>;
  /// What the button says.
  label: string;
}

export interface Suspect {
  kind: SuspectKind;
  transactionIds: string[];
  /// The money the mistake accounts for, always positive.
  amountMinor: number;
  explanation: string;
  /// When it happened, or the span it happened in.
  on: Date | null;
  until?: Date | null;
  fix?: SuspectFix;
  /// Likelihood, for ordering. Higher first.
  score: number;
}

/** A transaction, as much of it as the detectors read. */
export interface SuspectRow {
  id: string;
  accountId: string | null;
  type: TransactionType;
  amountMinor: number;
  occurredAt: Date;
  merchant: string | null;
  sourceRef: string | null;
  isTransfer: boolean;
  transferAccountId: string | null;
  transferPairId: string | null;
  cardPaymentFor: string | null;
  accountUnknown: boolean;
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/// Two messages for one payment land within this of each other.
const DUPLICATE_WINDOW_MS = 10 * MINUTE_MS;
/// A transfer's two legs may post a day apart.
const TRANSFER_WINDOW_MS = DAY_MS;

const rupees = (minor: number) => `₹${(Math.abs(minor) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const day = (at: Date) => at.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

function near(a: Date, b: Date, within: number): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= within;
}

/**
 * Which way a missing or extra row would have to go to close the gap.
 *
 * The gap is the bank's figure less the app's. Negative, the app shows
 * more than the bank: a debit is missing, or a credit is here that should
 * not be. Positive, the other way round.
 */
function missingType(gapMinor: number): TransactionType {
  return gapMinor < 0 ? "DEBIT" : "CREDIT";
}
function extraType(gapMinor: number): TransactionType {
  return gapMinor < 0 ? "CREDIT" : "DEBIT";
}

function closes(gapMinor: number | null, amountMinor: number): boolean {
  return gapMinor !== null && Math.abs(Math.abs(gapMinor) - amountMinor) <= DRIFT_TOLERANCE_MINOR;
}

const name = (row: SuspectRow) => row.merchant ?? "a payment";

/**
 * Payments no account could be placed for. They move no balance, so one
 * that was really on this account is money the app never took off it.
 */
export function unknownAccountSuspects(
  unknown: SuspectRow[],
  gapMinor: number | null,
  accountId: string
): Suspect[] {
  const fix = (row: SuspectRow): SuspectFix => ({
    method: "PATCH",
    path: `/transactions/${row.id}`,
    body: { accountId },
    label: "It was on this account",
  });

  if (gapMinor === null) {
    if (unknown.length === 0) return [];
    return unknown.map((row) => ({
      kind: "unknown_account",
      transactionIds: [row.id],
      amountMinor: row.amountMinor,
      explanation: `${rupees(row.amountMinor)} to ${name(row)} on ${day(row.occurredAt)} has no account. If it was this one, it is not in the balance yet.`,
      on: row.occurredAt,
      fix: fix(row),
      score: 1,
    }));
  }

  const wanted = missingType(gapMinor);
  const fitting = unknown.filter((row) => row.type === wanted);
  const exact = fitting.filter((row) => closes(gapMinor, row.amountMinor));
  const suspects: Suspect[] = exact.map((row) => ({
    kind: "unknown_account",
    transactionIds: [row.id],
    amountMinor: row.amountMinor,
    explanation: `${rupees(row.amountMinor)} to ${name(row)} on ${day(row.occurredAt)} has no account, and it is exactly the gap. If it was this account, that is the whole difference.`,
    on: row.occurredAt,
    fix: fix(row),
    score: 5,
  }));

  // Several small ones adding up to it.
  const total = fitting.reduce((sum, row) => sum + row.amountMinor, 0);
  if (fitting.length > 1 && closes(gapMinor, total)) {
    suspects.push({
      kind: "unknown_account",
      transactionIds: fitting.map((row) => row.id),
      amountMinor: total,
      explanation: `${fitting.length} payments with no account come to ${rupees(total)} between them - the gap exactly. They may all have been on this account.`,
      on: fitting[0].occurredAt,
      until: fitting[fitting.length - 1].occurredAt,
      score: 4,
    });
  }

  // Anything else without an account is still worth a look, below the
  // ones that fit.
  for (const row of fitting) {
    if (exact.includes(row) || row.amountMinor > Math.abs(gapMinor) + DRIFT_TOLERANCE_MINOR) continue;
    suspects.push({
      kind: "unknown_account",
      transactionIds: [row.id],
      amountMinor: row.amountMinor,
      explanation: `${rupees(row.amountMinor)} to ${name(row)} on ${day(row.occurredAt)} has no account. It could be part of the gap.`,
      on: row.occurredAt,
      fix: fix(row),
      score: 1,
    });
  }
  return suspects;
}

/**
 * The same payment twice: two rows on this account, the same amount and
 * direction, minutes apart, from different messages. Automatic dedup pairs
 * them inside twenty minutes when nothing else is in the way; a row that
 * arrived with an account the other lacked, or from a message re-sent with
 * a new reference, can slip past it.
 */
export function duplicateSuspects(rows: SuspectRow[], gapMinor: number | null): Suspect[] {
  const sorted = [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const suspects: Suspect[] = [];
  const taken = new Set<string>();

  for (let i = 0; i < sorted.length; i += 1) {
    const first = sorted[i];
    if (taken.has(first.id)) continue;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const second = sorted[j];
      if (second.occurredAt.getTime() - first.occurredAt.getTime() > DUPLICATE_WINDOW_MS) break;
      if (taken.has(second.id)) continue;
      if (second.amountMinor !== first.amountMinor || second.type !== first.type) continue;
      // The same message twice is already one row; two references, or
      // one with none, is two messages that may be one payment.
      if (first.sourceRef && second.sourceRef && first.sourceRef === second.sourceRef) continue;

      taken.add(first.id);
      taken.add(second.id);
      // A doubled debit leaves the app lower than the bank; a doubled
      // credit, higher.
      const fits = gapMinor !== null && extraType(gapMinor) === first.type && closes(gapMinor, first.amountMinor);
      suspects.push({
        kind: "duplicate",
        transactionIds: [first.id, second.id],
        amountMinor: first.amountMinor,
        explanation: `${rupees(first.amountMinor)} to ${name(first)} is in twice on ${day(first.occurredAt)}, minutes apart${fits ? " - and it is exactly the gap" : ""}. Probably one payment reported by two messages.`,
        on: first.occurredAt,
        fix: {
          method: "POST",
          path: `/transactions/${first.id}/merge`,
          body: { sourceIds: [second.id] },
          label: "Merge them",
        },
        score: fits ? 5 : 3,
      });
      break;
    }
  }
  return suspects;
}

/**
 * A transfer counted on both accounts.
 *
 * A transfer recorded as one row moves the other account by itself. When
 * the other account's own message then arrives as a row too, that balance
 * moves twice. Seen from either account:
 *
 *   - a row on another account that is a one-row transfer *to* this one,
 *     and a matching row of this account's own within a day: this account
 *     is doubled;
 *   - a one-row transfer on this account *to* another, and a matching row
 *     of that account's own: the other account is doubled.
 *
 * And, lower down, a debit here with a matching credit on another account
 * that neither side calls a transfer. That one changes no balance - the
 * money did leave - but it is counted as spending, and it is listed since
 * the reconciler is where someone looks at the two together.
 */
export function oneSidedTransferSuspects(
  here: SuspectRow[],
  elsewhere: SuspectRow[],
  gapMinor: number | null,
  accountId: string
): Suspect[] {
  const suspects: Suspect[] = [];
  const opposite = (type: TransactionType) => (type === "DEBIT" ? "CREDIT" : "DEBIT");
  const pairFix = (row: SuspectRow, other: SuspectRow): SuspectFix => ({
    method: "POST",
    path: `/transactions/${row.id}/pair`,
    body: { withId: other.id },
    label: "They are one transfer",
  });
  const matching = (row: SuspectRow, pool: SuspectRow[]) =>
    pool.filter(
      (other) =>
        other.type === opposite(row.type) &&
        other.amountMinor === row.amountMinor &&
        !other.transferPairId &&
        near(other.occurredAt, row.occurredAt, TRANSFER_WINDOW_MS)
    );

  // This account doubled: the far leg of someone else's one-row transfer,
  // and our own row for the same money.
  for (const other of elsewhere) {
    if (!other.isTransfer || other.transferAccountId !== accountId || other.transferPairId) continue;
    for (const own of matching(other, here)) {
      // Our own row's effect was counted twice; an extra credit here
      // leaves the app high, an extra debit leaves it low.
      const fits = gapMinor !== null && extraType(gapMinor) === own.type && closes(gapMinor, own.amountMinor);
      suspects.push({
        kind: "one_sided_transfer",
        transactionIds: [own.id, other.id],
        amountMinor: own.amountMinor,
        explanation: `${rupees(own.amountMinor)} on ${day(own.occurredAt)} is counted twice here: once as this account's own row and once as the far side of a transfer recorded on the other account${fits ? " - exactly the gap" : ""}.`,
        on: own.occurredAt,
        fix: pairFix(own, other),
        score: fits ? 5 : 3,
      });
    }
  }

  // The other account doubled by a one-row transfer of ours.
  for (const own of here) {
    if (!own.isTransfer || !own.transferAccountId || own.transferPairId) continue;
    for (const other of matching(own, elsewhere.filter((row) => row.accountId === own.transferAccountId))) {
      suspects.push({
        kind: "one_sided_transfer",
        transactionIds: [own.id, other.id],
        amountMinor: own.amountMinor,
        explanation: `The transfer of ${rupees(own.amountMinor)} on ${day(own.occurredAt)} moves the other account by itself, and that account has its own row for it too - its balance is off by this, not this one's.`,
        on: own.occurredAt,
        fix: pairFix(own, other),
        score: 2,
      });
    }
  }

  // Looks like a transfer, counted as spending.
  for (const own of here) {
    if (own.isTransfer || own.type !== "DEBIT" || own.cardPaymentFor) continue;
    for (const other of matching(own, elsewhere.filter((row) => !row.isTransfer && row.accountId))) {
      suspects.push({
        kind: "one_sided_transfer",
        transactionIds: [own.id, other.id],
        amountMinor: own.amountMinor,
        explanation: `${rupees(own.amountMinor)} left here on ${day(own.occurredAt)} and the same arrived on another account of yours within a day. It does not change this balance, but it is counted as spending when it looks like a transfer.`,
        on: own.occurredAt,
        fix: pairFix(own, other),
        score: 0,
      });
    }
  }

  return suspects;
}

/**
 * Where the bank's balance moved by more than the rows between two of its
 * figures explain: something in those days was never captured.
 *
 * Between two consecutive stated figures the drift should not change. Where
 * it does, the difference is money that moved and left no row - the
 * tightest statement the ledger can make about what is missing and when.
 */
export function missingDaysSuspects(ledger: AccountLedger, fromSeq: number): Suspect[] {
  const stated = ledger.entries.filter((entry) => entry.statedMinor !== null && entry.driftMinor !== null);
  const suspects: Suspect[] = [];

  for (let index = 1; index < stated.length; index += 1) {
    const before = stated[index - 1];
    const after = stated[index];
    if (after.seq < fromSeq) continue;

    const unexplained = after.driftMinor! - before.driftMinor!;
    if (Math.abs(unexplained) <= DRIFT_TOLERANCE_MINOR) continue;

    const between = ledger.entries
      .filter((entry) => entry.seq > before.seq && entry.seq <= after.seq && entry.transactionId)
      .map((entry) => entry.transactionId!);
    const span = day(before.at) === day(after.at) ? `on ${day(after.at)}` : `between ${day(before.at)} and ${day(after.at)}`;
    suspects.push({
      kind: "missing_days",
      transactionIds: between.slice(0, 20),
      amountMinor: Math.abs(unexplained),
      explanation:
        unexplained < 0
          ? `${span}, ${rupees(unexplained)} more left the account than the rows in between explain. A payment in those days was not captured.`
          : `${span}, ${rupees(unexplained)} more arrived than the rows in between explain. Money in during those days was not captured.`,
      on: before.at,
      until: after.at,
      // The span where the drift first appeared is the one that matters.
      score: ledger.firstDrift && after.seq === ledger.firstDrift.seq ? 4 : 2,
    });
  }
  return suspects;
}

/**
 * One row that is the gap on its own. Probably a duplicate automatic
 * dedup did not see, or a payment filed on this account that was on
 * another; either way, the first thing to look at.
 */
export function exactMatchSuspects(rows: SuspectRow[], gapMinor: number | null, alreadyNamed: Set<string>): Suspect[] {
  if (gapMinor === null) return [];
  const wanted = extraType(gapMinor);
  return rows
    .filter((row) => !alreadyNamed.has(row.id) && row.type === wanted && closes(gapMinor, row.amountMinor))
    .map((row) => ({
      kind: "exact_match" as const,
      transactionIds: [row.id],
      amountMinor: row.amountMinor,
      explanation: `${rupees(row.amountMinor)} to ${name(row)} on ${day(row.occurredAt)} is exactly the gap. If the bank does not show it on this account, it is a duplicate or was filed on the wrong account.`,
      on: row.occurredAt,
      score: 2,
    }));
}

/**
 * Money in the bank never texted about. On an account whose bank sends no
 * message for money coming in (noCreditAlerts), a gap the bank's way -
 * the bank showing more than SpendLog - is that before it is anything
 * else, so it is said first. There is no one-tap fix: what the money was
 * is the user's to say, or the statement's.
 */
export function missingCreditSuspects(
  account: { noCreditAlerts?: boolean } | null | undefined,
  ledger: AccountLedger,
  gapMinor: number | null
): Suspect[] {
  if (!account?.noCreditAlerts || gapMinor === null || gapMinor <= DRIFT_TOLERANCE_MINOR) return [];
  const window = suspectWindow(ledger);
  const until = ledger.lastStated?.at ?? null;
  return [
    {
      kind: "missing_credit",
      transactionIds: [],
      amountMinor: gapMinor,
      explanation: `This bank doesn't text you about money coming in, so the ${rupees(gapMinor)} it shows over SpendLog is most likely a credit that arrived without a message${until ? ` before ${day(until)}` : ""}. Add it, or read the statement for those days.`,
      on: window.from,
      until,
      score: 10,
    },
  ];
}

/** Likeliest first, then earliest. */
export function rankSuspects(suspects: Suspect[]): Suspect[] {
  return [...suspects].sort(
    (a, b) => b.score - a.score || (a.on?.getTime() ?? 0) - (b.on?.getTime() ?? 0)
  );
}

type TransactionLike = {
  _id: Types.ObjectId;
  accountId?: Types.ObjectId | null;
  type: TransactionType;
  amountMinor: number;
  occurredAt: Date;
  merchant?: string | null;
  sourceRef?: string | null;
  isTransfer?: boolean;
  transferAccountId?: Types.ObjectId | null;
  transferPairId?: Types.ObjectId | null;
  cardPaymentFor?: Types.ObjectId | null;
  accountUnknown?: boolean;
  rawText?: string | null;
  sources?: { rawText?: string | null }[];
};

export function toSuspectRow(row: TransactionLike): SuspectRow {
  return {
    id: row._id.toString(),
    accountId: row.accountId?.toString() ?? null,
    type: row.type,
    amountMinor: row.amountMinor,
    occurredAt: row.occurredAt,
    merchant: row.merchant ?? null,
    sourceRef: row.sourceRef ?? null,
    isTransfer: Boolean(row.isTransfer),
    transferAccountId: row.transferAccountId?.toString() ?? null,
    transferPairId: row.transferPairId?.toString() ?? null,
    cardPaymentFor: row.cardPaymentFor?.toString() ?? null,
    accountUnknown: Boolean(row.accountUnknown),
  };
}

const SUSPECT_FIELDS =
  "accountId type amountMinor occurredAt merchant sourceRef isTransfer transferAccountId transferPairId cardPaymentFor accountUnknown rawText sources";

/**
 * Where to look: from the last stated figure the app agreed with before
 * the drift began, to now - or the whole history when the bank has never
 * said a figure, since nothing then narrows it.
 */
export function suspectWindow(ledger: AccountLedger): { from: Date; fromSeq: number; clean: StatedPoint | null } {
  if (ledger.firstDrift) {
    const clean = ledger.cleanBefore;
    return { from: clean?.at ?? ledger.openingAt, fromSeq: clean?.seq ?? 0, clean };
  }
  return { from: ledger.openingAt, fromSeq: 0, clean: null };
}

/**
 * Every suspect for an account, likeliest first.
 *
 * The gap is the bank's latest figure less the app's at that figure; null
 * when the bank has never given one, in which case the detectors that
 * need a figure to fit are quiet and the structural ones speak.
 */
export async function suspectsFor(
  userId: Types.ObjectId,
  ledger: AccountLedger,
  account?: { noCreditAlerts?: boolean } | null
): Promise<Suspect[]> {
  const accountId = ledger.accountId;
  const gapMinor = ledger.lastStated?.driftMinor ?? null;
  const window = suspectWindow(ledger);

  const accounts = await Account.find({ userId }).select("accountType linkedAccountId");
  const mine = new Set([
    accountId,
    ...accounts
      .filter((account) => account.accountType === "DEBIT" && account.linkedAccountId?.toString() === accountId)
      .map((account) => account._id.toString()),
  ]);
  const cardIds = new Set(accounts.filter((account) => account.accountType === "CARD").map((account) => account._id.toString()));

  const rows = await Transaction.find({ userId, occurredAt: { $gte: window.from } })
    .select(SUSPECT_FIELDS)
    .sort({ occurredAt: 1 })
    .lean<TransactionLike[]>();

  const here = rows.filter((row) => row.accountId && mine.has(row.accountId.toString())).map(toSuspectRow);
  const elsewhere = rows.filter((row) => row.accountId && !mine.has(row.accountId.toString())).map(toSuspectRow);
  const unknown = rows.filter((row) => !row.accountId && row.accountUnknown).map(toSuspectRow);

  const suspects: Suspect[] = [
    ...missingCreditSuspects(account, ledger, gapMinor),
    ...unknownAccountSuspects(unknown, gapMinor, accountId),
    ...duplicateSuspects(here, gapMinor),
    ...oneSidedTransferSuspects(here, elsewhere, gapMinor, accountId),
    ...(await cardBillOnCardSuspects(userId, rows, cardIds, accountId, gapMinor)),
    ...missingDaysSuspects(ledger, window.fromSeq),
  ];
  const named = new Set(suspects.flatMap((suspect) => suspect.transactionIds));
  suspects.push(...exactMatchSuspects(here, gapMinor, named));

  return rankSuspects(suspects);
}

/**
 * A card bill filed under the card it paid. The bank's message names both
 * the account debited and the card, and the parser used to take the card
 * for the account - so the money never left this account in the app.
 * Only where the message names this very account as the one debited.
 */
async function cardBillOnCardSuspects(
  userId: Types.ObjectId,
  rows: TransactionLike[],
  cardIds: Set<string>,
  accountId: string,
  gapMinor: number | null
): Promise<Suspect[]> {
  const candidates = rows.filter(
    (row) =>
      row.type === "DEBIT" &&
      row.accountId &&
      cardIds.has(row.accountId.toString()) &&
      !row.cardPaymentFor &&
      !row.isTransfer
  );
  if (candidates.length === 0) return [];

  const context = await cardBillContext(userId);
  const suspects: Suspect[] = [];
  for (const row of candidates) {
    const text = [row.rawText, ...(row.sources ?? []).map((entry) => entry.rawText)].filter(Boolean).join(" \n ");
    if (!text) continue;
    const match = recogniseCardBill(
      { text, type: "DEBIT", accountId: row.accountId!.toString(), accountType: "CARD" },
      context.cards
    );
    if (match?.side !== "PAYMENT") continue;

    const bank = await findAccount(userId, billPaymentAccount(text, "PAYMENT"));
    if (!bank || bank.toString() !== accountId) continue;

    const fits = gapMinor !== null && gapMinor < 0 && closes(gapMinor, row.amountMinor);
    suspects.push({
      kind: "card_bill_on_card",
      transactionIds: [row._id.toString()],
      amountMinor: row.amountMinor,
      explanation: `The card bill of ${rupees(row.amountMinor)} on ${day(row.occurredAt)} is filed under the card it paid. The message says it left this account${fits ? ", and it is exactly the gap" : ""}.`,
      on: row.occurredAt,
      fix: {
        method: "PATCH",
        path: `/transactions/${row._id.toString()}`,
        body: { accountId, cardPaymentFor: match.cardId ?? row.accountId!.toString() },
        label: "Move it to this account",
      },
      score: fits ? 5 : 4,
    });
  }
  return suspects;
}
