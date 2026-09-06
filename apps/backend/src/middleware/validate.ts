import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";

/**
 * Rejects malformed ids before they reach a query. Without this, Mongoose
 * throws a CastError on anything that isn't a valid ObjectId, which would
 * surface as a 500 (or crash the process) rather than the 404 a caller
 * should get for a nonexistent resource.
 */
export function validObjectIdParam(param: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!Types.ObjectId.isValid(req.params[param])) {
      return res.status(404).json({ error: "Not found" });
    }
    next();
  };
}
