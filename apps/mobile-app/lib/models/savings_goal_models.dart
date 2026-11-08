/// Small things being saved up for - a PS5 by next October - with the
/// money kept in a savings account and marked against the goal. Separate
/// from the mutual-fund goals on Investments.
library;

int _int(Object? value) => value is int ? value : (value is num ? value.round() : 0);
double _double(Object? value) => value is num ? value.toDouble() : 0;
String? _str(Object? value) => value is String && value.isNotEmpty ? value : null;

class SavingsGoal {
  final String id;
  final String name;
  final int targetMinor;

  /// YYYY-MM-DD.
  final String targetOn;
  final String? accountId;

  /// "SBI ••1234": where the money is kept.
  final String? accountLabel;

  /// False once bought or given up.
  final bool isActive;
  final int savedMinor;
  final int leftMinor;
  final int monthsLeft;

  /// What to put aside each month from here to get there on time.
  final int perMonthMinor;
  final double percent;
  final bool isDone;
  final int addedThisMonthMinor;

  const SavingsGoal({
    required this.id,
    required this.name,
    this.targetMinor = 0,
    this.targetOn = '',
    this.accountId,
    this.accountLabel,
    this.isActive = true,
    this.savedMinor = 0,
    this.leftMinor = 0,
    this.monthsLeft = 1,
    this.perMonthMinor = 0,
    this.percent = 0,
    this.isDone = false,
    this.addedThisMonthMinor = 0,
  });

  factory SavingsGoal.fromJson(Map<String, dynamic> json) => SavingsGoal(
        id: _str(json['id']) ?? '',
        name: _str(json['name']) ?? 'Goal',
        targetMinor: _int(json['targetMinor']),
        targetOn: _str(json['targetOn']) ?? '',
        accountId: _str(json['accountId']),
        accountLabel: _str(json['accountLabel']),
        isActive: json['isActive'] != false,
        savedMinor: _int(json['savedMinor']),
        leftMinor: _int(json['leftMinor']),
        monthsLeft: _int(json['monthsLeft']) < 1 ? 1 : _int(json['monthsLeft']),
        perMonthMinor: _int(json['perMonthMinor']),
        percent: _double(json['percent']),
        isDone: json['isDone'] == true,
        addedThisMonthMinor: _int(json['addedThisMonthMinor']),
      );
}

class SavingsGoalList {
  final List<SavingsGoal> goals;

  /// The open ones together.
  final int savedMinor;
  final int perMonthMinor;

  const SavingsGoalList({this.goals = const [], this.savedMinor = 0, this.perMonthMinor = 0});

  bool get isEmpty => goals.isEmpty;
  List<SavingsGoal> get open => goals.where((goal) => goal.isActive).toList();
  List<SavingsGoal> get closed => goals.where((goal) => !goal.isActive).toList();

  factory SavingsGoalList.fromJson(Map<String, dynamic>? json) => json == null
      ? const SavingsGoalList()
      : SavingsGoalList(
          goals: (json['goals'] as List<dynamic>? ?? const [])
              .whereType<Map<String, dynamic>>()
              .map(SavingsGoal.fromJson)
              .where((goal) => goal.id.isNotEmpty)
              .toList(),
          savedMinor: _int(json['savedMinor']),
          perMonthMinor: _int(json['perMonthMinor']),
        );
}

/// One thing that went into a goal, or came out of it.
class GoalEntry {
  /// TRANSFER (a transaction marked for it) or BY_HAND.
  final String kind;
  final String? transactionId;
  final String label;
  final DateTime? on;

  /// Negative when taken out.
  final int amountMinor;

  const GoalEntry({required this.kind, this.transactionId, this.label = '', this.on, this.amountMinor = 0});

  bool get isTransfer => kind == 'TRANSFER';

  factory GoalEntry.fromJson(Map<String, dynamic> json) => GoalEntry(
        kind: _str(json['kind']) ?? 'BY_HAND',
        transactionId: _str(json['transactionId']),
        label: _str(json['label']) ?? '',
        on: DateTime.tryParse(_str(json['on']) ?? '')?.toLocal(),
        amountMinor: _int(json['amountMinor']),
      );
}
