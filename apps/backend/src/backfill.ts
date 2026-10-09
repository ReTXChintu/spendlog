import { Types } from "mongoose";
import { User } from "./models";

/**
 * Runs a one-off repair over every user who has not had this version of
 * it yet, and records that they have.
 *
 * Called at start-up, so a deploy mends the data it needs to without
 * anyone remembering to run a script. The version lives on the user
 * (User.backfills) rather than in a collection of its own: it is per user
 * by nature, and a user who signs up later starts on rows the write hooks
 * already keep right, so marking them done is all a repair needs to do for
 * them. Raising the version runs it again for everyone, which is how a
 * repair whose rule changed gets re-applied.
 *
 * Each user is marked only once their pass has finished, so a server
 * stopped half-way through picks up where it left off - which is why every
 * repair handed to this has to be safe to run twice.
 */
export async function runOncePerUser(
  name: string,
  version: number,
  repair: (userId: Types.ObjectId) => Promise<number>
): Promise<{ users: number; changed: number }> {
  const key = `backfills.${name}`;
  const users = await User.find({ $or: [{ [key]: { $exists: false } }, { [key]: { $lt: version } }] }).select("_id");

  let changed = 0;
  for (const user of users) {
    changed += await repair(user._id);
    await User.updateOne({ _id: user._id }, { $set: { [key]: version } });
  }
  return { users: users.length, changed };
}
