import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { env } from "../env";
import { AuthUser } from "../types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signSessionToken(user: AuthUser): string {
  return jwt.sign(user, env.jwtSecret, { expiresIn: "30d" });
}

/**
 * The signed-in user's id as an ObjectId, for use in queries. Only call
 * this on routes behind `requireAuth`.
 */
export function currentUserId(req: Request): Types.ObjectId {
  return new Types.ObjectId(req.user!.id);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  const token = header.slice("Bearer ".length);
  let payload: AuthUser;
  try {
    payload = jwt.verify(token, env.jwtSecret) as AuthUser;
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  // A kid's session reaches the kid routes and nothing else. Every other
  // route in the app reads and writes the signed-in user's own data, and a
  // kid has none of their own - so they are refused here, once, rather
  // than trusted to each route to remember.
  if (payload.role === "KID") {
    return res.status(403).json({ error: "This isn't available on a kid's login." });
  }

  req.user = { id: payload.id, email: payload.email };
  next();
}

/** A kid's session, resolved: who they are, whose money, which accounts. */
export interface KidSession {
  kidId: Types.ObjectId;
  name: string;
  parentId: Types.ObjectId;
  accountIds: Types.ObjectId[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      kid?: KidSession;
    }
  }
}

/**
 * For the kid routes only. Checks the token is a kid's, that the kid still
 * exists, and that the password has not been reset since it was issued -
 * a reset has to sign the old phone out, and a token on its own cannot
 * know about a reset.
 */
export async function requireKid(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  let payload: AuthUser;
  try {
    payload = jwt.verify(header.slice("Bearer ".length), env.jwtSecret) as AuthUser;
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  if (payload.role !== "KID") return res.status(403).json({ error: "Not a kid's login." });

  // Imported here rather than at the top so this file stays free of the
  // models for every other caller.
  const { User } = await import("../models");
  const kid = await User.findById(payload.id).select("role name email parentId kidAccountIds tokenVersion");
  if (!kid || kid.role !== "KID" || !kid.parentId || (kid.tokenVersion ?? 0) !== (payload.v ?? 0)) {
    return res.status(401).json({ error: "Signed out - sign in again." });
  }

  req.kid = {
    kidId: kid._id,
    name: kid.name ?? kid.email,
    parentId: kid.parentId,
    accountIds: kid.kidAccountIds ?? [],
  };
  next();
}
