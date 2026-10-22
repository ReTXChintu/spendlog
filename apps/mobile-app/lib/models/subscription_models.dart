/// Subscriptions as the server sends them (GET /subscriptions and friends):
/// each one with what is worked out from it - its monthly equivalent, the
/// days to its next renewal, what needs saying about it - the totals, and
/// the repeating charges that look like subscriptions nobody is tracking.
///
/// Parsed defensively: a field an older server leaves out reads as its
/// quiet default rather than throwing.
library;

int _int(Object? value) => value is int ? value : value is num ? value.round() : 0;
int? _intOrNull(Object? value) => value is num ? value.round() : null;
String? _str(Object? value) => value is String && value.isNotEmpty ? value : null;

const subscriptionUnits = ['day', 'week', 'month', 'year'];
const subscriptionPayMethods = ['card', 'upi', 'bank', 'wallet', 'cash'];

/// Something a subscription needs saying about: a renewal that never came
/// (`missed`), one due with nothing found yet (`overdue`), a charge at a
/// new price (`price`), or a trial about to turn into a charge
/// (`trial_ending`).
class SubscriptionAlert {
  final String kind;
  final String? dueOn;
  final String? on;
  final int amountMinor;
  final int fromMinor;
  final int toMinor;

  const SubscriptionAlert({
    required this.kind,
    this.dueOn,
    this.on,
    this.amountMinor = 0,
    this.fromMinor = 0,
    this.toMinor = 0,
  });

  factory SubscriptionAlert.fromJson(Map<String, dynamic> json) => SubscriptionAlert(
        kind: json['kind'] as String? ?? 'missed',
        dueOn: _str(json['dueOn']),
        on: _str(json['on']),
        amountMinor: _int(json['amountMinor']),
        fromMinor: _int(json['fromMinor']),
        toMinor: _int(json['toMinor']),
      );
}

/// One renewal that has come due, and what became of it.
class SubscriptionRenewal {
  final String dueOn;

  /// paid, missed or skipped.
  final String status;
  final String? transactionId;
  final int? amountMinor;
  final String? paidOn;

  const SubscriptionRenewal({
    required this.dueOn,
    required this.status,
    this.transactionId,
    this.amountMinor,
    this.paidOn,
  });

  factory SubscriptionRenewal.fromJson(Map<String, dynamic> json) => SubscriptionRenewal(
        dueOn: json['dueOn'] as String? ?? '',
        status: json['status'] as String? ?? 'missed',
        transactionId: _str(json['transactionId']),
        amountMinor: _intOrNull(json['amountMinor']),
        paidOn: _str(json['paidOn']),
      );
}

class SubscriptionPrice {
  final int amountMinor;
  final String fromOn;
  const SubscriptionPrice({required this.amountMinor, required this.fromOn});

  factory SubscriptionPrice.fromJson(Map<String, dynamic> json) =>
      SubscriptionPrice(amountMinor: _int(json['amountMinor']), fromOn: json['fromOn'] as String? ?? '');
}

class SubscriptionShare {
  final String contactId;
  final int amountMinor;
  const SubscriptionShare({required this.contactId, required this.amountMinor});

  factory SubscriptionShare.fromJson(Map<String, dynamic> json) =>
      SubscriptionShare(contactId: json['contactId'] as String? ?? '', amountMinor: _int(json['amountMinor']));

  Map<String, dynamic> toJson() => {'contactId': contactId, 'amountMinor': amountMinor};
}

/// The account a subscription is paid from, as much of it as the list needs.
class SubscriptionAccount {
  final String id;
  final String bankName;
  final String? last4;
  final String? nickname;
  final String accountType;

  const SubscriptionAccount({
    required this.id,
    required this.bankName,
    this.last4,
    this.nickname,
    required this.accountType,
  });

  factory SubscriptionAccount.fromJson(Map<String, dynamic> json) => SubscriptionAccount(
        id: json['id'] as String? ?? '',
        bankName: json['bankName'] as String? ?? '',
        last4: _str(json['last4']),
        nickname: _str(json['nickname']),
        accountType: json['accountType'] as String? ?? 'BANK',
      );

  /// "HDFC ••1234", or the nickname when there is one.
  String get label => '${nickname ?? bankName}${last4 != null ? ' ••$last4' : ''}';
}

class Subscription {
  final String id;
  final String name;
  final int amountMinor;
  final String currency;
  final int every;
  final String unit;

  /// "Monthly", "Every 3 months", "Yearly".
  final String frequencyLabel;

  /// weekly, monthly, quarterly, half-yearly, yearly or custom.
  final String frequencyPreset;
  final int monthlyMinor;
  final int yearlyMinor;
  final String nextRenewalOn;

  /// From today; negative once it is past.
  final int daysToRenewal;
  final String startedOn;
  final String? trialEndsOn;
  final String? payMethod;
  final String? accountId;
  final SubscriptionAccount? account;
  final String? categoryId;
  final String? categoryName;
  final String? notes;

  /// active, trial, paused or cancelled.
  final String status;
  final String? pausedOn;
  final String? cancelledOn;
  final List<SubscriptionPrice> priceHistory;
  final List<SubscriptionShare> sharedWith;
  final int myShareMinor;
  final int remindDaysBefore;
  final List<SubscriptionRenewal> renewals;
  final SubscriptionRenewal? lastPaid;
  final List<SubscriptionAlert> alerts;

  const Subscription({
    required this.id,
    required this.name,
    required this.amountMinor,
    this.currency = 'INR',
    this.every = 1,
    this.unit = 'month',
    this.frequencyLabel = 'Monthly',
    this.frequencyPreset = 'monthly',
    this.monthlyMinor = 0,
    this.yearlyMinor = 0,
    required this.nextRenewalOn,
    this.daysToRenewal = 0,
    this.startedOn = '',
    this.trialEndsOn,
    this.payMethod,
    this.accountId,
    this.account,
    this.categoryId,
    this.categoryName,
    this.notes,
    this.status = 'active',
    this.pausedOn,
    this.cancelledOn,
    this.priceHistory = const [],
    this.sharedWith = const [],
    this.myShareMinor = 0,
    this.remindDaysBefore = 2,
    this.renewals = const [],
    this.lastPaid,
    this.alerts = const [],
  });

  factory Subscription.fromJson(Map<String, dynamic> json) {
    final last = json['lastPaid'];
    return Subscription(
      id: json['id'] as String,
      name: json['name'] as String? ?? '',
      amountMinor: _int(json['amountMinor']),
      currency: json['currency'] as String? ?? 'INR',
      every: _int(json['every']) == 0 ? 1 : _int(json['every']),
      unit: json['unit'] as String? ?? 'month',
      frequencyLabel: json['frequencyLabel'] as String? ?? 'Monthly',
      frequencyPreset: json['frequencyPreset'] as String? ?? 'monthly',
      monthlyMinor: _int(json['monthlyMinor']),
      yearlyMinor: _int(json['yearlyMinor']),
      nextRenewalOn: json['nextRenewalOn'] as String? ?? '',
      daysToRenewal: _int(json['daysToRenewal']),
      startedOn: json['startedOn'] as String? ?? '',
      trialEndsOn: _str(json['trialEndsOn']),
      payMethod: _str(json['payMethod']),
      accountId: _str(json['accountId']),
      account: json['account'] is Map<String, dynamic> ? SubscriptionAccount.fromJson(json['account'] as Map<String, dynamic>) : null,
      categoryId: _str(json['categoryId']),
      categoryName: _str(json['categoryName']),
      notes: _str(json['notes']),
      status: json['status'] as String? ?? 'active',
      pausedOn: _str(json['pausedOn']),
      cancelledOn: _str(json['cancelledOn']),
      priceHistory: (json['priceHistory'] as List<dynamic>? ?? [])
          .map((p) => SubscriptionPrice.fromJson(p as Map<String, dynamic>))
          .toList(),
      sharedWith: (json['sharedWith'] as List<dynamic>? ?? [])
          .map((s) => SubscriptionShare.fromJson(s as Map<String, dynamic>))
          .toList(),
      myShareMinor: _int(json['myShareMinor']),
      remindDaysBefore: json['remindDaysBefore'] is num ? _int(json['remindDaysBefore']) : 2,
      renewals: (json['renewals'] as List<dynamic>? ?? [])
          .map((r) => SubscriptionRenewal.fromJson(r as Map<String, dynamic>))
          .toList(),
      lastPaid: last is Map<String, dynamic>
          ? SubscriptionRenewal(dueOn: last['on'] as String? ?? '', status: 'paid', paidOn: _str(last['on']), amountMinor: _intOrNull(last['amountMinor']))
          : null,
      alerts: (json['alerts'] as List<dynamic>? ?? [])
          .map((a) => SubscriptionAlert.fromJson(a as Map<String, dynamic>))
          .toList(),
    );
  }

  /// Running: active or on trial. Paused and cancelled ones sit still.
  bool get isLive => status == 'active' || status == 'trial';
  bool get isShared => sharedWith.isNotEmpty;

  /// How it is paid, in words: the account, or the method when no account is picked.
  String? get paidWithLabel {
    if (account != null) return account!.label;
    return switch (payMethod) {
      'card' => 'Card',
      'upi' => 'UPI autopay',
      'bank' => 'Bank',
      'wallet' => 'Wallet',
      'cash' => 'Cash',
      _ => null,
    };
  }
}

/// What the lot comes to, and what renews inside the user's month.
class SubscriptionTotals {
  final int activeCount;
  final int monthlyMinor;
  final int yearlyMinor;
  final String monthKey;
  final String monthFrom;
  final String monthTo;
  final String monthLabel;
  final int dueThisMonthMinor;
  final int dueThisMonthCount;
  final int paidThisMonthMinor;
  final int upcomingThisMonthMinor;
  final int alertCount;

  const SubscriptionTotals({
    this.activeCount = 0,
    this.monthlyMinor = 0,
    this.yearlyMinor = 0,
    this.monthKey = '',
    this.monthFrom = '',
    this.monthTo = '',
    this.monthLabel = '',
    this.dueThisMonthMinor = 0,
    this.dueThisMonthCount = 0,
    this.paidThisMonthMinor = 0,
    this.upcomingThisMonthMinor = 0,
    this.alertCount = 0,
  });

  factory SubscriptionTotals.fromJson(Map<String, dynamic>? json) {
    if (json == null) return const SubscriptionTotals();
    final month = json['month'] as Map<String, dynamic>? ?? const {};
    return SubscriptionTotals(
      activeCount: _int(json['activeCount']),
      monthlyMinor: _int(json['monthlyMinor']),
      yearlyMinor: _int(json['yearlyMinor']),
      monthKey: month['key'] as String? ?? '',
      monthFrom: month['from'] as String? ?? '',
      monthTo: month['to'] as String? ?? '',
      monthLabel: month['label'] as String? ?? '',
      dueThisMonthMinor: _int(json['dueThisMonthMinor']),
      dueThisMonthCount: _int(json['dueThisMonthCount']),
      paidThisMonthMinor: _int(json['paidThisMonthMinor']),
      upcomingThisMonthMinor: _int(json['upcomingThisMonthMinor']),
      alertCount: _int(json['alertCount']),
    );
  }

  bool get isEmpty => activeCount == 0 && monthlyMinor == 0;
}

/// A repeating charge that looks like a subscription nobody is tracking.
class SubscriptionSuggestion {
  final String key;
  final String merchant;
  final int amountMinor;
  final int every;
  final String unit;
  final String label;
  final int monthlyMinor;
  final int count;
  final String firstOn;
  final String lastOn;
  final String nextOn;
  final String? accountId;
  final String? categoryId;

  const SubscriptionSuggestion({
    required this.key,
    required this.merchant,
    required this.amountMinor,
    this.every = 1,
    this.unit = 'month',
    this.label = 'Monthly',
    this.monthlyMinor = 0,
    this.count = 0,
    this.firstOn = '',
    this.lastOn = '',
    required this.nextOn,
    this.accountId,
    this.categoryId,
  });

  factory SubscriptionSuggestion.fromJson(Map<String, dynamic> json) => SubscriptionSuggestion(
        key: json['key'] as String? ?? '',
        merchant: json['merchant'] as String? ?? '',
        amountMinor: _int(json['amountMinor']),
        every: _int(json['every']) == 0 ? 1 : _int(json['every']),
        unit: json['unit'] as String? ?? 'month',
        label: json['label'] as String? ?? 'Monthly',
        monthlyMinor: _int(json['monthlyMinor']),
        count: _int(json['count']),
        firstOn: json['firstOn'] as String? ?? '',
        lastOn: json['lastOn'] as String? ?? '',
        nextOn: json['nextOn'] as String? ?? '',
        accountId: _str(json['accountId']),
        categoryId: _str(json['categoryId']),
      );

  /// "NETFLIX.COM" as a name: "Netflix.com" is still ugly, so the first
  /// word, in title case, with a trailing ".com" and the like dropped.
  String get suggestedName {
    final cleaned = merchant.replaceAll(RegExp(r'\.(com|in|co|io|net)\b', caseSensitive: false), '').trim();
    final word = cleaned.split(RegExp(r'[\s*_\-/]+')).firstWhere((w) => w.isNotEmpty, orElse: () => cleaned);
    if (word.isEmpty) return merchant;
    final lower = word.toLowerCase();
    return '${lower[0].toUpperCase()}${lower.substring(1)}';
  }
}

/// GET /subscriptions.
class SubscriptionsPage {
  final List<Subscription> items;
  final SubscriptionTotals totals;
  final List<SubscriptionSuggestion> suggestions;

  const SubscriptionsPage({this.items = const [], this.totals = const SubscriptionTotals(), this.suggestions = const []});

  factory SubscriptionsPage.fromJson(Map<String, dynamic> json) => SubscriptionsPage(
        items: (json['items'] as List<dynamic>? ?? []).map((s) => Subscription.fromJson(s as Map<String, dynamic>)).toList(),
        totals: SubscriptionTotals.fromJson(json['totals'] as Map<String, dynamic>?),
        suggestions: (json['suggestions'] as List<dynamic>? ?? [])
            .map((s) => SubscriptionSuggestion.fromJson(s as Map<String, dynamic>))
            .toList(),
      );
}

/// One renewal on the calendar: settled or still to come.
class CalendarRenewal {
  final String on;

  /// paid, missed, skipped or upcoming.
  final String status;
  final int amountMinor;
  final String subscriptionId;
  final String name;

  const CalendarRenewal({
    required this.on,
    required this.status,
    required this.amountMinor,
    required this.subscriptionId,
    required this.name,
  });

  factory CalendarRenewal.fromJson(Map<String, dynamic> json) => CalendarRenewal(
        on: json['on'] as String? ?? '',
        status: json['status'] as String? ?? 'upcoming',
        amountMinor: _int(json['amountMinor']),
        subscriptionId: json['subscriptionId'] as String? ?? '',
        name: json['name'] as String? ?? '',
      );
}

/// The standard frequency choices the form offers, as (preset, every, unit, label).
const frequencyPresets = [
  ('weekly', 1, 'week', 'Weekly'),
  ('monthly', 1, 'month', 'Monthly'),
  ('quarterly', 3, 'month', 'Quarterly'),
  ('half-yearly', 6, 'month', 'Half-yearly'),
  ('yearly', 1, 'year', 'Yearly'),
];

/// A frequency in words, the way the server says it.
String frequencyWords(int every, String unit) {
  if (every == 1) {
    return switch (unit) {
      'day' => 'Daily',
      'week' => 'Weekly',
      'year' => 'Yearly',
      _ => 'Monthly',
    };
  }
  if (unit == 'month' && every == 3) return 'Quarterly';
  if (unit == 'month' && every == 6) return 'Half-yearly';
  if (unit == 'month' && every == 12) return 'Yearly';
  return 'Every $every ${unit}s';
}
