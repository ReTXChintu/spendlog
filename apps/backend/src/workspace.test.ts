import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Every maintenance script has to be runnable from the repo root.
 *
 * Nobody runs these from apps/backend. They are run on the server, in
 * /opt/var/spendlog, which is the root of the monorepo - so a script that
 * exists only in the workspace's own package.json is a script that cannot
 * be run at all, and says so as "Missing script", weeks after it shipped.
 *
 * That has now happened to three of them. The root delegates seed and
 * backfill:counted and was never updated for the rest, and the gap is
 * invisible from either file on its own: each looks complete.
 *
 * The second half is the `--` on the end of a delegation. Without it npm
 * swallows the arguments between the two hops - `npm run ledger:start --
 * --apply` reaches the script with an empty argv, so a dry run silently
 * stays a dry run however it was asked. Only scripts that read argv need
 * it, which is exactly the set this works out rather than hardcodes.
 */

const ROOT = path.join(__dirname, "..", "..", "..");
const BACKEND = path.join(ROOT, "apps", "backend");

function scriptsOf(packageJson: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(packageJson, "utf8")).scripts ?? {};
}

const rootScripts = scriptsOf(path.join(ROOT, "package.json"));
const backendScripts = scriptsOf(path.join(BACKEND, "package.json"));

/** The ones the root drives itself, or that nobody runs by hand. */
const NOT_MAINTENANCE = new Set(["dev", "build", "start", "test", "lint"]);

const maintenance = Object.keys(backendScripts).filter((name) => !NOT_MAINTENANCE.has(name));

/** Whether the file a script runs reads process.argv. */
function takesArguments(command: string): boolean {
  const file = command.match(/(?:src|scripts)\/[\w.-]+\.ts/)?.[0];
  if (!file) return false;

  const full = path.join(BACKEND, file);
  return fs.existsSync(full) && fs.readFileSync(full, "utf8").includes("process.argv");
}

describe("the maintenance scripts, from the repo root", () => {
  it("has some to check, so this cannot pass by finding nothing", () => {
    assert.ok(maintenance.length >= 4, `only found ${maintenance.length}`);
  });

  for (const name of maintenance) {
    it(`runs ${name}`, () => {
      assert.ok(
        rootScripts[name],
        `"${name}" is in apps/backend/package.json and not in the root one, so ` +
          `\`npm run ${name}\` on the server answers "Missing script"`
      );
    });

    if (takesArguments(backendScripts[name])) {
      it(`passes arguments through to ${name}`, () => {
        assert.ok(
          rootScripts[name].trimEnd().endsWith("--"),
          `${name} reads process.argv, so its root delegation has to end in "--" ` +
            `or npm eats the arguments between the two hops`
        );
      });
    }
  }
});
