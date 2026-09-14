// Loaded for its side effect: it reads the repo-root .env into process.env.
// Importing it here (rather than in each entry point) covers the server,
// the seed script, and tests alike — they all reach the database through
// this module.
import "./env";
import mongoose from "mongoose";
import { env } from "./env";

// Fail fast on typos in query filters instead of silently matching nothing.
mongoose.set("strictQuery", true);

export async function connectDatabase(): Promise<void> {
  await mongoose.connect(env.databaseUrl);
  await dropSupersededIndexes();
}

/**
 * Indexes whose definition changed, rather than whose definition is new.
 *
 * Mongoose builds an index it has never seen and leaves alone one it has,
 * but it will not rebuild one whose *options* changed - Mongo rejects a
 * second index with the same keys and different options outright, and the
 * failure lands in a log nobody reads while the old rule quietly stays in
 * force. So the old one is dropped by name first.
 *
 * Each entry here is a one-way step that has already happened in the
 * schema. Leaving them in place costs one lookup at boot and is what makes
 * a deployment that skipped a version land in the same state as one that
 * did not.
 */
async function dropSupersededIndexes(): Promise<void> {
  const superseded = [
    // Was unique on { userId, sourceRef }. The second half is Gmail's
    // attachment id, which is minted per fetch rather than being a name
    // for anything, so it identified nothing and every sync read every
    // statement again. Identity moved to mailKey and fileHash.
    { collection: "cardstatements", index: "userId_1_sourceRef_1" },
  ];

  for (const { collection, index } of superseded) {
    try {
      await mongoose.connection.collection(collection).dropIndex(index);
    } catch {
      // Already dropped, or never existed on this deployment. Both fine:
      // this runs on every boot and has to be a no-op on all but one.
    }
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export { mongoose };
