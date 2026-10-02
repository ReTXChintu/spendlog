import { Types } from "mongoose";
import { Category } from "../../models";
import { DefaultCategorySeed, PEOPLE_CATEGORY, TRANSFER_CATEGORY } from "../../parsing/default-categories";

/**
 * The system categories the apps and the server pick by name, made sure of
 * once per process. Seeding is a step someone runs by hand on a deploy,
 * and a category chosen automatically cannot depend on that having
 * happened.
 */

const ensured = new Map<string, Promise<Types.ObjectId | null>>();

function ensure(seed: DefaultCategorySeed): Promise<Types.ObjectId | null> {
  let pending = ensured.get(seed.name);
  if (!pending) {
    pending = Category.findOneAndUpdate(
      { name: seed.name, userId: null, isSystem: true },
      { $setOnInsert: { icon: seed.icon, color: seed.color, direction: seed.direction } },
      { upsert: true, new: true }
    )
      .then((category) => category?._id ?? null)
      .catch((error) => {
        ensured.delete(seed.name);
        throw error;
      });
    ensured.set(seed.name, pending);
  }
  return pending;
}

export async function ensureSystemCategories(): Promise<void> {
  await Promise.all([ensure(PEOPLE_CATEGORY), ensure(TRANSFER_CATEGORY)]);
}

export function transferCategoryId(): Promise<Types.ObjectId | null> {
  return ensure(TRANSFER_CATEGORY);
}
