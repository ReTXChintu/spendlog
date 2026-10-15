import { HydratedDocument, Types } from "mongoose";
import { Transaction, TransactionDoc } from "../models";
import { AccountType, TransactionSource } from "../types";
import { resolveAccount } from "./accounts";
import { categorizeTransaction } from "./categorizer";
import { matchEmiInstalment } from "../modules/emi/emi.matching";
import { matchLoanInstalment } from "../modules/loans/loans.matching";
import { tripForOccurredAt } from "../modules/trips/trips.service";
import { findDuplicate, detectSelfTransfer } from "./dedupe";
import { parseStatedFigures } from "./balance";
import { parseTransactionText } from "./parser";
import { horizonFor } from "../modules/ledger/ledger.horizon";
import { cardBillAccount, cardBillContext, markCardBillPayment } from "../modules/cards/cards.billPayment.service";

export interface IngestResult {
  status: "created" | "duplicate" | "ignored";
  transaction: HydratedDocument<TransactionDoc> | null;
}

/** Whether two source entries describe the same message. */
function isSameMessage(
  a: { source: string; sourceRef?: string | null; receivedAt: Date },
  b: { source: string; sourceRef?: string | null; receivedAt: Date }
): boolean {
  if (a.sourceRef && b.sourceRef) return a.sourceRef === b.sourceRef;
  return a.source === b.source && a.receivedAt.getTime() === b.receivedAt.getTime();
}

/**
 * The bank's figures a message states, sorted by what they are about. A
 * balance is a bank account's; on a card the same words would mean what
 * is owed, so it is not kept there. What is left of a limit is a card's,
 * and nothing else has one.
 */
export function statedFiguresFor(
  rawText: string,
  accountType: AccountType | null
): { balanceMinor: number | null; availableLimitMinor: number | null } {
  const figures = parseStatedFigures(rawText);
  const onCard = accountType === "CARD";
  return {
    balanceMinor: onCard ? null : figures.balanceMinor,
    availableLimitMinor: onCard ? figures.availableLimitMinor : null,
  };
}

/**
 * Single entry point for turning a raw SMS or email snippet into a stored,
 * categorized transaction. Used by both the SMS ingestion endpoint (mobile
 * posts messages here) and the Gmail sync job.
 */
export async function ingestRawMessage(params: {
  userId: Types.ObjectId;
  rawText: string;
  source: TransactionSource;
  sourceRef: string | null;
  receivedAt: Date;
}): Promise<IngestResult> {
  const parsed = parseTransactionText(params.rawText);
  if (!parsed) {
    return { status: "ignored", transaction: null };
  }

  const occurredAt = parsed.occurredAt ?? params.receivedAt;

  // Older than this ledger goes back. A mailbox holds months of alerts and
  // a phone holds years, and importing them would fill the app with a
  // period nobody meant to track. Ignored rather than stored-and-hidden:
  // a row that exists but is never shown is a row that turns up in a total
  // one day.
  const horizon = await horizonFor(params.userId);
  if (!horizon || occurredAt < horizon) {
    return { status: "ignored", transaction: null };
  }

  // A card bill payment names two accounts, and the parser alone files it
  // under the wrong one: the bank's debit under the card it paid, the
  // card's "payment received" under a bank account. See cardBillAccount.
  const context = await cardBillContext(params.userId);
  const billAccount = await cardBillAccount(params.userId, params.rawText, parsed, context);
  const accountId = billAccount ? billAccount.accountId : await resolveAccount(params.userId, parsed.account);

  // What the bank said was left, off the original text - the parser
  // strips it before it looks for the amount. A balance belongs to a
  // bank account; a card's message says what is left of its limit, and
  // the one is never the other.
  // The context was read before resolveAccount may have created the
  // account, so a first message from a new card falls back to the parse.
  const accountType = accountId
    ? (context.accountTypeOf.get(accountId.toString()) ?? parsed.account?.accountType ?? null)
    : null;
  const stated = statedFiguresFor(params.rawText, accountType);

  const duplicate = await findDuplicate({
    userId: params.userId,
    amountMinor: parsed.amountMinor,
    type: parsed.type,
    accountId,
    occurredAt,
    sourceRef: params.sourceRef,
  });
  if (duplicate) {
    // The second message is kept rather than thrown away. It is evidence
    // the transaction really happened, it is what lets the row show it was
    // seen twice, and a bank email routinely names the merchant better
    // than the SMS that arrived first.
    const entry = {
      source: params.source,
      sourceRef: params.sourceRef,
      rawText: params.rawText,
      receivedAt: params.receivedAt,
    };

    const alreadyKnown = duplicate.sources.some((existing) => isSameMessage(existing, entry));
    if (!alreadyKnown) {
      duplicate.sources.push(entry);

      // Only ever fills gaps, and only while nobody has corrected the row
      // by hand. A person's answer outranks a second parse of the same
      // event, and a value already parsed is not necessarily worse than
      // the one arriving now.
      if (!duplicate.editedAt) {
        if (!duplicate.merchant && parsed.merchant) duplicate.merchant = parsed.merchant;
        if (!duplicate.accountId && accountId) {
          duplicate.accountId = accountId;
          // The second message said which account; nobody is guessing now.
          duplicate.accountUnknown = false;
        }
        if (!duplicate.categoryId) {
          duplicate.categoryId = await categorizeTransaction({
            userId: params.userId,
            merchant: duplicate.merchant ?? null,
            rawText: params.rawText,
          });
        }
      }

      // The bank's figure is not something a person edits, so it fills in
      // whenever a message carries it: an SMS often says the balance where
      // the email for the same payment does not, and the other way round.
      if (duplicate.statedBalanceMinor == null && stated.balanceMinor !== null) {
        duplicate.statedBalanceMinor = stated.balanceMinor;
      }
      if (duplicate.statedAvailableLimitMinor == null && stated.availableLimitMinor !== null) {
        duplicate.statedAvailableLimitMinor = stated.availableLimitMinor;
      }

      await duplicate.save();

      // The second message may be the one that says what this was: a
      // bank's email often names the card a bill went to where its SMS
      // gave only an amount.
      if (!duplicate.editedAt) await markCardBillPayment(duplicate);
    }

    return { status: "duplicate", transaction: duplicate };
  }

  const categoryId = await categorizeTransaction({
    userId: params.userId,
    merchant: parsed.merchant,
    rawText: params.rawText,
  });

  // Which holiday, if any, this was spent on. Decided by when the money
  // moved rather than when the message arrived, so a late SMS still lands
  // on the right trip.
  const tripId = await tripForOccurredAt(params.userId, occurredAt);

  const transaction = await Transaction.create({
    userId: params.userId,
    accountId,
    categoryId,
    tripId,
    amountMinor: parsed.amountMinor,
    currency: parsed.currency,
    type: parsed.type,
    merchant: parsed.merchant,
    rawText: params.rawText,
    source: params.source,
    sourceRef: params.sourceRef,
    occurredAt,
    statedBalanceMinor: stated.balanceMinor,
    statedAvailableLimitMinor: stated.availableLimitMinor,
    // No account could be placed: not cash, just not known. A payment
    // typed in by hand with no account is cash; one a bank sent a message
    // about never is, and guessing cash is how the cash balance drifts.
    accountUnknown: accountId === null,
    sources: [
      {
        source: params.source,
        sourceRef: params.sourceRef,
        rawText: params.rawText,
        receivedAt: params.receivedAt,
      },
    ],
  });

  await detectSelfTransfer(transaction);
  // A card bill paid from the bank is the month's card purchases leaving
  // a second time, and the card's "payment received" is that same money
  // arriving. Neither is spending or income. See cards.billPayment.ts.
  const isCardBill = await markCardBillPayment(transaction);
  if (!isCardBill) {
    // A monthly EMI debit looks like any other payment, so the schedule is
    // ticked off here rather than waiting for someone to do it by hand.
    // Not a card bill, though, however close its amount: a bill that
    // happened to match an instalment would claim it and leave the real
    // instalment looking unpaid.
    await matchEmiInstalment(transaction);
    // Same reasoning, for a loan taken outside a card.
    await matchLoanInstalment(transaction);
  }

  return { status: "created", transaction };
}
