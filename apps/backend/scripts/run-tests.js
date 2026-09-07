#!/usr/bin/env node
// Runs every *.test.ts under src/.
//
// The obvious `tsx --test src/**/*.test.ts` only works on Node 22+, which
// expands glob patterns for --test itself; on Node 20 the pattern reaches
// the runner literally and it reports the files as missing. Discovering
// the files here keeps `npm test` working on any supported Node, and
// doesn't depend on the shell doing the expansion either.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");

const tests = fs
  .readdirSync(SRC, { recursive: true })
  .map(String)
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => path.join("src", file));

if (tests.length === 0) {
  console.error("No *.test.ts files found under src/.");
  process.exit(1);
}

const result = spawnSync("tsx", ["--test", ...tests], {
  cwd: path.join(__dirname, ".."),
  stdio: "inherit",
  shell: true,
});

process.exit(result.status ?? 1);
