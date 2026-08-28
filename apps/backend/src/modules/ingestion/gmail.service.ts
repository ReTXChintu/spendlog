import { gmail_v1, google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../../db";
import { env } from "../../env";
import { ingestRawMessage } from "../../parsing/ingest";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export function createOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, env.googleOAuthRedirectUri);
}

export function buildConsentUrl(state: string): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token even on repeat connects
    scope: [GMAIL_READONLY_SCOPE, "https://www.googleapis.com/auth/userinfo.email"],
    state,
  });
}

export async function completeConnection(userId: string, code: string): Promise<void> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("Google did not return a refresh token — retry the consent flow with prompt=consent");
  }

  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const { data } = await oauth2.userinfo.get();
  if (!data.email) throw new Error("Could not read connected Gmail address");

  await prisma.emailConnection.upsert({
    where: { userId_email: { userId, email: data.email } },
    update: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    },
    create: {
      userId,
      email: data.email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    },
  });
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function extractPlainText(payload: gmail_v1.Schema$MessagePart | undefined): string | null {
  if (!payload) return null;

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part);
    if (text) return text;
  }

  return null;
}

const TRANSACTION_QUERY =
  '(debited OR credited OR "has been debited" OR "has been credited" OR UPI OR "a/c" OR spent)';

/**
 * Pulls transaction-looking emails received since the connection's last
 * sync (or the last 30 days on first sync), parses each one, and stores
 * new transactions via the shared ingestion pipeline. Safe to call
 * repeatedly — dedup happens inside ingestRawMessage.
 */
export async function syncEmailConnection(connectionId: string): Promise<{ created: number; scanned: number }> {
  const connection = await prisma.emailConnection.findUniqueOrThrow({ where: { id: connectionId } });

  const client = createOAuthClient();
  client.setCredentials({
    access_token: connection.accessToken,
    refresh_token: connection.refreshToken,
  });
  const gmail = google.gmail({ version: "v1", auth: client });

  const since = connection.lastSyncedAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const afterEpoch = Math.floor(since.getTime() / 1000);
  const query = `${TRANSACTION_QUERY} after:${afterEpoch}`;

  let created = 0;
  let scanned = 0;
  let pageToken: string | undefined;
  const syncStartedAt = new Date();

  do {
    const list = await gmail.users.messages.list({
      userId: "me",
      q: query,
      pageToken,
      maxResults: 50,
    });

    for (const ref of list.data.messages ?? []) {
      if (!ref.id) continue;
      scanned += 1;

      const message = await gmail.users.messages.get({ userId: "me", id: ref.id, format: "full" });
      const bodyText = extractPlainText(message.data.payload) ?? message.data.snippet ?? "";
      const receivedAt = message.data.internalDate ? new Date(Number(message.data.internalDate)) : new Date();

      const result = await ingestRawMessage({
        userId: connection.userId,
        rawText: bodyText,
        source: "EMAIL",
        sourceRef: ref.id,
        receivedAt,
      });
      if (result.status === "created") created += 1;
    }

    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken);

  // access_token may have been silently refreshed by the client during the
  // calls above; persist the latest credentials alongside the sync time.
  const latestCredentials = client.credentials;
  await prisma.emailConnection.update({
    where: { id: connection.id },
    data: {
      lastSyncedAt: syncStartedAt,
      accessToken: latestCredentials.access_token ?? connection.accessToken,
      expiryDate: latestCredentials.expiry_date ? new Date(latestCredentials.expiry_date) : connection.expiryDate,
    },
  });

  return { created, scanned };
}

export async function syncAllConnectedEmails(): Promise<void> {
  const connections = await prisma.emailConnection.findMany();
  for (const connection of connections) {
    try {
      await syncEmailConnection(connection.id);
    } catch (err) {
      console.error(`Gmail sync failed for connection ${connection.id}:`, err);
    }
  }
}
