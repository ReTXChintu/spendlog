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

// Twenty of these start a MongoMemoryServer of their own, and the runner
// will otherwise start one per core. On a 22-core machine that is twenty
// mongod processes racing to come up, and whichever loses fails in its
// `before` hook - a different handful of suites each run, which reads as
// twenty flaky tests rather than one busy machine.
//
// Two halves to the answer. Fewer at a time, so the machine is not asked
// to start twenty databases at once; and test-setup.js, preloaded into
// every test process, gives mongoose long enough to keep retrying while a
// mongod is still coming up. NODE_OPTIONS rather than an argument,
// because the runner spawns a child process per test file and only the
// environment reaches them.
const result = spawnSync("tsx", ["--test", "--test-concurrency=4", ...tests], {
  cwd: path.join(__dirname, ".."),
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ./scripts/test-setup.js`.trim(),
  },
});

process.exit(result.status ?? 1);
