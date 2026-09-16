import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HydratedDocument, Types } from "mongoose";
import { Perk, PerkImport, PerkImportDoc } from "../../models";
import { PerkDraft, extractPerk } from "./perks.extract";
import { VisionProvider } from "./perks.vision";

/**
 * Reading a pile of coupon screenshots, in the background.
 *
 * The model takes tens of seconds an image and runs on the same cores as
 * everything else, so twenty pictures is ten minutes. Nobody is going to
 * watch that, and a request that hangs for ten minutes is a request a
 * proxy will cut anyway - so the upload returns immediately with a job to
 * ask about, and the reading carries on without it.
 *
 * Each picture becomes a perk rather than a draft to confirm. That is what
 * was asked for and it is the only thing that makes a pile of twenty worth
 * doing. What survives of the old caution is a flag: a perk read this way
 * is marked `needsReview`, so the list can offer them for a glance instead
 * of presenting a machine's reading of small print as though somebody had
 * typed it. It is a real perk meanwhile - it shows up, it answers a
 * lookup, it can be used.
 */

/** Where the pictures wait their turn. Emptied as each job finishes. */
function jobDir(jobId: Types.ObjectId | string): string {
  return path.join(os.tmpdir(), "spendlog-imports", jobId.toString());
}

/**
 * Put the pictures somewhere the worker can find them.
 *
 * On disk rather than in the job document: twenty screenshots is a few
 * megabytes and Mongo's document limit is sixteen, which is close enough
 * to be a bug waiting for a bigger batch.
 */
export async function createImport(
  userId: Types.ObjectId,
  pictures: { fileName: string; bytes: Buffer }[]
): Promise<HydratedDocument<PerkImportDoc>> {
  const job = await PerkImport.create({ userId, status: "QUEUED", items: [] });
  const directory = jobDir(job._id);
  await fs.mkdir(directory, { recursive: true });

  for (const [index, picture] of pictures.entries()) {
    const file = path.join(directory, `${index}`);
    await fs.writeFile(file, picture.bytes);

    job.items.push({
      fileName: picture.fileName || `Picture ${index + 1}`,
      path: file,
      status: "QUEUED",
      perkId: null,
      problem: null,
    });
  }

  await job.save();
  return job;
}

/**
 * Work through one job, picture by picture.
 *
 * Deliberately not awaited by the route that starts it. Every failure is
 * recorded against the picture that caused it and the rest carry on: one
 * unreadable screenshot in twenty is a normal afternoon, not a reason to
 * abandon the other nineteen.
 */
export async function runImport(
  jobId: Types.ObjectId,
  /// Passed in rather than looked up, so what reads the pictures is the
  /// caller's decision - which is what lets a test hand it one that
  /// answers instantly instead of standing up a model.
  provider: VisionProvider | null
): Promise<void> {
  const job = await PerkImport.findById(jobId);
  if (!job) return;

  if (!provider) {
    job.status = "FAILED";
    job.problem = "No vision model is set up on this server.";
    job.finishedAt = new Date();
    await job.save();
    return;
  }

  job.status = "RUNNING";
  job.startedAt = new Date();
  await job.save();

  for (const item of job.items) {
    if (item.status !== "QUEUED") continue;

    item.status = "RUNNING";
    await job.save();

    try {
      const image = await fs.readFile(item.path);
      const draft = await extractPerk({
        userId: job.userId,
        image,
        // The clients send JPEG; the extractor only passes this through to
        // the data URL, and a wrong label would only confuse the model.
        mimeType: "image/jpeg",
        provider,
      });

      const perk = await savePerk(job.userId, draft);
      item.perkId = perk?._id ?? null;
      item.problem = perk ? null : "Already had this one.";
      item.status = "DONE";
    } catch (error) {
      item.status = "FAILED";
      item.problem = error instanceof Error ? error.message : "Could not be read.";
    }

    await job.save();
  }

  job.status = "DONE";
  job.finishedAt = new Date();
  await job.save();

  // The pictures have done their job. Kept no longer than the reading
  // needs them, which is the whole time they were ever wanted.
  await fs.rm(jobDir(jobId), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Store one, unless it is already here.
 *
 * Returns null for a duplicate. Uploading the same screenshot twice is the
 * ordinary way a batch goes wrong - a folder picked twice, an overlap
 * between two selections - and twenty coupons becoming forty would be a
 * worse outcome than missing one.
 */
async function savePerk(userId: Types.ObjectId, draft: PerkDraft) {
  const alreadyHere = await findDuplicate(userId, draft);
  if (alreadyHere) return null;

  return Perk.create({
    userId,
    kind: draft.kind,
    // A coupon with no name is still a coupon; calling it by its code, or
    // by the shop, beats refusing to store it.
    title: draft.title || draft.code || draft.merchants[0] || "A coupon",
    accountId: draft.accountId ? new Types.ObjectId(draft.accountId) : null,
    merchants: draft.merchants,
    percent: draft.percent,
    flatMinor: draft.flatMinor,
    maxDiscountMinor: draft.maxDiscountMinor,
    minSpendMinor: draft.minSpendMinor,
    startsOn: draft.startsOn ? new Date(`${draft.startsOn}T00:00:00.000+05:30`) : null,
    expiresOn: draft.expiresOn ? new Date(`${draft.expiresOn}T23:59:59.999+05:30`) : null,
    code: draft.code,
    notes: noteFor(draft),
    needsReview: true,
  });
}

/**
 * The same coupon, already stored.
 *
 * A code is the strongest thing a coupon has, so two with the same code
 * are the same coupon. Without one, the pair that identifies it is the
 * shop and what it takes off - two different Zomato coupons differ in at
 * least one of those, and the same one twice differs in neither.
 */
async function findDuplicate(userId: Types.ObjectId, draft: PerkDraft) {
  if (draft.code) {
    return Perk.findOne({ userId, code: draft.code });
  }

  if (draft.merchants.length === 0) return null;

  return Perk.findOne({
    userId,
    merchants: { $in: draft.merchants },
    percent: draft.percent,
    flatMinor: draft.flatMinor,
  });
}

/** The model's own note, plus anything it could not find. */
function noteFor(draft: PerkDraft): string | null {
  const parts = [draft.notes].filter(Boolean) as string[];

  if (draft.cardNamed && !draft.accountId) {
    parts.push(`Says it is for ${draft.cardNamed}, which is not one of your cards.`);
  }
  if (draft.missing.length > 0) {
    parts.push(`Could not read: ${draft.missing.join(", ")}.`);
  }

  return parts.length > 0 ? parts.join(" ").slice(0, 500) : null;
}

/**
 * Jobs that were running when the process stopped.
 *
 * Their pictures are in a temporary directory that a reboot may well have
 * emptied, and a job stuck on RUNNING for ever would have a client polling
 * it for ever. Said plainly rather than retried: whoever uploaded them
 * still has the screenshots, and picking them again is a second of work.
 */
export async function failStalledImports(): Promise<void> {
  const stalled = await PerkImport.find({ status: { $in: ["QUEUED", "RUNNING"] } });

  for (const job of stalled) {
    for (const item of job.items) {
      if (item.status === "DONE") continue;
      item.status = "FAILED";
      item.problem = item.problem ?? "The server restarted while this was waiting.";
    }

    job.status = "FAILED";
    job.problem = "The server restarted before this finished. Pick the pictures again.";
    job.finishedAt = new Date();
    await job.save();

    await fs.rm(jobDir(job._id), { recursive: true, force: true }).catch(() => undefined);
  }
}
