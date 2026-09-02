import path from "path";
import dotenv from "dotenv";

// The monorepo keeps a single .env at the repo root rather than one per app.
// __dirname is apps/backend/src when running via tsx and apps/backend/dist
// once compiled — both are one level below apps/backend, so the root is
// three levels up either way.
dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (set it in the .env at the repo root)`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleOAuthRedirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "",
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:5173",
};
