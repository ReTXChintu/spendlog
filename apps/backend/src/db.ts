// Loaded for its side effect: it reads the repo-root .env into process.env.
// This must happen before PrismaClient is constructed below, since Prisma
// resolves DATABASE_URL at construction time. Importing it here (rather
// than in each entry point) covers the server, the seed script, and tests
// alike — they all reach Prisma through this module.
import "./env";
import { PrismaClient } from "@prisma/client";

// Single shared Prisma client instance for the whole process.
export const prisma = new PrismaClient();
