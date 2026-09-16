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
const mongoose = require("mongoose");

const PATIENCE_MS = 60_000;

const connect = mongoose.connect.bind(mongoose);

mongoose.connect = (uri, options) =>
  connect(uri, {
    serverSelectionTimeoutMS: PATIENCE_MS,
    connectTimeoutMS: PATIENCE_MS,
    ...options,
  });
