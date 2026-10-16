import { Types } from "mongoose";
import { AccountDoc, BalanceCheckpoint, MissingCredit, Transaction } from "../../models";
import { BalanceCheckpointSource, CountedReason, TransactionSource, TransactionType } from "../../types";

/**
 * What an account should hold right now, from a starting balance and
 * everything that has moved through it since - and, row by row, what it
 * should have held after each one, set against what the bank said it held.
 *
 * Counted on the amount the bank moved, not on countedAmountMinor. The two
 * questions differ: a transfer to your own savings is not spending, but
 * the money has still left this account; a split bill was only partly
 * yours, but all of it came out. A balance is about money, not spending.
 *
 * A bank account's debit cards spend from it, so their transactions count
 * here too - the card is a way into the account, not an account of its own.
 *
 * One walk serves every question asked of a balance. The overview and the
 * dashboard want the figure now; the passbook wants every step on the way
 * to it; the reconciler wants where the steps and the bank's own figures
 * first parted. Working them out separately would mean the rules above
 * written twice, and two screens that disagree about a balance are worse
 * than either being wrong.
 */

/// A bank rounds, an SMS truncates: a rupee either way is not a drift.
export const DRIFT_TOLERANCE_MINOR = 100;

export interface ExpectedBalance {
  openingMinor: number;
  since: Date;
  inMinor: number;
  outMinor: number;
  expectedMinor: number;
  transactionCount: number;
  /// Money the bank's figures say came in and nobody has explained yet
  /// (open missing credits), already inside expectedMinor. Not in inMinor:
  /// it is not a transaction, and it counts as nothing until answered.
  provisionalMinor: number;
  /// The bank's latest figure for the account, whatever the gap.
  lastStated: { minor: number; at: Date } | null;
  /// How far the app is from the bank's latest figure for this account,
  /// when it is further than rounding. The bank's figure less the app's:
  /// negative means the app shows more than the bank does. `since` is
  /// where the passbook saw the two part, or the figure's own moment when
  /// it cannot say.
  drift: { minor: number; since: Date; statedAt: Date } | null;
}

export type LedgerEntryKind = "opening" | "txn" | "adjustment" | "checkpoint" | "missing_credit";

/** One line of an account's passbook. */
export interface LedgerEntry {
  /// Position in the account's history, oldest first; the opening row is 0.
  /// The passbook pages by it.
  seq: number;
  kind: LedgerEntryKind;
  at: Date;
  transactionId: string | null;
  checkpointId: string | null;
  merchant: string | null;
  /// Which way the money moved *this* account. On the far leg of a
  /// one-row transfer it is the opposite of the transaction's own type.
  type: TransactionType | null;
  amountMinor: number | null;
  /// What the app expects the account held after this row.
  runningMinor: number;
  /// What the bank said it held, from the SMS or the checkpoint; or null.
  statedMinor: number | null;
  /// stated less running, where there is a stated figure.
  driftMinor: number | null;
  countedReason: CountedReason | null;
  source: TransactionSource | BalanceCheckpointSource | null;
  isTransfer: boolean;
  /// On a transfer, the other account from this account's side.
  transferAccountId: string | null;
  accountUnknown: boolean;
  needsExplanation: boolean;
  /// A leg SpendLog wrote in for a transfer whose bank sent no message for
  /// this side, not yet confirmed by one.
  autoLeg: boolean;
  note: string | null;
  /// On a missing_credit row: which one, and when its window opened. The
  /// row stands at the end of the window, just before the figure that
  /// showed the money had arrived.
  missingCreditId: string | null;
  windowStart: Date | null;
}

/** A moment the bank's figure and the app's were both known. */
export interface StatedPoint {
  seq: number;
  minor: number;
  at: Date;
  transactionId: string | null;
  checkpointId: string | null;
  expectedMinor: number;
  driftMinor: number;
}

export interface AccountLedger {
  accountId: string;
  openingMinor: number;
  openingAt: Date;
  entries: LedgerEntry[];
  inMinor: number;
  outMinor: number;
  transactionCount: number;
  expectedNowMinor: number;
  /// Open missing credits counted in, provisionally. See buildLedger.
  provisionalMinor: number;
  /// The latest figure the bank gave, and how the app stood beside it.
  lastStated: StatedPoint | null;
  /// The earliest stated figure the app was off from, when the one before
  /// it (if any) agreed: where it went wrong.
  firstDrift: StatedPoint | null;
  /// The last stated figure before firstDrift that the app agreed with.
  /// Whatever went wrong happened between this and firstDrift.
  cleanBefore: StatedPoint | null;
}

/** Only an account holding money has a balance to track. */
export function tracksBalance(account: Pick<AccountDoc, "accountType">): boolean {
  return account.accountType === "BANK" || account.accountType === "CASH";
}

type AccountLike = Pick<AccountDoc, "_id" | "accountType" | "linkedAccountId" | "openingBalanceMinor" | "openingBalanceAt">;

/** The fields of a transaction the walk reads. */
export type LedgerRow = {
  _id: Types.ObjectId;
  accountId?: Types.ObjectId | null;
  type: TransactionType;
  amountMinor: number;
  occurredAt: Date;
  isTransfer?: boolean;
  transferAccountId?: Types.ObjectId | null;
  transferPairId?: Types.ObjectId | null;
  merchant?: string | null;
  countedReason?: CountedReason;
  source?: TransactionSource;
  statedBalanceMinor?: number | null;
  accountUnknown?: boolean;
  isAdjustment?: boolean;
  needsExplanation?: boolean;
  autoLeg?: boolean;
};

export type LedgerCheckpoint = {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  on: Date;
  balanceMinor: number;
  source: BalanceCheckpointSource;
  note?: string | null;
};

/** Which tracked accounts a user has, and which account each row's id stands for. */
export interface LedgerContext {
  tracked: AccountLike[];
  /// Every account id that moves a tracked balance, mapped to the tracked
  /// account it moves: a tracked account to itself, a debit card to the
  /// bank it draws on.
  ownerOf: Map<string, string>;
  cashId: string | null;
  sinceFor: Map<string, Date>;
}

export function ledgerContext(accounts: AccountLike[]): LedgerContext {
  const tracked = accounts.filter(
    (account) => tracksBalance(account) && account.openingBalanceMinor != null && account.openingBalanceAt
  );

  const ownerOf = new Map<string, string>();
  for (const account of tracked) ownerOf.set(account._id.toString(), account._id.toString());
  for (const account of accounts) {
    if (account.accountType === "DEBIT" && account.linkedAccountId) {
      const owner = account.linkedAccountId.toString();
      if (ownerOf.has(owner)) ownerOf.set(account._id.toString(), owner);
    }
  }

  const cash = tracked.find((account) => account.accountType === "CASH");
  return {
    tracked,
    ownerOf,
    cashId: cash?._id.toString() ?? null,
    sinceFor: new Map(tracked.map((account) => [account._id.toString(), account.openingBalanceAt!])),
  };
}

/** One tracked account a row moves, and how. */
export interface LedgerMove {
  owner: string;
  /// Which way it moved the owner.
  type: TransactionType;
  /// The row is on another account and reaches this one as the far side
  /// of a one-row transfer.
  viaTransfer: boolean;
  /// The other account, from the owner's side.
  transferAccountId: string | null;
}

/**
 * Which tracked balances a row moves. The rules, in one place:
 *
 *   - a row on a tracked account, or on a debit card that draws on one,
 *     moves that account;
 *   - a row with no account was paid in cash - that is what "no account"
 *     has always meant - unless nobody knows which account it was on
 *     (accountUnknown), in which case it moves nothing: a guess at cash is
 *     exactly the kind of error this exists to find;
 *   - a transfer recorded as one row moves the other account too, unless
 *     the other side has a row of its own (transferPairId) - one that
 *     arrived as a message, or one written in for it (autoLeg). Since
 *     transfers are given both legs (transactions.transfer.ts), the one-row
 *     case is what is left: a leg deleted by hand, or no account to put
 *     one on;
 *   - nothing moves before the moment the opening balance was read. A
 *     payment in the same minute was already in the figure typed in.
 */
export function movementsOf(row: LedgerRow, context: LedgerContext): LedgerMove[] {
  const moves: LedgerMove[] = [];
  const here = row.accountId
    ? (context.ownerOf.get(row.accountId.toString()) ?? null)
    : row.accountUnknown
      ? null
      : context.cashId;
  const there =
    row.isTransfer && row.transferAccountId && !row.transferPairId
      ? (context.ownerOf.get(row.transferAccountId.toString()) ?? null)
      : null;

  const after = (owner: string) => row.occurredAt > context.sinceFor.get(owner)!;

  if (here && after(here)) {
    moves.push({
      owner: here,
      type: row.type,
      viaTransfer: false,
      transferAccountId: row.isTransfer ? (row.transferAccountId?.toString() ?? null) : null,
    });
  }
  // Money out of one own account is money into the other, and the other
  // way round.
  if (there && there !== here && after(there)) {
    moves.push({
      owner: there,
      type: row.type === "DEBIT" ? "CREDIT" : "DEBIT",
      viaTransfer: true,
      transferAccountId: row.accountId?.toString() ?? null,
    });
  }
  return moves;
}

/** The rows that could move any of these tracked accounts. */
export function ledgerFilter(userId: Types.ObjectId, context: LedgerContext, owners: string[]) {
  const wanted = new Set(owners);
  const ids = [...context.ownerOf.entries()]
    .filter(([, owner]) => wanted.has(owner))
    .map(([id]) => new Types.ObjectId(id));
  const earliest = new Date(Math.min(...owners.map((owner) => context.sinceFor.get(owner)!.getTime())));

  return {
    userId,
    occurredAt: { $gt: earliest },
    $or: [
      { accountId: { $in: ids } },
      ...(context.cashId && wanted.has(context.cashId) ? [{ accountId: null }] : []),
      // A transfer recorded as one row: the other account moves too.
      { isTransfer: true, transferAccountId: { $in: ids }, transferPairId: null },
    ],
  };
}

const KIND_ORDER: Record<LedgerEntryKind, number> = {
  opening: 0,
  txn: 1,
  adjustment: 1,
  missing_credit: 1,
  checkpoint: 2,
};

/** An open missing credit, as much of it as the walk reads. */
export type LedgerMissingCredit = {
  _id: Types.ObjectId;
  amountMinor: number;
  after: Date;
  before: Date;
  beforeTransactionId?: Types.ObjectId | null;
  beforeCheckpointId?: Types.ObjectId | null;
};

/**
 * One account's passbook, from its opening balance, every row that moved
 * it, and every figure the bank gave for it. Pure: what it is handed is
 * what it reads.
 *
 * Rows in the same instant go opening, transactions, checkpoint - a
 * checkpoint says what the account held once that instant's payments were
 * in. The drift at each stated figure is the bank's less the app's, and
 * the first drift is the earliest one the app was off at when the stated
 * figure before it agreed - that is where the two parted.
 *
 * Open missing credits, when handed in, are walked as provisional money
 * in: each just before the stated figure that showed it had arrived, so
 * that figure agrees with the running balance and the passbook's column
 * matches the bank's from there on. They move expectedNowMinor and
 * provisionalMinor and nothing else - not inMinor, not the count - since
 * they are not transactions. Finding missing credits walks without them
 * (accountLedgers' provisional: false): with them in, the gap they stand
 * for would already be closed.
 */
export function buildLedger(params: {
  accountId: string;
  openingMinor: number;
  openingAt: Date;
  moves: { row: LedgerRow; move: LedgerMove }[];
  checkpoints: LedgerCheckpoint[];
  missingCredits?: LedgerMissingCredit[];
}): AccountLedger {
  type Pending =
    | { kind: "txn" | "adjustment"; at: Date; id: string; row: LedgerRow; move: LedgerMove }
    | { kind: "checkpoint"; at: Date; id: string; checkpoint: LedgerCheckpoint }
    | { kind: "missing_credit"; at: Date; id: string; credit: LedgerMissingCredit };

  const pending: Pending[] = [
    ...params.moves.map(({ row, move }) => ({
      kind: (row.isAdjustment ? "adjustment" : "txn") as "txn" | "adjustment",
      at: row.occurredAt,
      id: row._id.toString(),
      row,
      move,
    })),
    ...params.checkpoints
      .filter((checkpoint) => checkpoint.on > params.openingAt)
      .map((checkpoint) => ({
        kind: "checkpoint" as const,
        at: checkpoint.on,
        id: checkpoint._id.toString(),
        checkpoint,
      })),
  ].sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id)
  );

  // Each missing credit just before the figure that revealed it. Where
  // that figure has gone - a row deleted since - at the end of its window,
  // which is as near as anything can say.
  for (const credit of params.missingCredits ?? []) {
    if (credit.before <= params.openingAt) continue;
    const item = { kind: "missing_credit" as const, at: credit.before, id: credit._id.toString(), credit };
    const pointId = credit.beforeTransactionId?.toString() ?? credit.beforeCheckpointId?.toString() ?? null;
    let index = pointId ? pending.findIndex((other) => other.kind !== "missing_credit" && other.id === pointId) : -1;
    if (index < 0) {
      index = pending.findIndex((other) => other.at > credit.before);
      if (index < 0) index = pending.length;
    }
    pending.splice(index, 0, item);
  }

  const entries: LedgerEntry[] = [
    {
      seq: 0,
      kind: "opening",
      at: params.openingAt,
      transactionId: null,
      checkpointId: null,
      merchant: null,
      type: null,
      amountMinor: null,
      runningMinor: params.openingMinor,
      statedMinor: params.openingMinor,
      driftMinor: 0,
      countedReason: null,
      source: null,
      isTransfer: false,
      transferAccountId: null,
      accountUnknown: false,
      needsExplanation: false,
      autoLeg: false,
      note: null,
      missingCreditId: null,
      windowStart: null,
    },
  ];

  let running = params.openingMinor;
  let provisionalMinor = 0;
  let inMinor = 0;
  let outMinor = 0;
  let transactionCount = 0;
  let lastStated: StatedPoint | null = null;
  let firstDrift: StatedPoint | null = null;
  let cleanBefore: StatedPoint | null = null;
  // The stated figure before the one being looked at, for "the one before
  // it agreed".
  let previousStated: StatedPoint | null = null;

  for (const item of pending) {
    const seq = entries.length;
    let entry: LedgerEntry;

    if (item.kind === "missing_credit") {
      running += item.credit.amountMinor;
      provisionalMinor += item.credit.amountMinor;
      entry = {
        seq,
        kind: "missing_credit",
        at: item.at,
        transactionId: null,
        checkpointId: null,
        merchant: null,
        type: "CREDIT",
        amountMinor: item.credit.amountMinor,
        runningMinor: running,
        statedMinor: null,
        driftMinor: null,
        countedReason: null,
        source: null,
        isTransfer: false,
        transferAccountId: null,
        accountUnknown: false,
        needsExplanation: true,
        autoLeg: false,
        note: null,
        missingCreditId: item.id,
        windowStart: item.credit.after,
      };
    } else if (item.kind === "checkpoint") {
      entry = {
        seq,
        kind: "checkpoint",
        at: item.at,
        transactionId: null,
        checkpointId: item.id,
        merchant: null,
        type: null,
        amountMinor: null,
        runningMinor: running,
        statedMinor: item.checkpoint.balanceMinor,
        driftMinor: item.checkpoint.balanceMinor - running,
        countedReason: null,
        source: item.checkpoint.source,
        isTransfer: false,
        transferAccountId: null,
        accountUnknown: false,
        needsExplanation: false,
        autoLeg: false,
        note: item.checkpoint.note ?? null,
        missingCreditId: null,
        windowStart: null,
      };
    } else {
      const { row, move } = item;
      if (move.type === "CREDIT") {
        running += row.amountMinor;
        inMinor += row.amountMinor;
      } else {
        running -= row.amountMinor;
        outMinor += row.amountMinor;
      }
      transactionCount += 1;

      // The bank's figure is about the account its message named. On the
      // far leg of a transfer it is the other account's balance, and a
      // payment counted as cash never had one.
      const stated = !move.viaTransfer && row.accountId ? (row.statedBalanceMinor ?? null) : null;
      entry = {
        seq,
        kind: item.kind,
        at: item.at,
        transactionId: item.id,
        checkpointId: null,
        merchant: row.merchant ?? null,
        type: move.type,
        amountMinor: row.amountMinor,
        runningMinor: running,
        statedMinor: stated,
        driftMinor: stated === null ? null : stated - running,
        countedReason: row.countedReason ?? null,
        source: row.source ?? null,
        isTransfer: Boolean(row.isTransfer),
        transferAccountId: move.transferAccountId,
        accountUnknown: Boolean(row.accountUnknown),
        needsExplanation: Boolean(row.needsExplanation),
        autoLeg: Boolean(row.autoLeg),
        note: null,
        missingCreditId: null,
        windowStart: null,
      };
    }

    entries.push(entry);

    if (entry.statedMinor !== null && entry.driftMinor !== null) {
      const point: StatedPoint = {
        seq,
        minor: entry.statedMinor,
        at: entry.at,
        transactionId: entry.transactionId,
        checkpointId: entry.checkpointId,
        expectedMinor: entry.runningMinor,
        driftMinor: entry.driftMinor,
      };
      const off = Math.abs(point.driftMinor) > DRIFT_TOLERANCE_MINOR;
      const previousAgreed = !previousStated || Math.abs(previousStated.driftMinor) <= DRIFT_TOLERANCE_MINOR;
      if (!firstDrift && off && previousAgreed) {
        firstDrift = point;
        cleanBefore = previousStated;
      }
      lastStated = point;
      previousStated = point;
    }
  }

  return {
    accountId: params.accountId,
    openingMinor: params.openingMinor,
    openingAt: params.openingAt,
    entries,
    inMinor,
    outMinor,
    transactionCount,
    expectedNowMinor: running,
    provisionalMinor,
    lastStated,
    firstDrift,
    cleanBefore,
  };
}

const ROW_FIELDS =
  "accountId type amountMinor occurredAt isTransfer transferAccountId transferPairId merchant countedReason source " +
  "statedBalanceMinor accountUnknown isAdjustment needsExplanation autoLeg";

/**
 * The passbook of every tracked account among these - or of the ones
 * named, when only some are wanted - read in one query each for rows and
 * checkpoints.
 */
export async function accountLedgers(
  userId: Types.ObjectId,
  accounts: AccountLike[],
  only?: string[],
  options: { provisional?: boolean } = {}
): Promise<Map<string, AccountLedger>> {
  const context = ledgerContext(accounts);
  const owners = context.tracked
    .map((account) => account._id.toString())
    .filter((id) => !only || only.includes(id));
  const result = new Map<string, AccountLedger>();
  if (owners.length === 0) return result;

  const ownerIds = owners.map((id) => new Types.ObjectId(id));
  const [rows, checkpoints, credits] = await Promise.all([
    Transaction.find(ledgerFilter(userId, context, owners)).select(ROW_FIELDS).lean<LedgerRow[]>(),
    BalanceCheckpoint.find({ userId, accountId: { $in: ownerIds } }).lean<LedgerCheckpoint[]>(),
    options.provisional === false
      ? Promise.resolve([] as (LedgerMissingCredit & { accountId: Types.ObjectId })[])
      : MissingCredit.find({ userId, accountId: { $in: ownerIds }, status: "open" })
          .select("accountId amountMinor after before beforeTransactionId beforeCheckpointId")
          .lean<(LedgerMissingCredit & { accountId: Types.ObjectId })[]>(),
  ]);

  const movesFor = new Map<string, { row: LedgerRow; move: LedgerMove }[]>(owners.map((id) => [id, []]));
  for (const row of rows) {
    for (const move of movementsOf(row, context)) {
      movesFor.get(move.owner)?.push({ row, move });
    }
  }

  const openingFor = new Map(context.tracked.map((account) => [account._id.toString(), account.openingBalanceMinor!]));
  for (const owner of owners) {
    result.set(
      owner,
      buildLedger({
        accountId: owner,
        openingMinor: openingFor.get(owner)!,
        openingAt: context.sinceFor.get(owner)!,
        moves: movesFor.get(owner)!,
        checkpoints: checkpoints.filter((checkpoint) => checkpoint.accountId.toString() === owner),
        missingCredits: credits.filter((credit) => credit.accountId.toString() === owner),
      })
    );
  }
  return result;
}

/** The drift an account's balance should be shown with, or null when it is in step. */
export function driftOf(ledger: AccountLedger): ExpectedBalance["drift"] {
  const stated = ledger.lastStated;
  if (!stated || Math.abs(stated.driftMinor) <= DRIFT_TOLERANCE_MINOR) return null;
  return {
    minor: stated.driftMinor,
    since: ledger.firstDrift?.at ?? stated.at,
    statedAt: stated.at,
  };
}

export async function expectedBalances(
  userId: Types.ObjectId,
  accounts: AccountLike[]
): Promise<Map<string, ExpectedBalance>> {
  const ledgers = await accountLedgers(userId, accounts);
  const result = new Map<string, ExpectedBalance>();
  for (const [id, ledger] of ledgers) {
    result.set(id, {
      openingMinor: ledger.openingMinor,
      since: ledger.openingAt,
      inMinor: ledger.inMinor,
      outMinor: ledger.outMinor,
      expectedMinor: ledger.expectedNowMinor,
      transactionCount: ledger.transactionCount,
      provisionalMinor: ledger.provisionalMinor,
      lastStated: ledger.lastStated ? { minor: ledger.lastStated.minor, at: ledger.lastStated.at } : null,
      drift: driftOf(ledger),
    });
  }
  return result;
}
