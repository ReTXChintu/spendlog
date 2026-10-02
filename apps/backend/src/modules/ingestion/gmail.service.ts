import { gmail_v1, google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { Types } from "mongoose";
import { env } from "../../env";
import { EmailConnection } from "../../models";
import { ingestRawMessage } from "../../parsing/ingest";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// Identity and Gmail read access are requested together, in one consent
// screen, at sign-in. See modules/auth/auth.routes.ts.
export const LOGIN_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  GMAIL_READONLY_SCOPE,
];

export function createOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, env.googleOAuthRedirectUri);
}

export function buildConsentUrl(state: string, scopes: string[] = LOGIN_SCOPES): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces a refresh_token even on repeat consents
    scope: scopes,
    state,
  });
}

export async function exchangeCode(code: string) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token) throw new Error("Google did not return an access token");
  return tokens;
}

/**
 * Stores the Gmail refresh token for a user. Only called when the granted
 * scopes actually include gmail.readonly — a user can untick that box on
 * the consent screen and still sign in, in which case they simply have no
 * email import until they connect it from Settings.
 */
export async function saveConnection(params: {
  userId: Types.ObjectId;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiryDate: number | null | undefined;
}): Promise<void> {
  await EmailConnection.findOneAndUpdate(
    { userId: params.userId, email: params.email },
    {
      $set: {
        accessToken: params.accessToken,
        refreshToken: params.refreshToken,
        expiryDate: params.expiryDate ? new Date(params.expiryDate) : null,
        needsReconnect: false,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Google no longer accepts the saved sign-in.
 *
 * "invalid_grant" from the token endpoint means the refresh token is dead:
 * access was revoked, the password changed, or - while the Google Cloud
 * app is in Testing mode - seven days simply passed. No retry fixes it;
 * only signing in to Gmail again does.
 */
export class GmailNeedsReconnectError extends Error {
  constructor(readonly email: string) {
    super(`Gmail (${email}) needs reconnecting: Google no longer accepts the saved sign-in. Reconnect it in Settings.`);
  }
}

/** The OAuth errors that mean the saved sign-in is unusable, not just slow. */
const DEAD_SIGN_IN = ["invalid_grant", "unauthorized_client", "invalid_client", "invalid_token"];

/** A 403 that is Gmail saying "slow down" rather than "no". */
const RATE_LIMITED = /rate ?limit|quota/i;

/**
 * Google refused to let this sign-in read the mailbox.
 *
 * Any answer of that kind unlinks the mailbox: a dead refresh token
 * (invalid_grant and its relatives), a 401, or a 403 that is not just a
 * rate limit - Gmail access removed from the Google account, or the scope
 * withdrawn. A timeout or a network failure is not one of these: nothing
 * about the sign-in is wrong, and it is retried on the next sync.
 */
export function isRevokedGrant(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: unknown } })?.response;
  const data = response?.data as { error?: unknown; error_description?: unknown } | undefined;
  const code = typeof data?.error === "string" ? data.error : null;
  const message = String((error as Error)?.message ?? "");

  if (code && DEAD_SIGN_IN.includes(code)) return true;
  if (DEAD_SIGN_IN.some((name) => message.includes(name))) return true;
  if (response?.status === 401) return true;
  if (response?.status === 403) return !RATE_LIMITED.test(`${message} ${JSON.stringify(data ?? "")}`);
  return false;
}

/**
 * Asks Google for a fresh access token with the saved refresh token alone,
 * which is the cheapest way to learn whether the sign-in still works. A
 * dead one is flagged on the connection (see withGmail); a working one
 * leaves the connection with a current access token.
 */
export async function checkConnection(connection: InstanceType<typeof EmailConnection>): Promise<void> {
  const client = createOAuthClient();
  client.setCredentials({ refresh_token: connection.refreshToken });
  try {
    await withGmail(connection, async () => {
      const { token } = await client.getAccessToken();
      if (token) {
        await EmailConnection.updateOne(
          { _id: connection._id },
          {
            $set: {
              accessToken: token,
              expiryDate: client.credentials.expiry_date ? new Date(client.credentials.expiry_date) : null,
            },
          }
        );
      }
    });
  } catch (error) {
    // Flagged already when the sign-in is dead. Anything else - Google
    // unreachable for a moment - says nothing about the connection.
    if (!(error instanceof GmailNeedsReconnectError)) {
      console.warn(`Couldn't check Gmail connection ${connection._id.toString()}:`, (error as Error).message);
    }
  }
}

/**
 * Runs Gmail work for one connection, turning a dead sign-in into a flag on
 * the connection and an error that says what to do about it.
 */
export async function withGmail<T>(
  connection: { _id: unknown; email: string },
  work: () => Promise<T>
): Promise<T> {
  try {
    const result = await work();
    await EmailConnection.updateOne({ _id: connection._id, needsReconnect: true }, { $set: { needsReconnect: false } });
    return result;
  } catch (error) {
    if (!isRevokedGrant(error)) throw error;
    await EmailConnection.updateOne({ _id: connection._id }, { $set: { needsReconnect: true } });
    throw new GmailNeedsReconnectError(connection.email);
  }
}

/** True when Google actually granted Gmail read access. */
export function grantedGmailAccess(scope: string | null | undefined): boolean {
  return (scope ?? "").split(" ").includes(GMAIL_READONLY_SCOPE);
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
  const connection = await EmailConnection.findById(connectionId).orFail();
  return withGmail(connection, () => syncConnection(connection));
}

async function syncConnection(
  connection: InstanceType<typeof EmailConnection>
): Promise<{ created: number; scanned: number }> {
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
  await EmailConnection.updateOne(
    { _id: connection._id },
    {
      $set: {
        lastSyncedAt: syncStartedAt,
        accessToken: latestCredentials.access_token ?? connection.accessToken,
        expiryDate: latestCredentials.expiry_date
          ? new Date(latestCredentials.expiry_date)
          : connection.expiryDate,
      },
    }
  );

  return { created, scanned };
}

export async function syncAllConnectedEmails(): Promise<void> {
  const connections = await EmailConnection.find();
  for (const connection of connections) {
    try {
      await syncEmailConnection(connection._id.toString());
    } catch (err) {
      // A dead sign-in is flagged on the connection and waits for the user;
      // logging its stack every few minutes says nothing new.
      if (err instanceof GmailNeedsReconnectError) continue;
      console.error(`Gmail sync failed for connection ${connection._id.toString()}:`, err);
    }
  }
}
