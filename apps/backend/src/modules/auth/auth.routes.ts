import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { env } from "../../env";
import { signSessionToken } from "../../middleware/auth";
import { User } from "../../models";

export const authRouter = Router();

const googleClient = new OAuth2Client(env.googleClientId);

const googleLoginSchema = z.object({
  idToken: z.string().min(1),
});

// POST /auth/google
// Verifies a Google ID token (obtained client-side via Google Identity
// Services on web, or google_sign_in on mobile) and issues our own session
// JWT. This is a separate, lighter-weight flow from the Gmail read-access
// OAuth flow in modules/ingestion/email — this one is just "who are you".
authRouter.post("/google", async (req, res) => {
  const parseResult = googleLoginSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: "idToken is required" });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: parseResult.data.idToken,
      audience: env.googleClientId,
    });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: "Invalid Google ID token" });
  }

  if (!payload?.email || !payload.sub) {
    return res.status(401).json({ error: "Google token missing email" });
  }

  const user = await User.findOneAndUpdate(
    { email: payload.email },
    { $set: { googleId: payload.sub, name: payload.name ?? null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const token = signSessionToken({ id: user._id.toString(), email: user.email });
  res.json({ token, user: { id: user._id.toString(), email: user.email, name: user.name } });
});
