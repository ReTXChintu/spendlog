/**
 * Teaches every card its billing day from the statements already stored.
 *
 *   npm run backfill:cycles --workspace apps/backend
 *   npm run backfill:cycles --workspace apps/backend -- --email you@example.com
 *   npm run backfill:cycles --workspace apps/backend -- --apply
 *
 * From this release a card learns its statement day and due day from each
 * statement as it arrives. That only helps from the next statement on,
 * and the ones already read know the answer - so this walks them.
 *
 * Worth doing rather than waiting a month, because until a card knows its
 * statement day its personal spend limit is measured over the calendar
 * month. It resets on the 1st instead of on the day the bill is drawn,
 * which for most cards is wrong for most of the month.
 *
 * Newest statement last, so a card with several ends up on the most recent
 * one, and through learnCycleFromStatement rather than a second copy of
 * the rule - including the short-month guard, which matters here more than
 * anywhere: a backfill walks a February statement like any other.
 *
 * A dry run until --apply.
 */
import { connectDatabase, disconnectDatabase } from "../src/db";
import { Account, CardStatement, User } from "../src/models";
import { dayFromStatement, learnCycleFromStatement } from "../src/modules/cards/cards.learn";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const apply = process.argv.includes("--apply");

async function main(): Promise<void> {
  await connectDatabase();

  const email = arg("email");
  const owner = email ? await User.findOne({ email }) : null;
  if (email && !owner) {
    console.error(`No account with the email ${email}.`);
    await disconnectDatabase();
    process.exit(1);
  }

  const cards = await Account.find({
    accountType: "CARD",
    ...(owner ? { userId: owner._id } : {}),
  });

  console.log(`\n${cards.length} card${cards.length === 1 ? "" : "s"} to look at.\n`);

  let taught = 0;
  let already = 0;
  let unknown = 0;

  for (const card of cards) {
    const statements = await CardStatement.find({
      userId: card.userId,
      accountId: card._id,
      kind: "CARD",
      statementDate: { $ne: null },
    }).sort({ statementDate: 1 });

    const name = `${card.nickname?.trim() || card.bankName}${card.last4 ? ` ••${card.last4}` : ""}`;
    const before = { statementDay: card.statementDay ?? null, dueDay: card.dueDay ?? null };

    if (statements.length === 0) {
      unknown += 1;
      console.log(
        `  ${name.padEnd(28)} no statements read yet` +
          (before.statementDay ? ` (keeps its ${before.statementDay})` : " — still on the calendar month")
      );
      continue;
    }

    // Applied for real, or worked out in memory only. The dry run has to
    // walk every statement the same way, because each one's answer depends
    // on what the one before it taught - that is the whole of the
    // short-month guard.
    let learnedAnything = false;
    for (const statement of statements) {
      if (apply) {
        const learned = await learnCycleFromStatement(card, statement);
        if (learned) learnedAnything = true;
        continue;
      }

      const day = statement.statementDate
        ? dayFromStatement(statement.statementDate, card.statementDay)
        : null;
      if (day !== null) {
        card.statementDay = day;
        learnedAnything = true;
      }

      const due = statement.dueDate ? dayFromStatement(statement.dueDate, card.dueDay) : null;
      if (due !== null) {
        card.dueDay = due;
        learnedAnything = true;
      }
    }

    const from = before.statementDay === null ? "nothing" : `the ${before.statementDay}`;
    if (learnedAnything) {
      taught += 1;
      console.log(
        `  ${name.padEnd(28)} ${from} -> statements on the ${card.statementDay}` +
          (card.dueDay ? `, due the ${card.dueDay}` : "") +
          `   (${statements.length} statement${statements.length === 1 ? "" : "s"})`
      );
    } else {
      already += 1;
      console.log(`  ${name.padEnd(28)} already knew: the ${card.statementDay}`);
    }
  }

  console.log(
    `\n${taught} taught, ${already} already knew, ${unknown} with no statement to learn from.`
  );

  if (!apply) console.log("\nDry run. Nothing was changed. Add --apply to do it.\n");
  else console.log("");

  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error(error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
