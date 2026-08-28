import cors from "cors";
import express from "express";
import { authRouter } from "./modules/auth/auth.routes";
import { categoriesRouter } from "./modules/categories/categories.routes";
import { analyticsRouter } from "./modules/analytics/analytics.routes";
import { emailRouter } from "./modules/ingestion/email.routes";
import { smsRouter } from "./modules/ingestion/sms.routes";
import { transactionsRouter } from "./modules/transactions/transactions.routes";

export const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/categories", categoriesRouter);
app.use("/transactions", transactionsRouter);
app.use("/ingestion/sms", smsRouter);
app.use("/ingestion/email", emailRouter);
app.use("/analytics", analyticsRouter);
