import 'models.dart';

/// How far back a merchant figure reaches. A month is what every other
/// figure in Analytics covers; the longer windows answer the question only
/// merchants raise - "how much have I actually given this shop?" - which
/// one month cannot.
enum MerchantRange {
  month('month', 'This month'),
  threeMonths('3m', '3 months'),
  sixMonths('6m', '6 months'),
  year('12m', '12 months'),
  all('all', 'All time');

  const MerchantRange(this.key, this.label);

  /// What the server takes as `range`.
  final String key;

  /// What the chip says.
  final String label;
}

/// One of the user's months in a merchant's history, as a bar.
class MerchantMonth {
  final String month;
  final String label;
  final int amountMinor;
  final int count;

  const MerchantMonth({required this.month, required this.label, required this.amountMinor, required this.count});

  factory MerchantMonth.fromJson(Map<String, dynamic> json) => MerchantMonth(
        month: json['month'] as String? ?? '',
        label: json['label'] as String? ?? '',
        amountMinor: json['amountMinor'] as int? ?? 0,
        count: json['count'] as int? ?? 0,
      );
}

/// What a merchant was paid under one category - the same shop can be
/// groceries one week and a gift the next.
class MerchantCategory {
  final String? categoryId;
  final String name;
  final int amountMinor;
  final int count;

  const MerchantCategory({this.categoryId, required this.name, required this.amountMinor, required this.count});

  factory MerchantCategory.fromJson(Map<String, dynamic> json) => MerchantCategory(
        categoryId: json['categoryId'] as String?,
        name: json['name'] as String? ?? 'Uncategorized',
        amountMinor: json['amountMinor'] as int? ?? 0,
        count: json['count'] as int? ?? 0,
      );
}

/// One merchant up close: what they have had in all, how often, month by
/// month, and every payment behind the figure.
class MerchantDetail {
  final String merchant;

  /// The stretch these figures cover, in the server's own words -
  /// "Last 6 months", "All time", or a month's label.
  final String label;
  final int totalMinor;
  final int count;

  /// The average payment, not the average month: what "is this shop
  /// getting dearer?" actually asks.
  final int averageMinor;
  final DateTime? firstOn;
  final DateTime? lastOn;
  final List<MerchantMonth> byMonth;
  final List<MerchantCategory> byCategory;
  final List<Transaction> transactions;

  const MerchantDetail({
    required this.merchant,
    required this.label,
    required this.totalMinor,
    required this.count,
    required this.averageMinor,
    this.firstOn,
    this.lastOn,
    this.byMonth = const [],
    this.byCategory = const [],
    this.transactions = const [],
  });

  bool get isEmpty => count == 0;

  /// What a payment to them comes to in a month they were paid at all -
  /// an average over the quiet months would flatter a shop visited twice
  /// a year.
  int get perActiveMonthMinor {
    final active = byMonth.where((month) => month.amountMinor > 0).toList();
    if (active.isEmpty) return 0;
    return active.fold<int>(0, (sum, month) => sum + month.amountMinor) ~/ active.length;
  }

  static DateTime? _date(Object? value) => value is String ? DateTime.tryParse(value)?.toLocal() : null;

  factory MerchantDetail.fromJson(Map<String, dynamic> json) => MerchantDetail(
        merchant: json['merchant'] as String? ?? '',
        label: json['label'] as String? ?? '',
        totalMinor: json['totalMinor'] as int? ?? 0,
        count: json['count'] as int? ?? 0,
        averageMinor: json['averageMinor'] as int? ?? 0,
        firstOn: _date(json['firstOn']),
        lastOn: _date(json['lastOn']),
        byMonth: ((json['byMonth'] as List<dynamic>?) ?? const [])
            .map((month) => MerchantMonth.fromJson(month as Map<String, dynamic>))
            .toList(),
        byCategory: ((json['byCategory'] as List<dynamic>?) ?? const [])
            .map((category) => MerchantCategory.fromJson(category as Map<String, dynamic>))
            .toList(),
        transactions: ((json['transactions'] as List<dynamic>?) ?? const [])
            .map((row) => Transaction.fromJson(row as Map<String, dynamic>))
            .toList(),
      );
}
