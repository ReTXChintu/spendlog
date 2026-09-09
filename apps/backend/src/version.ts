import fs from "fs";
import path from "path";

/**
 * The deployed version, read from the package.json the release script
 * stamps. The whole monorepo ships as one version, so this is also what
 * the mobile app compares itself against when it checks for an update.
 *
 * __dirname is apps/backend/src under tsx and apps/backend/dist once
 * compiled, so package.json is one level up either way.
 */
function readVersion(): string {
  try {
    const manifest = path.resolve(__dirname, "..", "package.json");
    return JSON.parse(fs.readFileSync(manifest, "utf8")).version ?? "0.0.0";
  } catch {
    // A missing or unreadable manifest shouldn't stop the server booting;
    // clients treat 0.0.0 as "older than anything" and won't nag.
    return "0.0.0";
  }
}

export const APP_VERSION = readVersion();
