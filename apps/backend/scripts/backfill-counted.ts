/**
 * Sets countedAmountMinor / countedReason on transactions written before
 * those fields existed.
 *
 *   npm run backfill:counted --workspace apps/backend
 *
 * Safe to run more than once: it recomputes from the same rule the write
 * hooks use, so a second run changes nothing. Rows already carrying a
 * non-default value are still recomputed, which is what makes it useful
 * after the rule itself changes.
 */
import { connectDatabase } from "../src/db";
import { Transaction } from "../src/models";
import { resolveCountedAmount } from "../src/models/counted";

async function main() {
  await connectDatabase();

  const cursor = Transaction.find({}).cursor();
  let seen = 0;
  let changed = 0;
  const byReason = new Map<string, number>();

  for await (const transaction of cursor) {
    seen += 1;
    const counted = resolveCountedAmount(transaction);
    byReason.set(counted.countedReason, (byReason.get(counted.countedReason) ?? 0) + 1);

    if (
      transaction.countedAmountMinor === counted.countedAmountMinor &&
      transaction.countedReason === counted.countedReason
    ) {
      continue;
    }

    // updateOne rather than save(), to avoid re-running validation and
    // hooks on rows that predate fields those hooks expect.
    await Transaction.updateOne({ _id: transaction._id }, { $set: counted });
    changed += 1;
  }

  console.log(`Checked ${seen} transactions, updated ${changed}.`);
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(12)} ${count}`);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
