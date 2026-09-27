import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { User } from "../../models";
import { decryptPassword, encryptionAvailable, encryptPassword } from "../statements/statements.crypto";
import { AiError, ask, cleanModelName, DEFAULT_MODELS, listModels } from "./ai.gemini";

export const aiRouter = Router();
aiRouter.use(requireAuth);

/**
 * The assistant: questions about your own money, answered by Gemini with
 * your own API key.
 *
 * The key is stored encrypted, the same way statement passwords are, and
 * never sent back to any client - settings only ever learns whether there
 * is one and its last four characters.
 */

async function settingsFor(userId: ReturnType<typeof currentUserId>) {
  const user = await User.findById(userId).select("geminiApiKeyEnc geminiApiKeyHint geminiModel").orFail();
  return {
    hasKey: Boolean(user.geminiApiKeyEnc),
    keyHint: user.geminiApiKeyHint ?? null,
    model: user.geminiModel ?? null,
    defaultModel: DEFAULT_MODELS[0],
    // Without the server's encryption key there is nowhere safe to keep an
    // API key, and settings should say so rather than fail on save.
    canStoreKey: encryptionAvailable(),
  };
}

// GET /ai/settings
aiRouter.get("/settings", async (req, res) => {
  res.json(await settingsFor(currentUserId(req)));
});

const settingsSchema = z.object({
  /// A new key, or null to forget the saved one.
  apiKey: z.string().trim().min(10).max(200).nullable().optional(),
  /// A model id, or null to go back to the default.
  model: z.string().max(100).nullable().optional(),
});

// PUT /ai/settings — save or remove the key, pick a model. A new key is
// tried against Gemini before it is kept, so a typo is caught here rather
// than at the first question.
aiRouter.put("/settings", async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "That doesn't look like a Gemini API key." });

  const userId = currentUserId(req);
  const update: Record<string, string | null> = {};

  if (parsed.data.apiKey === null) {
    update.geminiApiKeyEnc = null;
    update.geminiApiKeyHint = null;
  } else if (parsed.data.apiKey !== undefined) {
    if (!encryptionAvailable()) {
      return res.status(503).json({ error: "The server has no encryption key set, so it can't store an API key." });
    }
    try {
      await listModels(parsed.data.apiKey);
    } catch (error) {
      if (error instanceof AiError) return res.status(400).json({ error: error.message });
      throw error;
    }
    update.geminiApiKeyEnc = encryptPassword(parsed.data.apiKey);
    update.geminiApiKeyHint = parsed.data.apiKey.slice(-4);
  }

  if (parsed.data.model === null || parsed.data.model === "") {
    update.geminiModel = null;
  } else if (parsed.data.model !== undefined) {
    const model = cleanModelName(parsed.data.model);
    if (!model) return res.status(400).json({ error: "That isn't a model name." });
    update.geminiModel = model;
  }

  await User.updateOne({ _id: userId }, { $set: update });
  res.json(await settingsFor(userId));
});

async function savedKey(userId: ReturnType<typeof currentUserId>) {
  const user = await User.findById(userId).select("geminiApiKeyEnc geminiModel").orFail();
  const key = decryptPassword(user.geminiApiKeyEnc);
  return { key, model: user.geminiModel ?? null };
}

// GET /ai/models — what the saved key can use, for the settings picker.
aiRouter.get("/models", async (req, res) => {
  const { key } = await savedKey(currentUserId(req));
  if (!key) return res.status(409).json({ error: "Add a Gemini API key in Settings first." });

  try {
    res.json(await listModels(key));
  } catch (error) {
    if (error instanceof AiError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

const askSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "model"]), text: z.string().trim().min(1).max(4000) }))
    .min(1)
    .max(30)
    .refine((messages) => messages[messages.length - 1].role === "user", {
      message: "The last message has to be the question.",
    }),
});

// POST /ai/ask — the conversation so far, last message the question. Kept
// by the client rather than stored: nothing about what someone asked needs
// to outlive the screen they asked it on.
aiRouter.post("/ask", async (req, res) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Ask a question first." });

  const userId = currentUserId(req);
  const { key, model } = await savedKey(userId);
  if (!key) return res.status(409).json({ error: "Add a Gemini API key in Settings to ask questions." });

  // A chosen model is used as is. With none chosen, the defaults are tried
  // in order, so a key without access to the rolling alias still works.
  const candidates = model ? [model] : DEFAULT_MODELS;

  for (const [index, candidate] of candidates.entries()) {
    try {
      const result = await ask(userId, key, candidate, parsed.data.messages);
      return res.json({ ...result, model: candidate });
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      if (error.modelMissing && index < candidates.length - 1) continue;
      return res.status(error.status).json({ error: error.message });
    }
  }
});
