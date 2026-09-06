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
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export { mongoose };
