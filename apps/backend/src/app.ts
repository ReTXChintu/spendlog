// Patches Express 4 to forward rejected promises from async route handlers
// to the error middleware below. Without it an async throw becomes an
// unhandled rejection, which leaves the request hanging and (on modern
// Node) terminates the process. Must be imported before the routes.
import "express-async-errors";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { authRouter } from "./modules/auth/auth.routes";
import { categoriesRouter } from "./modules/categories/categories.routes";
import { analyticsRouter } from "./modules/analytics/analytics.routes";
import { emailRouter } from "./modules/ingestion/email.routes";
import { smsRouter } from "./modules/ingestion/sms.routes";
import { transactionsRouter } from "./modules/transactions/transactions.routes";

export const app = express();

// Behind the frontend's /api proxy, req.ip and req.protocol would otherwise
// report the loopback hop. Only headers arriving from loopback are trusted,
// so a direct client can't spoof them.
app.set("trust proxy", "loopback");

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/categories", categoriesRouter);
app.use("/transactions", transactionsRouter);
app.use("/ingestion/sms", smsRouter);
app.use("/ingestion/email", emailRouter);
app.use("/analytics", analyticsRouter);

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);

  // Mongoose validation failures are the caller's fault, not the server's.
  if (err.name === "ValidationError" || err.name === "CastError") {
    return res.status(400).json({ error: err.message });
  }
  if (err.name === "DocumentNotFoundError") {
    return res.status(404).json({ error: "Not found" });
  }

  res.status(500).json({ error: "Internal server error" });
});
