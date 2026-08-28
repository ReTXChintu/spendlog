import { prisma } from "./db";
import { DEFAULT_CATEGORIES } from "./parsing/default-categories";

// Populates the system default categories and their keyword rules. Safe to
// re-run: matches on name for categories (userId null) and skips rules that
// already exist for a given category+pattern pair.
async function main() {
  for (const seed of DEFAULT_CATEGORIES) {
    const category = await prisma.category.upsert({
      where: { id: `system-${seed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` },
      update: { icon: seed.icon, color: seed.color },
      create: {
        id: `system-${seed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: seed.name,
        icon: seed.icon,
        color: seed.color,
        isSystem: true,
        userId: null,
      },
    });

    for (const keyword of seed.keywords) {
      const existing = await prisma.categoryRule.findFirst({
        where: { userId: null, categoryId: category.id, pattern: keyword },
      });
      if (!existing) {
        await prisma.categoryRule.create({
          data: {
            userId: null,
            categoryId: category.id,
            matchType: "MERCHANT_CONTAINS",
            pattern: keyword,
            priority: 0,
          },
        });
      }
    }
  }

  console.log(`Seeded ${DEFAULT_CATEGORIES.length} default categories.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
