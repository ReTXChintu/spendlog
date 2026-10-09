import { Router } from "express";
import { Types } from "mongoose";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { Account, CardStatement, CardVault, EmiInstalment, EmiPlan, Loan, LoanInstalment, Perk, Transaction } from "../../models";
import { istDayEnd, istDayKey, istDayStart } from "../../time";
import { monthSoFar as monthAgainstLast, userMonth } from "../budget/budget.months";
import { CardStatus, cardStatuses, normaliseNetwork, pickCards } from "../cards/cards.status";
import { budgetPace } from "../budget/budget.pace";
import { monthlyBudgetStatus } from "../budget/budget.monthly";
import { perkIsLive } from "../perks/perks.match";
import { upcomingBills } from "../statements/statements.bills";
import { loanProgress } from "../loans/loans.routes";
import { planStatus } from "../ai/ai.coach";
import { expectedBalances, tracksBalance } from "../accounts/accounts.balance";
import { PocketStatus, pocketStatuses } from "../accounts/accounts.pocket";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/**
 * Everything the landing screen needs, in one request.
 *
 * Seven round trips to draw one screen is slow on a phone on mobile data,
 * and this is the screen that has to be fastest because it is the one you
 * land on. So it is composed here rather than assembled by each client.
 *
 * What belongs here is decided by one test: could you *act* on it before
 * closing the app? A card near its limit changes which card comes out; a
 * chart of last March does not change anything. The second kind lives on
 * the analytics page.
 */

/** A coupon further off than this is not yet worth a line on the screen. */
const EXPIRING_WITHIN_DAYS = 10;

dashboardRouter.get("/", async (req, res) => {
  const userId = currentUserId(req);
  const now = new Date();

  const today = istDayKey(now);
  const yesterday = istDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  // The user's own month - salary day to salary day - like every other
  // monthly figure in the app.
  const month = await userMonth(userId, undefined, now);

  const [cards, pace, needsCategory, emis, loans, owed, perks, statements, monthSoFar, bills, budget, money, earmarks, plan, pocketMoney, banks] =
    await Promise.all([
    cardStatuses(userId, now),
    budgetPace(userId, now),
    countNeedingACategory(userId, yesterday, month.start),
    activeEmis(userId),
    activeLoans(userId),
    owedBalance(userId),
    Perk.find({ userId, isActive: true, usedAt: null }).populate("accountId"),
    statementsNeedingAttention(userId),
    monthAgainstLast(userId, now),
    upcomingBills(userId, now),
    monthlyBudgetStatus(userId, undefined, now),
    moneyOnHand(userId),
    openEarmarks(userId),
    planStatus(userId, now),
    pocketMoneyFor(userId, now),
    bankFaces(userId, now),
  ]);

  // Only the ones close enough to act on. Settled: shown here, never as a
  // notification — a coupon is not worth interrupting someone for.
  const expiring = perks
    .filter((perk) => perkIsLive(perk, now) && perk.expiresOn)
    .map((perk) => ({
      ...perk.toJSON(),
      daysLeft: Math.ceil((perk.expiresOn!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    }))
    .filter((perk) => perk.daysLeft <= EXPIRING_WITHIN_DAYS)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  res.json({
    today,
    pace,
    // The monthly budget: spent and left, the pace, each category's
    // limit, and the savings bucket's balance.
    budget,
    cards,
    // Every card and bank account as a card face, with everything the
    // front needs. The back - full number, expiry, name on card - is
    // never here: it comes from POST /vault/cards/:id/reveal, PIN and all.
    wallet: { cards: await cardFaces(userId, cards, now), banks },
    picks: pickCards(cards),
    needsCategory,
    emis,
    loans,
    owed,
    expiringPerks: expiring,
    statements,
    monthSoFar,
    // Only the ones still to pay. A bill already cleared is a fact about
    // last month, not something to do today.
    bills: bills.filter((bill) => !bill.isPaid),
    money,
    earmarks,
    // The savings plan's rules being broken this month, said every time the
    // dashboard is opened until they are not.
    planWarnings: plan?.warnings ?? [],
    pocketMoney,
  });
});

/**
 * What is in each bank account and in cash, as far as SpendLog can tell:
 * the starting balance typed in, moved by every transaction since. The
 * account marked as savings is shown on its own and left out of the total,
 * because it is the emergency fund and not money to spend.
 */
async function moneyOnHand(userId: Types.ObjectId) {
  const accounts = await Account.find({ userId, isActive: true, accountType: { $in: ["BANK", "CASH", "DEBIT"] } });
  const balances = await expectedBalances(userId, accounts);

  const rows = accounts
    .filter((account) => tracksBalance(account))
    .map((account) => ({
      id: account._id.toString(),
      name: account.nickname || account.bankName,
      last4: account.last4 ?? null,
      accountType: account.accountType,
      isSavings: Boolean(account.isSavings),
      balanceMinor: balances.get(account._id.toString())?.expectedMinor ?? null,
    }))
    // Spendable money first, cash after the banks, the savings account last.
    .sort((a, b) => Number(a.isSavings) - Number(b.isSavings) || (a.accountType === "CASH" ? 1 : 0) - (b.accountType === "CASH" ? 1 : 0));

  const spendable = rows.filter((row) => !row.isSavings && row.balanceMinor !== null);
  return {
    accounts: rows,
    onHandMinor: spendable.reduce((sum, row) => sum + row.balanceMinor!, 0),
    inBankMinor: spendable.filter((row) => row.accountType !== "CASH").reduce((sum, row) => sum + row.balanceMinor!, 0),
    cashMinor: rows.find((row) => row.accountType === "CASH")?.balanceMinor ?? null,
    savingsMinor: rows.find((row) => row.isSavings)?.balanceMinor ?? null,
    /// Bank or cash accounts with no starting balance yet, so not counted.
    untracked: rows.filter((row) => row.balanceMinor === null).length,
  };
}

/** Whole days from the start of today, in IST, to a date. */
function daysUntil(now: Date, to: Date | null): number | null {
  if (!to) return null;
  return Math.round((to.getTime() - istDayStart(istDayKey(now)).getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * A credit card, as its face shows it.
 *
 * Built on the statuses the dashboard already has, so the face and the
 * card strip cannot disagree about what is available. The due date worth
 * counting down to is the unpaid bill's; with nothing unpaid, the one the
 * cycle now running will fall due on.
 */
async function cardFaces(userId: Types.ObjectId, cards: CardStatus[], now: Date) {
  const vaults = new Set(
    (await CardVault.find({ userId }).select("accountId")).map((vault) => vault.accountId.toString())
  );
  return cards.map((card) => {
    const owing = card.billIsPaid === false;
    const nextDueOn = owing ? card.billDueOn : card.dueOn;
    return {
      accountId: card.accountId,
      name: card.name,
      bankName: card.bankName,
      issuer: card.issuer,
      network: card.network,
      last4: card.last4,
      color: card.color,
      creditLimitMinor: card.creditLimitMinor,
      outstandingMinor: card.outstandingMinor,
      outstandingIsEstimate: card.outstandingIsEstimate,
      usedMinor: card.groupUsedMinor ?? card.usedMinor,
      availableMinor: card.availableMinor,
      sharesLimitWith: card.sharesLimitWith,
      cycleSpentMinor: card.spentMinor,
      cycleStart: card.periodStart,
      cycleEnd: card.cycleEnd ?? card.periodEnd,
      periodIsCycle: card.periodIsCycle,
      statementOn: card.statementOn,
      lastStatement:
        card.lastStatementMinor !== null
          ? {
              amountMinor: card.lastStatementMinor,
              minimumDueMinor: card.minimumDueMinor,
              statementOn: card.lastStatementOn,
              dueOn: card.billDueOn,
              owedMinor: card.outstandingMinor,
              isPaid: card.billIsPaid,
            }
          : null,
      nextDueOn,
      daysToDue: owing ? card.billDaysUntilDue : daysUntil(now, nextDueOn),
      spendLimitMinor: card.limitMinor,
      state: card.state,
      hasCardDetails: vaults.has(card.accountId),
    };
  });
}

/**
 * Every bank account and cash, as a face: what it should hold, whether it
 * is the savings account (shown, but hidden behind a tap by the screens),
 * the debit cards that draw on it, and pocket money where it is that.
 */
async function bankFaces(userId: Types.ObjectId, now: Date) {
  const accounts = await Account.find({ userId, isActive: true, accountType: { $in: ["BANK", "CASH", "DEBIT"] } });
  const [balances, pockets, vaults] = await Promise.all([
    expectedBalances(userId, accounts),
    pocketStatuses(userId, accounts, now),
    CardVault.find({ userId }).select("accountId"),
  ]);
  const stored = new Set(vaults.map((vault) => vault.accountId.toString()));

  return accounts
    .filter((account) => tracksBalance(account))
    .map((account) => {
      const id = account._id.toString();
      const pocket: PocketStatus | null = pockets.get(id) ?? null;
      return {
        accountId: id,
        name: account.nickname || account.bankName,
        bankName: account.bankName,
        accountType: account.accountType,
        last4: account.last4 ?? null,
        color: account.color ?? null,
        /// Null until a starting balance has been entered.
        balanceMinor: balances.get(id)?.expectedMinor ?? null,
        isSavings: Boolean(account.isSavings),
        pocket,
        debitCards: accounts
          .filter((card) => card.accountType === "DEBIT" && card.linkedAccountId?.equals(account._id))
          .map((card) => ({
            accountId: card._id.toString(),
            last4: card.last4 ?? null,
            network: normaliseNetwork(card.cardNetwork),
            hasCardDetails: stored.has(card._id.toString()),
          })),
        hasCardDetails: stored.has(id),
      };
    })
    .sort((a, b) => Number(a.isSavings) - Number(b.isSavings) || (a.accountType === "CASH" ? 1 : 0) - (b.accountType === "CASH" ? 1 : 0));
}

/**
 * Money that came in for something still to be bought, and how much of it
 * is still waiting to be spent.
 */
async function openEarmarks(userId: Types.ObjectId) {
  const credits = await Transaction.find({ userId, type: "CREDIT", isEarmarked: true }).sort({ occurredAt: -1 });
  const items = credits
    .map((credit) => {
      const spent = credit.refundOf.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      return {
        id: credit._id.toString(),
        merchant: credit.merchant ?? null,
        note: credit.note ?? null,
        occurredAt: credit.occurredAt,
        amountMinor: credit.amountMinor,
        spentMinor: spent,
        leftMinor: Math.max(0, credit.amountMinor - spent),
      };
    })
    .filter((item) => item.leftMinor > 0);
  return { count: items.length, totalMinor: items.reduce((sum, item) => sum + item.leftMinor, 0), items };
}

/**
 * How much still needs a person: yesterday, and the month as a whole.
 *
 * Yesterday is what the midnight reminder asks about, so the dashboard
 * shows the same figure — two screens disagreeing about how much is left
 * to do would make both of them untrustworthy.
 */
async function countNeedingACategory(userId: Types.ObjectId, yesterday: string, monthStart: Date) {
  const unfiled = {
    categoryId: null,
    isTransfer: false,
    countedAmountMinor: { $gt: 0 },
  };

  const [yesterdayCount, monthCount] = await Promise.all([
    Transaction.countDocuments({
      userId,
      ...unfiled,
      occurredAt: { $gte: istDayStart(yesterday), $lte: istDayEnd(yesterday) },
    }),
    Transaction.countDocuments({ userId, ...unfiled, occurredAt: { $gte: monthStart } }),
  ]);

  return { yesterday: yesterdayCount, month: monthCount };
}

/**
 * Money already committed, whatever this month's spending looks like.
 *
 * What is left to pay is the sum of the instalments still due, ignoring
 * any deliberately skipped - the same rule the EMI list uses, because two
 * screens disagreeing about a debt is worse than either figure.
 */
async function activeEmis(userId: Types.ObjectId) {
  const plans = await EmiPlan.find({ userId, status: "ACTIVE" }).sort({ createdAt: 1 });
  const instalments = await EmiInstalment.find({
    planId: { $in: plans.map((plan) => plan._id) },
    status: "DUE",
  });

  const remainingFor = (planId: Types.ObjectId) =>
    instalments
      .filter((instalment) => instalment.planId.equals(planId))
      .reduce((total, instalment) => total + instalment.amountMinor, 0);

  return {
    count: plans.length,
    monthlyMinor: plans.reduce((total, plan) => total + plan.monthlyAmountMinor, 0),
    remainingMinor: instalments.reduce((total, instalment) => total + instalment.amountMinor, 0),
    plans: plans.slice(0, 4).map((plan) => ({
      ...plan.toJSON(),
      remainingMinor: remainingFor(plan._id),
    })),
  };
}

/** The same figures, for loans taken outside a card. See activeEmis. */
async function activeLoans(userId: Types.ObjectId) {
  const loans = await Loan.find({ userId, status: "ACTIVE" }).sort({ createdAt: 1 });
  const instalments = await LoanInstalment.find({ loanId: { $in: loans.map((loan) => loan._id) } });

  const withProgress = loans.map((loan) => ({
    ...loan.toJSON(),
    ...loanProgress(instalments.filter((instalment) => instalment.loanId.equals(loan._id))),
  }));

  return {
    count: loans.length,
    monthlyMinor: loans.reduce((total, loan) => total + loan.monthlyAmountMinor, 0),
    remainingMinor: withProgress.reduce((total, loan) => total + loan.remainingMinor, 0),
    // Soonest due first: the one to have money ready for.
    loans: withProgress.sort(
      (a, b) => (a.nextDue?.dueDate.getTime() ?? Infinity) - (b.nextDue?.dueDate.getTime() ?? Infinity)
    ),
  };
}

/**
 * What people owe each other. Not month-scoped: a debt does not reset in
 * January.
 */
async function owedBalance(userId: Types.ObjectId) {
  const rows = await Transaction.aggregate<{ _id: null; lent: number; settledIn: number; settledOut: number }>([
    { $match: { userId } },
    {
      $group: {
        _id: null,
        // The part of a split bill that was never the user's own spending,
        // which is the bill less their share. There is no stored field for
        // it - this used to read split.owedToMeMinor, which does not exist
        // on the schema, so every lent rupee summed as nothing and the
        // dashboard reported money owed *by* the user whenever anyone paid
        // them back.
        lent: {
          $sum: {
            $cond: [
              { $ne: [{ $ifNull: ["$split.myShareMinor", null] }, null] },
              { $subtract: ["$amountMinor", "$split.myShareMinor"] },
              0,
            ],
          },
        },
        settledIn: {
          $sum: { $cond: [{ $and: ["$isSettlement", { $eq: ["$type", "CREDIT"] }] }, "$amountMinor", 0] },
        },
        settledOut: {
          $sum: { $cond: [{ $and: ["$isSettlement", { $eq: ["$type", "DEBIT"] }] }, "$amountMinor", 0] },
        },
      },
    },
  ]);

  const row = rows[0];
  if (!row) return { balanceMinor: 0 };

  return { balanceMinor: row.lent - row.settledIn + row.settledOut };
}

/**
 * Statements that cannot be read without someone doing something.
 *
 * UNREADABLE is in the list as well as the two fixable ones. A file nobody
 * can open is still worth naming - left out, it sat in the database with a
 * reason recorded against it and no screen that would ever show it.
 */
async function statementsNeedingAttention(userId: Types.ObjectId) {
  const stuck = await CardStatement.find({
    userId,
    status: { $in: ["LOCKED", "UNIDENTIFIED", "UNREADABLE"] },
  })
    .sort({ statementDate: -1 })
    .limit(5);

  return {
    stuckCount: stuck.length,
    stuck: stuck.map((statement) => ({
      id: statement._id.toString(),
      status: statement.status,
      problem: statement.problem ?? null,
      subject: statement.subject ?? null,
      statementDate: statement.statementDate,
    })),
  };
}

/** Every pocket-money account, with this month's spending and when to top up. */
async function pocketMoneyFor(userId: Types.ObjectId, now: Date) {
  const accounts = await Account.find({ userId, isActive: true, pocketMoney: { $ne: null } });
  const statuses = await pocketStatuses(userId, accounts, now);
  return accounts
    .map((account) => {
      const status = statuses.get(account._id.toString());
      return status
        ? { accountId: account._id.toString(), name: account.nickname || account.bankName, ...status }
        : null;
    })
    .filter(Boolean);
}
