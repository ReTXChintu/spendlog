import { connectDatabase, disconnectDatabase } from "./db";
import { Category, CategoryRule } from "./models";
import { DEFAULT_CATEGORIES } from "./parsing/default-categories";

// Populates the system default categories and their keyword rules.
// Safe to re-run: system categories are matched by name (with userId null)
// and rules by category + pattern, so nothing is duplicated.
async function main() {
  await connectDatabase();

  for (const seed of DEFAULT_CATEGORIES) {
    const category = await Category.findOneAndUpdate(
      { name: seed.name, userId: null, isSystem: true },
      { $set: { icon: seed.icon, color: seed.color } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    for (const keyword of seed.keywords) {
      await CategoryRule.updateOne(
        { userId: null, categoryId: category._id, pattern: keyword },
        { $setOnInsert: { matchType: "MERCHANT_CONTAINS", priority: 0 } },
        { upsert: true, setDefaultsOnInsert: true }
      );
    }
  }

  console.log(`Seeded ${DEFAULT_CATEGORIES.length} default categories.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
