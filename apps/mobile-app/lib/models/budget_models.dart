/// The monthly budget and the wallet: the shapes that replaced the daily
/// budget on Home.
///
/// One amount for the month that everything counts against - rent, EMIs and
/// SIPs included - shared out across categories, with whatever is left at
/// the month's end going into the savings bucket. And every card and bank
/// account as a face of its own, so where each one stands is on Home rather
/// than two screens in.
///
/// Read defensively throughout: a field an older server never sent comes
/// back as zero, null or empty rather than as a crash on the screen you
/// land on. models.dart re-exports this file.
library;

import 'home_models.dart';

int _int(Object? value) => value is int ? value : (value is num ? value.round() : 0);
int? _intOrNull(Object? value) => value is int ? value : (value is num ? value.round() : null);
String? _str(Object? value) => value is String && value.isNotEmpty ? value : null;
bool _bool(Object? value) => value is bool && value;
Map<String, dynamic>? _mapOrNull(Object? value) => value is Map<String, dynamic> ? value : null;
List<Map<String, dynamic>> _maps(Object? value) =>
    value is List ? value.whereType<Map<String, dynamic>>().toList() : const [];

/// How a month - or one category's share of it - is going.
///
/// The one pace in the app: it paces the budget you set, and says what a
/// day can cost from here and still leave the bills still due covered.
class MonthPace {
  /// on_track | high | over
  final String status;
  final int dayOfMonth;
  final int daysInMonth;

  /// Days left counting today - money can still be spent today.
  final int daysLeft;

  /// The budget less what is spent. Negative once it is over.
  final int remainingMinor;

  /// What a day can cost from here, fixed costs still due already set
  /// aside. Never below zero.
  final int safeDailyMinor;
  final int expectedSpentMinor;

  /// Spent less expected. Positive is ahead of plan.
  final int aheadByMinor;
  final int dailyAverageMinor;
  final int projectedSpentMinor;

  /// The IST day (YYYY-MM-DD) the money runs out at the average so far,
  /// when that is before the month ends. Null when it lasts.
  final String? runOutOn;
  final int fixedPaidMinor;
  final int fixedStillDueMinor;

  const MonthPace({
    required this.status,
    this.dayOfMonth = 1,
    this.daysInMonth = 30,
    this.daysLeft = 0,
    this.remainingMinor = 0,
    this.safeDailyMinor = 0,
    this.expectedSpentMinor = 0,
    this.aheadByMinor = 0,
    this.dailyAverageMinor = 0,
    this.projectedSpentMinor = 0,
    this.runOutOn,
    this.fixedPaidMinor = 0,
    this.fixedStillDueMinor = 0,
  });

  bool get isOver => status == 'over';
  bool get isHigh => status == 'high';

  static MonthPace? maybe(Object? value) {
    final json = _mapOrNull(value);
    if (json == null) return null;
    final status = json['status'];
    return MonthPace(
      status: status == 'high' || status == 'over' ? status as String : 'on_track',
      dayOfMonth: _intOrNull(json['dayOfMonth']) ?? 1,
      daysInMonth: _intOrNull(json['daysInMonth']) ?? 30,
      daysLeft: _int(json['daysLeft']),
      remainingMinor: _int(json['remainingMinor']),
      safeDailyMinor: _int(json['safeDailyMinor']),
      expectedSpentMinor: _int(json['expectedSpentMinor']),
      aheadByMinor: _int(json['aheadByMinor']),
      dailyAverageMinor: _int(json['dailyAverageMinor']),
      projectedSpentMinor: _int(json['projectedSpentMinor']),
      runOutOn: _str(json['runOutOn']),
      fixedPaidMinor: _int(json['fixedPaidMinor']),
      fixedStillDueMinor: _int(json['fixedStillDueMinor']),
    );
  }
}

/// Which month a budget status is about: pay day to pay day when a salary
/// day is set, the calendar month otherwise.
class BudgetMonth {
  /// YYYY-MM, the month of the pay day that opens it.
  final String key;

  /// Plain YYYY-MM-DD days in IST, [to] inclusive.
  final String from;
  final String to;
  final String label;
  final bool bySalary;
  final bool isCurrent;

  /// Over and done with: its result has gone into the savings bucket.
  final bool isClosed;
  final int daysInMonth;

  /// Today's place in it; null for a month that is not running.
  final int? dayOfMonth;
  final int daysLeft;

  const BudgetMonth({
    this.key = '',
    this.from = '',
    this.to = '',
    this.label = '',
    this.bySalary = false,
    this.isCurrent = true,
    this.isClosed = false,
    this.daysInMonth = 30,
    this.dayOfMonth,
    this.daysLeft = 0,
  });

  factory BudgetMonth.fromJson(Map<String, dynamic> json) => BudgetMonth(
        key: _str(json['key']) ?? '',
        from: _str(json['from']) ?? '',
        to: _str(json['to']) ?? '',
        label: _str(json['label']) ?? '',
        bySalary: _bool(json['bySalary']),
        isCurrent: json['isCurrent'] as bool? ?? true,
        isClosed: _bool(json['isClosed']),
        daysInMonth: _intOrNull(json['daysInMonth']) ?? 30,
        dayOfMonth: _intOrNull(json['dayOfMonth']),
        daysLeft: _int(json['daysLeft']),
      );
}

/// One category's limit inside the monthly budget, and what has gone on it.
class CategoryBudget {
  final String categoryId;
  final String name;
  final String? icon;
  final String? color;
  final int limitMinor;
  final int spentMinor;

  /// Negative once it is over.
  final int leftMinor;
  final bool isOver;
  final MonthPace? pace;

  const CategoryBudget({
    required this.categoryId,
    required this.name,
    this.icon,
    this.color,
    required this.limitMinor,
    this.spentMinor = 0,
    this.leftMinor = 0,
    this.isOver = false,
    this.pace,
  });

  factory CategoryBudget.fromJson(Map<String, dynamic> json) => CategoryBudget(
        categoryId: _str(json['categoryId']) ?? '',
        name: _str(json['name']) ?? 'A category',
        icon: _str(json['icon']),
        color: _str(json['color']),
        limitMinor: _int(json['limitMinor']),
        spentMinor: _int(json['spentMinor']),
        leftMinor: _int(json['leftMinor']),
        isOver: _bool(json['isOver']),
        pace: MonthPace.maybe(json['pace']),
      );
}

/// Spending in a category with no limit of its own. [categoryId] is null
/// for spending not yet given a category.
class UnplannedSpend {
  final String? categoryId;
  final String name;
  final int spentMinor;

  const UnplannedSpend({this.categoryId, required this.name, required this.spentMinor});

  factory UnplannedSpend.fromJson(Map<String, dynamic> json) => UnplannedSpend(
        categoryId: _str(json['categoryId']),
        name: _str(json['name']) ?? 'No category',
        spentMinor: _int(json['spentMinor']),
      );
}

/// The part of the budget no category limit claims - the unplanned pool -
/// and everything spent outside the limited categories.
class UnassignedPool {
  final int amountMinor;
  final int spentMinor;
  final int leftMinor;
  final bool isOver;
  final MonthPace? pace;

  /// What it went on, largest first.
  final List<UnplannedSpend> categories;

  const UnassignedPool({
    required this.amountMinor,
    this.spentMinor = 0,
    this.leftMinor = 0,
    this.isOver = false,
    this.pace,
    this.categories = const [],
  });

  static UnassignedPool? maybe(Object? value) {
    final json = _mapOrNull(value);
    if (json == null) return null;
    return UnassignedPool(
      amountMinor: _int(json['amountMinor']),
      spentMinor: _int(json['spentMinor']),
      leftMinor: _int(json['leftMinor']),
      isOver: _bool(json['isOver']),
      pace: MonthPace.maybe(json['pace']),
      categories: _maps(json['categories']).map(UnplannedSpend.fromJson).toList(),
    );
  }
}

/// The savings bucket each month's leftover goes into, as Home shows it.
class BucketSummary {
  final bool configured;
  final int balanceMinor;

  /// The balance if this month ended now with nothing more spent.
  final int balanceIfMonthEndedNowMinor;

  const BucketSummary({
    this.configured = false,
    this.balanceMinor = 0,
    this.balanceIfMonthEndedNowMinor = 0,
  });

  /// What the month running now would add - or take, when negative.
  int get thisMonthMinor => balanceIfMonthEndedNowMinor - balanceMinor;

  factory BucketSummary.fromJson(Map<String, dynamic>? json) {
    if (json == null || !_bool(json['configured'])) return const BucketSummary();
    return BucketSummary(
      configured: true,
      balanceMinor: _int(json['balanceMinor']),
      balanceIfMonthEndedNowMinor: _int(json['balanceIfMonthEndedNowMinor']),
    );
  }
}

/// One month against its budget: GET /budget/monthly, and `budget` on the
/// dashboard.
class MonthlyBudgetStatus {
  /// Whether a budget is in force for this month.
  final bool configured;

  /// Whether one has ever been set, so "not set" can be told apart from
  /// "this month is from before you set one".
  final bool everSet;
  final BudgetMonth month;
  final String? fromMonthKey;
  final int? budgetMinor;
  final int spentMinor;

  /// Negative when over.
  final int? leftMinor;
  final bool isOver;
  final MonthPace? pace;
  final List<CategoryBudget> categories;
  final UnassignedPool? unassigned;
  final BucketSummary bucket;

  /// The old daily budget times the days in the month, offered as a
  /// starting amount and never applied by itself.
  final int? suggestedMonthlyMinor;

  const MonthlyBudgetStatus({
    this.configured = false,
    this.everSet = false,
    this.month = const BudgetMonth(),
    this.fromMonthKey,
    this.budgetMinor,
    this.spentMinor = 0,
    this.leftMinor,
    this.isOver = false,
    this.pace,
    this.categories = const [],
    this.unassigned,
    this.bucket = const BucketSummary(),
    this.suggestedMonthlyMinor,
  });

  factory MonthlyBudgetStatus.fromJson(Map<String, dynamic> json) {
    final budget = _intOrNull(json['budgetMinor']);
    return MonthlyBudgetStatus(
      // Configured with no amount would be a budget of nothing; treat the
      // pair as one fact.
      configured: _bool(json['configured']) && budget != null && budget > 0,
      everSet: _bool(json['everSet']),
      month: BudgetMonth.fromJson(_mapOrNull(json['month']) ?? const {}),
      fromMonthKey: _str(json['fromMonthKey']),
      budgetMinor: budget,
      spentMinor: _int(json['spentMinor']),
      leftMinor: _intOrNull(json['leftMinor']),
      isOver: _bool(json['isOver']),
      pace: MonthPace.maybe(json['pace']),
      categories: _maps(json['categories']).map(CategoryBudget.fromJson).toList(),
      unassigned: UnassignedPool.maybe(json['unassigned']),
      bucket: BucketSummary.fromJson(_mapOrNull(json['bucket'])),
      suggestedMonthlyMinor: _intOrNull(json['suggestedMonthlyMinor']),
    );
  }
}

/// A credit card's last statement, as the face needs it.
class CardLastStatement {
  final int amountMinor;
  final int? minimumDueMinor;
  final String? statementOn;
  final String? dueOn;
  final int? owedMinor;
  final bool? isPaid;

  const CardLastStatement({
    required this.amountMinor,
    this.minimumDueMinor,
    this.statementOn,
    this.dueOn,
    this.owedMinor,
    this.isPaid,
  });

  static CardLastStatement? maybe(Object? value) {
    final json = _mapOrNull(value);
    if (json == null) return null;
    return CardLastStatement(
      amountMinor: _int(json['amountMinor']),
      minimumDueMinor: _intOrNull(json['minimumDueMinor']),
      statementOn: _str(json['statementOn']),
      dueOn: _str(json['dueOn']),
      owedMinor: _intOrNull(json['owedMinor']),
      isPaid: json['isPaid'] as bool?,
    );
  }
}

/// A credit card as its face shows it. The back - full number, expiry,
/// name - is never in here; it comes from the vault, behind the PIN.
class CardFace {
  final String accountId;
  final String name;
  final String bankName;
  final String? issuer;

  /// RUPAY | VISA | MASTERCARD | AMEX | DINERS, or null when not known.
  final String? network;
  final String? last4;

  /// "#RRGGBB" picked for the account, when one was.
  final String? color;
  final int? creditLimitMinor;
  final int? outstandingMinor;
  final bool outstandingIsEstimate;

  /// What the limit has lost: the unpaid bill plus this cycle, or the
  /// shared group's figure when the limit is shared.
  final int usedMinor;
  final int? availableMinor;
  final List<String> sharesLimitWith;
  final int cycleSpentMinor;
  final String? cycleStart;
  final String? cycleEnd;
  final bool periodIsCycle;
  final int? statementOn;
  final CardLastStatement? lastStatement;
  final String? nextDueOn;
  final int? daysToDue;

  /// The user's own limit for a cycle, as against the bank's.
  final int? spendLimitMinor;

  /// ok | close | over | unset - against [spendLimitMinor].
  final String state;
  final bool hasCardDetails;

  const CardFace({
    required this.accountId,
    required this.name,
    this.bankName = '',
    this.issuer,
    this.network,
    this.last4,
    this.color,
    this.creditLimitMinor,
    this.outstandingMinor,
    this.outstandingIsEstimate = false,
    this.usedMinor = 0,
    this.availableMinor,
    this.sharesLimitWith = const [],
    this.cycleSpentMinor = 0,
    this.cycleStart,
    this.cycleEnd,
    this.periodIsCycle = false,
    this.statementOn,
    this.lastStatement,
    this.nextDueOn,
    this.daysToDue,
    this.spendLimitMinor,
    this.state = 'unset',
    this.hasCardDetails = false,
  });

  factory CardFace.fromJson(Map<String, dynamic> json) {
    final state = json['state'];
    return CardFace(
      accountId: _str(json['accountId']) ?? '',
      name: _str(json['name']) ?? _str(json['bankName']) ?? 'Card',
      bankName: _str(json['bankName']) ?? '',
      issuer: _str(json['issuer']),
      network: _str(json['network'])?.toUpperCase(),
      last4: _str(json['last4']),
      color: _str(json['color']),
      creditLimitMinor: _intOrNull(json['creditLimitMinor']),
      outstandingMinor: _intOrNull(json['outstandingMinor']),
      outstandingIsEstimate: _bool(json['outstandingIsEstimate']),
      usedMinor: _int(json['usedMinor']),
      availableMinor: _intOrNull(json['availableMinor']),
      sharesLimitWith: (json['sharesLimitWith'] as List<dynamic>? ?? []).whereType<String>().toList(),
      cycleSpentMinor: _int(json['cycleSpentMinor']),
      cycleStart: _str(json['cycleStart']),
      cycleEnd: _str(json['cycleEnd']),
      periodIsCycle: _bool(json['periodIsCycle']),
      statementOn: _intOrNull(json['statementOn']),
      lastStatement: CardLastStatement.maybe(json['lastStatement']),
      nextDueOn: _str(json['nextDueOn']),
      daysToDue: _intOrNull(json['daysToDue']),
      spendLimitMinor: _intOrNull(json['spendLimitMinor']),
      state: state == 'ok' || state == 'close' || state == 'over' ? state as String : 'unset',
      hasCardDetails: _bool(json['hasCardDetails']),
    );
  }
}

/// A debit card drawing on a bank account.
class DebitCardFace {
  final String accountId;
  final String? last4;
  final String? network;
  final bool hasCardDetails;

  const DebitCardFace({required this.accountId, this.last4, this.network, this.hasCardDetails = false});

  factory DebitCardFace.fromJson(Map<String, dynamic> json) => DebitCardFace(
        accountId: _str(json['accountId']) ?? '',
        last4: _str(json['last4']),
        network: _str(json['network'])?.toUpperCase(),
        hasCardDetails: _bool(json['hasCardDetails']),
      );
}

/// A bank account or the cash pocket, as its tile on Home shows it.
class BankFace {
  final String accountId;
  final String name;
  final String bankName;

  /// BANK | CASH
  final String accountType;
  final String? last4;
  final String? color;

  /// Null until a starting balance has been entered - not the same as zero.
  final int? balanceMinor;

  /// The emergency pot: shown, but hidden behind a tap.
  final bool isSavings;
  final PocketStatus? pocket;
  final List<DebitCardFace> debitCards;
  final bool hasCardDetails;

  const BankFace({
    required this.accountId,
    required this.name,
    this.bankName = '',
    this.accountType = 'BANK',
    this.last4,
    this.color,
    this.balanceMinor,
    this.isSavings = false,
    this.pocket,
    this.debitCards = const [],
    this.hasCardDetails = false,
  });

  bool get isCash => accountType == 'CASH';

  factory BankFace.fromJson(Map<String, dynamic> json) {
    final pocket = _mapOrNull(json['pocket']);
    return BankFace(
      accountId: _str(json['accountId']) ?? '',
      name: _str(json['name']) ?? _str(json['bankName']) ?? 'Account',
      bankName: _str(json['bankName']) ?? '',
      accountType: _str(json['accountType']) ?? 'BANK',
      last4: _str(json['last4']),
      color: _str(json['color']),
      balanceMinor: _intOrNull(json['balanceMinor']),
      isSavings: _bool(json['isSavings']),
      pocket: pocket == null ? null : PocketStatus.fromJson(pocket),
      debitCards: _maps(json['debitCards']).map(DebitCardFace.fromJson).toList(),
      hasCardDetails: _bool(json['hasCardDetails']),
    );
  }
}

/// Every card and bank account, as faces. Savings comes last.
class Wallet {
  final List<CardFace> cards;
  final List<BankFace> banks;

  const Wallet({this.cards = const [], this.banks = const []});

  bool get isEmpty => cards.isEmpty && banks.isEmpty;

  factory Wallet.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const Wallet();
    return Wallet(
      cards: _maps(json['cards']).map(CardFace.fromJson).toList(),
      banks: _maps(json['banks']).map(BankFace.fromJson).toList(),
    );
  }
}
