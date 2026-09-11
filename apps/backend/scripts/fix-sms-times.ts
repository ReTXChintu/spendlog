/**
 * Shifts transactions that were stored 5½ hours late back to the instant
 * they really happened.
 *
 *   npm run fix:sms-times --workspace apps/backend -- --before 2026-09-12
 *   npm run fix:sms-times --workspace apps/backend -- --before 2026-09-12 --apply
 *
 * Older builds of the Android app sent the message time with no timezone
 * on it — "2026-09-11T19:21:00.000" — and the server, running in UTC, read
 * that as 19:21 UTC rather than 19:21 IST. The instant stored was 5½ hours
 * later than the truth, which is why a payment at 7:21pm turned up as
 * 12:51am the next morning.
 *
 * The app sends UTC now, so only rows written before that reached your
 * phone are affected — hence --before, which you set to the day you
 * installed the fixed build. Everything is a dry run until --apply.
 *
 * There is no way to tell a corrupted instant from a correct one by
 * looking at it, so the cutoff is the only safeguard. Read the listing
 * before applying.
 */
import { connectDatabase } from "../src/db";
import { Transaction } from "../src/models";
import { IST_OFFSET_MS, istDayKey } from "../src/time";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function formatIst(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS)
    .toISOString()
    .replace("T", " ")
    .slice(0, 16);
}

async function main() {
  const before = arg("before");
  const apply = process.argv.includes("--apply");

  if (!before || !/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    console.error("Give the day you installed the fixed app: --before YYYY-MM-DD");
    process.exit(1);
  }

  await connectDatabase();

  // Only messages from the phone. Email timestamps come from Gmail as real
  // instants and were never affected.
  const affected = await Transaction.find({
    source: "SMS",
    createdAt: { $lt: new Date(`${before}T00:00:00.000+05:30`) },
  }).sort({ occurredAt: 1 });

  if (affected.length === 0) {
    console.log("Nothing to fix.");
    process.exit(0);
  }

  console.log(`${affected.length} transaction${affected.length === 1 ? "" : "s"} from SMS before ${before}:\n`);
  let movesDay = 0;

  for (const transaction of affected) {
    const corrected = new Date(transaction.occurredAt.getTime() - IST_OFFSET_MS);
    const dayChanges = istDayKey(corrected) !== istDayKey(transaction.occurredAt);
    if (dayChanges) movesDay += 1;

    console.log(
      `  ${formatIst(transaction.occurredAt)} -> ${formatIst(corrected)}` +
        `${dayChanges ? "  (moves to another day)" : ""}` +
        `   ${transaction.merchant ?? "Unknown"}`
    );

    if (apply) {
      transaction.occurredAt = corrected;
      await transaction.save();
    }
  }

  console.log(
    `\n${movesDay} of them move to a different day.` +
      (apply ? "\nApplied." : "\nDry run — nothing was changed. Re-run with --apply to make it so.")
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
