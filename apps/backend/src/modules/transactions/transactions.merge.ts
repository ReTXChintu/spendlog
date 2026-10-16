import { HydratedDocument } from "mongoose";
import { TransactionDoc, TransactionSourceEntry } from "../../models";
import { handOverLegs } from "./transactions.transfer";

/** Whether two source entries describe the same message. */
function isSameMessage(a: TransactionSourceEntry, b: TransactionSourceEntry): boolean {
  if (a.sourceRef && b.sourceRef) return a.sourceRef === b.sourceRef;
  return a.source === b.source && new Date(a.receivedAt).getTime() === new Date(b.receivedAt).getTime();
}

/**
 * Folds rows that are the same money into the one that survives: their
 * messages join its sources, they fill whatever it is missing, any pairing
 * they had passes to it, and they stop existing on their own - each kept
 * verbatim in mergedFrom, so an unmerge restores it as it was.
 *
 * What POST /transactions/:id/merge does for a person, and what a repair
 * does for a duplicate it is sure of. Saves the target.
 */
export async function mergeTransactions(
  target: HydratedDocument<TransactionDoc>,
  sources: HydratedDocument<TransactionDoc>[]
): Promise<void> {
  for (const source of sources) {
    for (const entry of source.sources) {
      if (!target.sources.some((existing) => isSameMessage(existing, entry))) {
        target.sources.push(entry);
      }
    }

    // Gaps only. Whatever the surviving row already says is the answer,
    // and it can be corrected by hand afterwards either way.
    if (!target.merchant && source.merchant) target.merchant = source.merchant;
    if (!target.accountId && source.accountId) {
      target.accountId = source.accountId;
      target.accountUnknown = false;
    }
    if (!target.categoryId && source.categoryId) target.categoryId = source.categoryId;
    if (!target.note && source.note) target.note = source.note;
    // The bank's figures: whichever message had them.
    if (target.statedBalanceMinor == null && source.statedBalanceMinor != null) {
      target.statedBalanceMinor = source.statedBalanceMinor;
    }
    if (target.statedAvailableLimitMinor == null && source.statedAvailableLimitMinor != null) {
      target.statedAvailableLimitMinor = source.statedAvailableLimitMinor;
    }

    // A leg of a transfer is still one once merged: the pairing moves to
    // the row that survives.
    await handOverLegs(source, target);

    // Verbatim, so unmerging restores the row rather than approximating it.
    target.mergedFrom.push(source.toObject() as unknown as Record<string, unknown>);
    await source.deleteOne();
  }

  await target.save();
}
