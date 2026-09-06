import { prisma } from "./db";
import { DEFAULT_CATEGORIES } from "./parsing/default-categories";

// Populates the system default categories and their keyword rules.
// Safe to re-run: system categories are matched by name (with userId null)
// and rules by category + pattern, so nothing is duplicated. Lookups use
// findFirst rather than upsert because the natural key here includes a
// nullable userId, which Prisma won't accept in a unique `where`.
async function main() {
  for (const seed of DEFAULT_CATEGORIES) {
    let category = await prisma.category.findFirst({
      where: { name: seed.name, userId: null, isSystem: true },
    });

    if (category) {
      category = await prisma.category.update({
        where: { id: category.id },
        data: { icon: seed.icon, color: seed.color },
      });
    } else {
      category = await prisma.category.create({
        data: {
          name: seed.name,
          icon: seed.icon,
          color: seed.color,
          isSystem: true,
          userId: null,
        },
      });
    }

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
