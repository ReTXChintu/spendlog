import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { env } from "../../env";

/**
 * How another app in the suite proves a call is really from it.
 *
 * The caller signs `${timestamp}.${rawBody}` with HMAC-SHA256 under a
 * secret only the two servers hold, and sends:
 *
 *   x-suite-timestamp: unix seconds
 *   x-suite-signature: sha256=<hex>
 *
 * A GET signs the empty body. The timestamp is inside the signature, so a
 * captured request cannot be replayed later with a fresh one; anything
 * more than five minutes either side of this server's clock is refused.
 *
 * These calls carry no user at all - the app is trusted with the trips it
 * manages, the way a user is trusted with their own - so this replaces
 * requireAuth on those routes rather than adding to it.
 */

/** How far a timestamp may be from this server's clock, either way. */
export const SUITE_MAX_SKEW_S = 5 * 60;

export function suiteSignature(secret: string, timestamp: string, rawBody: Buffer | string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${timestamp}.`);
  hmac.update(rawBody);
  return `sha256=${hmac.digest("hex")}`;
}

/** Why a signed request was refused, or null when it checks out. */
export function checkSuiteSignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: Buffer,
  nowS = Math.floor(Date.now() / 1000)
): string | null {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return "Missing or malformed x-suite-timestamp";
  if (Math.abs(nowS - Number(timestamp)) > SUITE_MAX_SKEW_S) return "x-suite-timestamp is too far from now";
  if (!signature || !signature.startsWith("sha256=")) return "Missing or malformed x-suite-signature";

  const expected = Buffer.from(suiteSignature(secret, timestamp, rawBody), "utf8");
  const given = Buffer.from(signature, "utf8");
  // timingSafeEqual needs equal lengths, and a length mismatch says nothing
  // about the secret.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return "Signature does not match";
  }
  return null;
}

/**
 * Checks the signature over the body exactly as it arrived, then parses it.
 *
 * Expects the router to have read the body raw (express.raw), since a body
 * parsed and re-serialised is not byte-for-byte what was signed.
 */
export function requireSuiteSignature(req: Request, res: Response, next: NextFunction) {
  const secret = env.trippinSuiteSecret;
  if (!secret) {
    return res.status(503).json({ error: "The Trippin integration is not configured on this server." });
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const problem = checkSuiteSignature(
    secret,
    req.header("x-suite-timestamp"),
    req.header("x-suite-signature"),
    rawBody
  );
  if (problem) return res.status(401).json({ error: problem });

  if (rawBody.length === 0) {
    req.body = {};
  } else {
    try {
      req.body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Body is not valid JSON" });
    }
  }
  next();
}
