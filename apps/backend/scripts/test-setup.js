// Loaded into every test process before the test itself.
//
// Twenty test files start a MongoMemoryServer of their own. Several come
// up at once, and on a busy machine a freshly spawned mongod is not
// listening by the time mongoose reaches for it — the connect fails with
// ETIMEDOUT, the pool clears, and whichever suite lost the race fails in
// its `before` hook. It surfaced as a different handful of unrelated tests
// failing on each run, which reads as twenty flaky tests rather than one
// slow machine.
//
// Mongoose will retry for as long as serverSelectionTimeoutMS allows, and
// its default is short enough to give up while mongod is still starting.
// Every test file calls `mongoose.connect(uri)` with no options, so rather
// than passing the same two settings in twenty places, they are applied
// here — once, to the call itself.
//
// Only ever raises patience. A suite that would have connected still
// connects, at the same speed; one that would have failed waits instead.

// Settings env.ts demands, so a test run needs no .env at all.
//
// Sixteen of the twenty test files set these two by hand at the top; the
// other four import something that reaches env.ts without them, and were
// passing only because a developer's machine has a .env at the repo root
// that dotenv quietly picked up. On a CI runner, which has none, they
// failed in `before` with "Missing required environment variable".
//
// Set here rather than in four more files, because the next test file to
// import a route would have hit exactly the same thing.
//
// Neither value is ever used. Every test that touches a database starts a
// MongoMemoryServer and connects to that, and nothing verifies a token
// signed with this secret against anything but itself. Setting them
// first also means dotenv - which never overwrites a value already in the
// environment - cannot pull a real DATABASE_URL into a test run, which is
// worth having on a machine whose .env points at production.
process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_tests_unused";
process.env.JWT_SECRET ??= "test-secret-not-used-for-anything-real";

const mongoose = require("mongoose");

const PATIENCE_MS = 60_000;

const connect = mongoose.connect.bind(mongoose);

mongoose.connect = (uri, options) =>
  connect(uri, {
    serverSelectionTimeoutMS: PATIENCE_MS,
    connectTimeoutMS: PATIENCE_MS,
    ...options,
  });
