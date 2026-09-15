/**
 * Sets where one account's ledger starts, and clears out what came in
 * before it.
 *
 *   npm run ledger:start --workspace apps/backend -- --email you@example.com
 *   npm run ledger:start --workspace apps/backend -- --email you@example.com --month 2026-09
 *   npm run ledger:start --workspace apps/backend -- --email you@example.com --apply
 *
 * For accounts that imported months of history before there was a horizon
 * to stop them. Everything is a dry run until --apply, and the listing it
 * prints is the thing to read: this deletes transactions and there is no
 * undo.
 *
 * --month defaults to the month the account was created, which is the
 * default the app itself uses. Anything typed in by hand is kept whatever
 * its date - the horizon decides what SpendLog goes and fetches, not what
 * somebody is allowed to remember - so the counts below separate the two.
 *
 * The same planPurge/purgeBeforeHorizon the app's own button uses, rather
 * than a second copy of the rule that could drift from it.
 */
import { connectDatabase, disconnectDatabase } from "../src/db";
import { Transaction, User } from "../src/models";
import { istMonthStart } from "../src/time";
import {
  defaultHorizon,
  isMonthKey,
  planPurge,
  purgeBeforeHorizon,
} from "../src/modules/ledger/ledger.horizon";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const apply = process.argv.includes("--apply");

async function main(): Promise<void> {
  const email = arg("email");
  if (!email) {
    console.error("Which account? Pass --email you@example.com");
    process.exit(1);
  }

  await connectDatabase();

  const user = await User.findOne({ email });
  if (!user) {
    console.error(`No account with the email ${email}.`);
    await disconnectDatabase();
    process.exit(1);
  }

  const month = arg("month") ?? user.ledgerFrom ?? defaultHorizon(user.createdAt);
  if (!isMonthKey(month)) {
    console.error(`"${month}" is not a month. They look like 2026-09.`);
    await disconnectDatabase();
    process.exit(1);
  }

  console.log(`\nAccount   ${email}`);
  console.log(`Created   ${user.createdAt.toISOString().slice(0, 10)}`);
  console.log(`Ledger    ${user.ledgerFrom ?? "(not set, reads as " + defaultHorizon(user.createdAt) + ")"}`);
  console.log(`Setting   ${month}\n`);

  // Set first, because the purge measures against what the user says
  // rather than against an argument passed alongside it. One source of
  // truth, even inside a script that has both in hand.
  if (apply) {
    user.ledgerFrom = month;
    await user.save();
  } else {
    user.ledgerFrom = month;
  }

  const plan = await planPurge(user._id);
  if (!plan) {
    console.error("Could not read the account back.");
    await disconnectDatabase();
    process.exit(1);
  }

  // A sample rather than the whole list. The point is to recognise the
  // months, not to read several hundred rows.
  const sample = await Transaction.find({
    userId: user._id,
    occurredAt: { $lt: istMonthStart(month) },
    source: { $ne: "MANUAL" },
  })
    .sort({ occurredAt: -1 })
    .limit(8)
    .select("occurredAt merchant amountMinor source");

  console.log(`Before ${month}:`);
  console.log(`  ${plan.imported} imported transactions   <- these go`);
  console.log(`  ${plan.manual} entered by hand           <- these stay`);
  console.log(`  ${plan.statements} statements              <- these go\n`);

  if (sample.length > 0) {
    console.log("Most recent of the ones that would go:");
    for (const row of sample) {
      console.log(
        `  ${row.occurredAt.toISOString().slice(0, 10)}  ` +
          `${String(row.amountMinor / 100).padStart(10)}  ` +
          `${(row.source ?? "").padEnd(7)} ${row.merchant ?? ""}`
      );
    }
    console.log("");
  }

  if (!apply) {
    console.log("Dry run. Nothing was changed. Add --apply to do it.\n");
    await disconnectDatabase();
    return;
  }

  const result = await purgeBeforeHorizon(user._id);
  console.log(
    `Done. Removed ${result?.transactionsDeleted ?? 0} transactions and ` +
      `${result?.statementsDeleted ?? 0} statements.\n`
  );

  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
