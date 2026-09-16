import { ApiError, getToken } from "./api";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

/**
 * Sending a picture of a coupon to be read.
 *
 * The shrinking is the important part. A vision model turns an image into
 * tiles and the count grows with the area, so a 12-megapixel phone photo
 * costs minutes on CPU cores where a 1024px one costs seconds — and a
 * coupon is large text on a plain background, which survives the
 * shrinking completely. Done here rather than on the server because the
 * browser already has a decoder and it saves the upload too.
 */

/** Longest side, in pixels. Comfortably enough to read a coupon. */
const MAX_EDGE = 1024;

/** What the model is told it is looking at. */
const TYPE = "image/jpeg";

export interface PerkDraft {
  kind: "COUPON" | "CARD_OFFER";
  title: string;
  merchants: string[];
  percent: number | null;
  flatMinor: number | null;
  maxDiscountMinor: number | null;
  minSpendMinor: number | null;
  startsOn: string | null;
  expiresOn: string | null;
  code: string | null;
  notes: string | null;
  accountId: string | null;
  cardNamed: string | null;
  missing: string[];
}

async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not read the picture.");

  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The picture could not be converted."))),
      TYPE,
      // High quality on purpose: the artefacts of a hard compression land
      // on exactly the small print this is trying to read.
      0.9
    );
  });
}

export interface ImportJob {
  id: string;
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED";
  problem: string | null;
  total: number;
  counts: { queued: number; running: number; done: number; failed: number };
  failures: { fileName: string; problem: string | null }[];
  duplicates: number;
  added: number;
  finishedAt: string | null;
}

/**
 * Send a pile of them, and get a job back.
 *
 * Shrunk one at a time rather than all at once: a phone's worth of
 * screenshots decoded in parallel is a tab that stops responding, and the
 * upload is waiting on the slowest one either way.
 */
export async function importPerkImages(
  files: File[],
  onProgress?: (shrunk: number, total: number) => void
): Promise<ImportJob> {
  const images: { name: string; base64: string }[] = [];

  for (const [index, file] of files.entries()) {
    const blob = await shrink(file);
    images.push({ name: file.name, base64: await toBase64(blob) });
    onProgress?.(index + 1, files.length);
  }

  return postJson<ImportJob>("/perks/import", { images });
}

/** Base64 without the data-URL preamble the server would have to strip. */
function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The picture could not be read."));
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(blob);
  });
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const token = getToken();
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const problem = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(response.status, problem.error ?? response.statusText);
  }

  return (await response.json()) as T;
}

export async function readPerkFromImage(file: File): Promise<PerkDraft> {
  const token = getToken();
  const body = await shrink(file);

  const response = await fetch(`${API_URL}/perks/read`, {
    method: "POST",
    headers: {
      "Content-Type": TYPE,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });

  if (!response.ok) {
    const problem = await response.json().catch(() => ({ error: response.statusText }));
    throw new ApiError(response.status, problem.error ?? response.statusText);
  }

  return (await response.json()) as PerkDraft;
}
