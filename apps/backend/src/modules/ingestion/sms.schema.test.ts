import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { smsSchema } from "./sms.routes";

// The mobile app's payloads were rejected wholesale for months without
// anything saying so: the batch endpoint returned 400 and the client threw
// the response away. These cases are the exact shapes a phone sends.
describe("SMS ingestion payloads", () => {
  const base = {
    rawText: "Rs 349 debited from A/c XX9876 on 15-08-26 to VPA swiggy@icici",
    sender: "AD-HDFCBK",
    messageId: "AD-HDFCBK-1757577600000",
  };

  it("accepts a UTC timestamp", () => {
    const result = smsSchema.safeParse({ ...base, receivedAt: "2026-09-11T10:00:00.000Z" });
    assert.equal(result.success, true);
  });

  it("accepts a timestamp with an offset", () => {
    const result = smsSchema.safeParse({ ...base, receivedAt: "2026-09-11T15:30:00.000+05:30" });
    assert.equal(result.success, true);
    assert.equal(result.data?.receivedAt.toISOString(), "2026-09-11T10:00:00.000Z");
  });

  it("accepts a timestamp with no timezone at all", () => {
    // Dart's toIso8601String() drops the timezone for a local DateTime,
    // which is what every message from the app used to look like.
    const result = smsSchema.safeParse({ ...base, receivedAt: "2026-09-11T15:30:00.000" });
    assert.equal(result.success, true);
  });

  it("accepts a message with no sender", () => {
    const result = smsSchema.safeParse({ ...base, sender: null, receivedAt: "2026-09-11T10:00:00.000Z" });
    assert.equal(result.success, true);
  });

  it("accepts a message with the sender field absent", () => {
    const { sender, ...withoutSender } = base;
    void sender;
    const result = smsSchema.safeParse({ ...withoutSender, receivedAt: "2026-09-11T10:00:00.000Z" });
    assert.equal(result.success, true);
  });

  it("rejects an empty body, which cannot be parsed into anything", () => {
    const result = smsSchema.safeParse({ ...base, rawText: "", receivedAt: "2026-09-11T10:00:00.000Z" });
    assert.equal(result.success, false);
  });

  it("rejects a timestamp that is not a date", () => {
    const result = smsSchema.safeParse({ ...base, receivedAt: "whenever" });
    assert.equal(result.success, false);
  });
});
