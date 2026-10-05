/// The newer shapes behind Home: money on hand, money set aside, the AI
/// savings plan and insights, and the extra analytics breakdowns.
///
/// Kept out of models.dart so that file only gains the fields that point
/// here; models.dart re-exports this one, so screens import one file.
library;

int _int(Object? value) => value is int ? value : (value is num ? value.round() : 0);
int? _intOrNull(Object? value) => value is int ? value : (value is num ? value.round() : null);
DateTime? _date(Object? value) => value is String && value.isNotEmpty ? DateTime.tryParse(value) : null;

/// One bank account or the cash pocket, with what it should hold now.
class MoneyAccount {
  final String id;
  final String name;
  final String? last4;

  /// BANK | CASH
  final String accountType;
  final bool isSavings;

  /// Null until a starting balance has been given - not the same as zero.
  final int? balanceMinor;

  MoneyAccount({
    required this.id,
    required this.name,
    this.last4,
    required this.accountType,
    this.isSavings = false,
    this.balanceMinor,
  });

  factory MoneyAccount.fromJson(Map<String, dynamic> json) => MoneyAccount(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? 'Account',
        last4: json['last4'] as String?,
        accountType: json['accountType'] as String? ?? 'BANK',
        isSavings: json['isSavings'] as bool? ?? false,
        balanceMinor: _intOrNull(json['balanceMinor']),
      );
}

/// What there is to spend: bank and cash, the savings account left out.
class MoneyOnHand {
  final List<MoneyAccount> accounts;
  final int onHandMinor;
  final int inBankMinor;
  final int? cashMinor;
  final int? savingsMinor;

  /// How many accounts have no starting balance yet, and so are not in the sum.
  final int untracked;

  MoneyOnHand({
    this.accounts = const [],
    this.onHandMinor = 0,
    this.inBankMinor = 0,
    this.cashMinor,
    this.savingsMinor,
    this.untracked = 0,
  });

  factory MoneyOnHand.fromJson(Map<String, dynamic> json) => MoneyOnHand(
        accounts: (json['accounts'] as List<dynamic>? ?? [])
            .map((a) => MoneyAccount.fromJson(a as Map<String, dynamic>))
            .toList(),
        onHandMinor: _int(json['onHandMinor']),
        inBankMinor: _int(json['inBankMinor']),
        cashMinor: _intOrNull(json['cashMinor']),
        savingsMinor: _intOrNull(json['savingsMinor']),
        untracked: _int(json['untracked']),
      );
}

/// Money received for a purchase still to come, and how much is left of it.
class EarmarkItem {
  final String id;
  final String? merchant;
  final String? note;
  final DateTime? occurredAt;
  final int amountMinor;
  final int spentMinor;
  final int leftMinor;

  EarmarkItem({
    required this.id,
    this.merchant,
    this.note,
    this.occurredAt,
    required this.amountMinor,
    required this.spentMinor,
    required this.leftMinor,
  });

  /// What to call it: the note says what it is for, so it comes first.
  String get label {
    final n = note?.trim() ?? '';
    if (n.isNotEmpty) return n;
    final m = merchant?.trim() ?? '';
    return m.isNotEmpty ? m : 'Money set aside';
  }

  factory EarmarkItem.fromJson(Map<String, dynamic> json) => EarmarkItem(
        id: json['id'] as String? ?? '',
        merchant: json['merchant'] as String?,
        note: json['note'] as String?,
        occurredAt: _date(json['occurredAt']),
        amountMinor: _int(json['amountMinor']),
        spentMinor: _int(json['spentMinor']),
        leftMinor: _int(json['leftMinor']),
      );
}

class Earmarks {
  final int count;
  final int totalMinor;
  final List<EarmarkItem> items;

  Earmarks({this.count = 0, this.totalMinor = 0, this.items = const []});

  factory Earmarks.fromJson(Map<String, dynamic> json) => Earmarks(
        count: _int(json['count']),
        totalMinor: _int(json['totalMinor']),
        items: (json['items'] as List<dynamic>? ?? [])
            .map((i) => EarmarkItem.fromJson(i as Map<String, dynamic>))
            .toList(),
      );
}

/// One rule of the savings plan, and how this month is going against it.
class PlanRule {
  final String text;
  final String? category;
  final int? monthlyCapMinor;
  final int? spentMinor;
  final int? expectedSoFarMinor;

  /// ok | watch | over
  final String state;

  PlanRule({
    required this.text,
    this.category,
    this.monthlyCapMinor,
    this.spentMinor,
    this.expectedSoFarMinor,
    this.state = 'ok',
  });

  factory PlanRule.fromJson(Map<String, dynamic> json) => PlanRule(
        text: json['text'] as String? ?? '',
        category: json['category'] as String?,
        monthlyCapMinor: _intOrNull(json['monthlyCapMinor']),
        spentMinor: _intOrNull(json['spentMinor']),
        expectedSoFarMinor: _intOrNull(json['expectedSoFarMinor']),
        state: json['state'] as String? ?? 'ok',
      );
}

/// The AI-written savings plan.
class SavingsPlan {
  final String summary;
  final int? monthlyTargetMinor;
  final String? model;
  final DateTime? updatedAt;
  final String monthFrom;
  final String monthTo;
  final List<PlanRule> rules;
  final List<PlanRule> warnings;

  SavingsPlan({
    required this.summary,
    this.monthlyTargetMinor,
    this.model,
    this.updatedAt,
    this.monthFrom = '',
    this.monthTo = '',
    this.rules = const [],
    this.warnings = const [],
  });

  factory SavingsPlan.fromJson(Map<String, dynamic> json) {
    final month = json['month'] as Map<String, dynamic>? ?? {};
    List<PlanRule> rules(Object? list) =>
        (list as List<dynamic>? ?? []).map((r) => PlanRule.fromJson(r as Map<String, dynamic>)).toList();
    return SavingsPlan(
      summary: json['summary'] as String? ?? '',
      monthlyTargetMinor: _intOrNull(json['monthlyTargetMinor']),
      model: json['model'] as String?,
      updatedAt: _date(json['updatedAt']),
      monthFrom: month['from'] as String? ?? '',
      monthTo: month['to'] as String? ?? '',
      rules: rules(json['rules']),
      warnings: rules(json['warnings']),
    );
  }
}

/// The day's AI read of the spending, as markdown.
class AiInsight {
  final String day;
  final String text;
  final String? model;
  final DateTime? updatedAt;

  AiInsight({required this.day, required this.text, this.model, this.updatedAt});

  factory AiInsight.fromJson(Map<String, dynamic> json) => AiInsight(
        day: json['day'] as String? ?? '',
        text: json['text'] as String? ?? '',
        model: json['model'] as String?,
        updatedAt: _date(json['updatedAt']),
      );
}

/// One day of `/analytics/daily`.
class DaySpend {
  final String day;
  final int spendMinor;
  final int incomeMinor;

  DaySpend({required this.day, required this.spendMinor, required this.incomeMinor});

  factory DaySpend.fromJson(Map<String, dynamic> json) => DaySpend(
        day: json['day'] as String? ?? '',
        spendMinor: _int(json['spendMinor']),
        incomeMinor: _int(json['incomeMinor']),
      );
}

/// One weekday of `/analytics/weekday`.
class WeekdaySpend {
  final String day;
  final int amountMinor;
  final int count;
  final int averageMinor;

  WeekdaySpend({required this.day, required this.amountMinor, required this.count, required this.averageMinor});

  factory WeekdaySpend.fromJson(Map<String, dynamic> json) => WeekdaySpend(
        day: json['day'] as String? ?? '',
        amountMinor: _int(json['amountMinor']),
        count: _int(json['count']),
        averageMinor: _int(json['averageMinor']),
      );
}

/// One account of `/analytics/accounts`. accountId is "cash" for cash.
class AccountSpend {
  final String accountId;
  final String name;
  final String accountType;
  final int amountMinor;
  final int count;

  AccountSpend({
    required this.accountId,
    required this.name,
    required this.accountType,
    required this.amountMinor,
    required this.count,
  });

  factory AccountSpend.fromJson(Map<String, dynamic> json) => AccountSpend(
        accountId: json['accountId'] as String? ?? '',
        name: json['name'] as String? ?? 'Account',
        accountType: json['accountType'] as String? ?? '',
        amountMinor: _int(json['amountMinor']),
        count: _int(json['count']),
      );
}

/// An account someone else spends from - a child without UPI of their own,
/// say - on a monthly limit that is topped back up on the same day each
/// month.
class PocketMoney {
  final String holder;
  final int limitMinor;

  /// Day of the month (1-31) the limit renews and the top-up is due.
  final int renewDay;

  PocketMoney({required this.holder, required this.limitMinor, required this.renewDay});

  static PocketMoney? maybe(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    return PocketMoney(
      holder: json['holder'] as String? ?? 'Pocket money',
      limitMinor: _int(json['limitMinor']),
      renewDay: _int(json['renewDay']).clamp(1, 31),
    );
  }

  Map<String, dynamic> toJson() => {'holder': holder, 'limitMinor': limitMinor, 'renewDay': renewDay};
}

/// Where a pocket-money account stands this month, as the accounts page
/// and Home both show it. accountId and name are only set on Home's copy.
class PocketStatus {
  final String accountId;
  final String name;
  final String holder;
  final int limitMinor;
  final int renewDay;
  // Plain YYYY-MM-DD days in IST, kept as strings so no time zone can move
  // the day they name.
  final String from;
  final String to;
  final String renewsOn;
  final int spentMinor;
  final int leftMinor;
  final int transactionCount;

  /// What the month just ended used - what has to go back in on renewal day.
  final int lastMonthSpentMinor;

  /// Money already put in since this month began.
  final int toppedUpMinor;
  final bool renewsToday;

  PocketStatus({
    this.accountId = '',
    this.name = '',
    required this.holder,
    required this.limitMinor,
    required this.renewDay,
    this.from = '',
    this.to = '',
    this.renewsOn = '',
    required this.spentMinor,
    required this.leftMinor,
    this.transactionCount = 0,
    this.lastMonthSpentMinor = 0,
    this.toppedUpMinor = 0,
    this.renewsToday = false,
  });

  /// Renewal day with nothing put in yet, and something to put back.
  bool get topUpDue => renewsToday && toppedUpMinor <= 0 && lastMonthSpentMinor > 0;

  bool get over => limitMinor > 0 && spentMinor > limitMinor;

  factory PocketStatus.fromJson(Map<String, dynamic> json) => PocketStatus(
        accountId: json['accountId'] as String? ?? '',
        name: json['name'] as String? ?? '',
        holder: json['holder'] as String? ?? 'Pocket money',
        limitMinor: _int(json['limitMinor']),
        renewDay: _int(json['renewDay']).clamp(1, 31),
        from: json['from'] as String? ?? '',
        to: json['to'] as String? ?? '',
        renewsOn: json['renewsOn'] as String? ?? '',
        spentMinor: _int(json['spentMinor']),
        leftMinor: _int(json['leftMinor']),
        transactionCount: _int(json['transactionCount']),
        lastMonthSpentMinor: _int(json['lastMonthSpentMinor']),
        toppedUpMinor: _int(json['toppedUpMinor']),
        renewsToday: json['renewsToday'] as bool? ?? false,
      );
}
