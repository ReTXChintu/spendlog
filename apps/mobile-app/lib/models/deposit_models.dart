/// RDs and FDs as running totals: what each holds, what goes in a month,
/// and the payments that went in. No interest and no maturity date.
library;

int _int(Object? value) => value is int ? value : (value is num ? value.round() : 0);
int? _intOrNull(Object? value) => value is int ? value : (value is num ? value.round() : null);
String? _str(Object? value) => value is String && value.isNotEmpty ? value : null;

class Deposit {
  final String id;
  final String name;

  /// "RD" or "FD".
  final String kind;
  final String? institution;

  /// What goes in each month, on an RD.
  final int? monthlyMinor;
  final bool isActive;

  /// What it holds now: the figure last given plus what went in since.
  final int totalMinor;
  final int addedThisMonthMinor;
  final DateTime? lastAddedAt;

  const Deposit({
    required this.id,
    required this.name,
    this.kind = 'RD',
    this.institution,
    this.monthlyMinor,
    this.isActive = true,
    this.totalMinor = 0,
    this.addedThisMonthMinor = 0,
    this.lastAddedAt,
  });

  bool get isRd => kind == 'RD';

  /// "RD · Post office", or just the kind.
  String get subtitle => [kind, if (institution != null) institution!].join(' · ');

  factory Deposit.fromJson(Map<String, dynamic> json) => Deposit(
        id: _str(json['id']) ?? '',
        name: _str(json['name']) ?? 'Deposit',
        kind: _str(json['kind']) ?? 'RD',
        institution: _str(json['institution']),
        monthlyMinor: _intOrNull(json['monthlyMinor']),
        isActive: json['isActive'] != false,
        totalMinor: _int(json['totalMinor']),
        addedThisMonthMinor: _int(json['addedThisMonthMinor']),
        lastAddedAt: DateTime.tryParse(_str(json['lastAddedAt']) ?? '')?.toLocal(),
      );
}

class DepositList {
  final List<Deposit> deposits;

  /// The open ones together.
  final int totalMinor;
  final int monthlyMinor;

  const DepositList({this.deposits = const [], this.totalMinor = 0, this.monthlyMinor = 0});

  bool get isEmpty => deposits.isEmpty;
  List<Deposit> get active => deposits.where((d) => d.isActive).toList();

  factory DepositList.fromJson(Map<String, dynamic> json) => DepositList(
        deposits: (json['deposits'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(Deposit.fromJson)
            .where((d) => d.id.isNotEmpty)
            .toList(),
        totalMinor: _int(json['totalMinor']),
        monthlyMinor: _int(json['monthlyMinor']),
      );
}

/// One payment's part in a deposit.
class DepositPayment {
  final String transactionId;
  final String? merchant;
  final DateTime? occurredAt;
  final int amountMinor;

  /// The whole payment, when only part of it went in.
  final int paymentMinor;

  const DepositPayment({
    required this.transactionId,
    this.merchant,
    this.occurredAt,
    this.amountMinor = 0,
    this.paymentMinor = 0,
  });

  factory DepositPayment.fromJson(Map<String, dynamic> json) => DepositPayment(
        transactionId: _str(json['transactionId']) ?? '',
        merchant: _str(json['merchant']),
        occurredAt: DateTime.tryParse(_str(json['occurredAt']) ?? '')?.toLocal(),
        amountMinor: _int(json['amountMinor']),
        paymentMinor: _int(json['paymentMinor']),
      );
}
