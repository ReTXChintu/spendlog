import 'models.dart';

int _int(Object? value) => value is int ? value : (value is num ? value.round() : 0);

/// Who signed in, from `POST /kid/login`.
class KidLogin {
  final String token;
  final String id;
  final String name;
  final String email;

  KidLogin({required this.token, required this.id, required this.name, required this.email});

  factory KidLogin.fromJson(Map<String, dynamic> json) {
    final kid = json['kid'] as Map<String, dynamic>? ?? const {};
    return KidLogin(
      token: json['token'] as String,
      id: kid['id'] as String? ?? '',
      name: kid['name'] as String? ?? '',
      email: kid['email'] as String? ?? '',
    );
  }
}

/// One of the kid's pocket-money accounts with this month's standing.
class KidAccount {
  final String id;
  final String name;
  final String? last4;

  /// Null if the server could not work out this month's figures.
  final PocketStatus? pocket;

  KidAccount({required this.id, required this.name, this.last4, this.pocket});

  String get label => last4 != null ? '$name ••$last4' : name;

  factory KidAccount.fromJson(Map<String, dynamic> json) => KidAccount(
        id: json['id'] as String,
        name: json['name'] as String? ?? 'Pocket money',
        last4: json['last4'] as String?,
        pocket: json['pocket'] is Map<String, dynamic>
            ? PocketStatus.fromJson(json['pocket'] as Map<String, dynamic>)
            : null,
      );
}

/// `GET /kid/me`.
class KidProfile {
  final String id;
  final String name;
  final String parentName;
  final List<KidAccount> accounts;

  KidProfile({required this.id, required this.name, required this.parentName, required this.accounts});

  factory KidProfile.fromJson(Map<String, dynamic> json) => KidProfile(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        parentName: json['parentName'] as String? ?? '',
        accounts: (json['accounts'] as List<dynamic>? ?? [])
            .map((a) => KidAccount.fromJson(a as Map<String, dynamic>))
            .toList(),
      );
}

/// A page of `GET /kid/transactions`: days, newest first.
class KidTransactionPage {
  final List<DayGroup> days;
  final bool hasMore;
  final String? nextBefore;

  KidTransactionPage({required this.days, required this.hasMore, this.nextBefore});

  factory KidTransactionPage.fromJson(Map<String, dynamic> json) => KidTransactionPage(
        days: (json['days'] as List<dynamic>? ?? [])
            .map((d) => DayGroup.fromJson(d as Map<String, dynamic>))
            .toList(),
        hasMore: json['hasMore'] as bool? ?? false,
        nextBefore: json['nextBefore'] as String?,
      );
}

/// `GET /kid/analytics`: one month of the kid's own money.
class KidAnalytics {
  final String month;
  final String from;
  final String to;
  final String label;
  final int totalSpendMinor;
  final int totalInMinor;
  final int transactionCount;
  final List<CategorySpend> byCategory;
  final List<MerchantSpend> byMerchant;
  final List<DaySpend> daily;

  KidAnalytics({
    required this.month,
    required this.from,
    required this.to,
    required this.label,
    required this.totalSpendMinor,
    required this.totalInMinor,
    required this.transactionCount,
    required this.byCategory,
    required this.byMerchant,
    required this.daily,
  });

  factory KidAnalytics.fromJson(Map<String, dynamic> json) => KidAnalytics(
        month: json['month'] as String? ?? '',
        from: json['from'] as String? ?? '',
        to: json['to'] as String? ?? '',
        label: json['label'] as String? ?? '',
        totalSpendMinor: _int(json['totalSpendMinor']),
        totalInMinor: _int(json['totalInMinor']),
        transactionCount: _int(json['transactionCount']),
        byCategory: (json['byCategory'] as List<dynamic>? ?? [])
            .map((c) => CategorySpend.fromJson(c as Map<String, dynamic>))
            .toList(),
        byMerchant: (json['byMerchant'] as List<dynamic>? ?? [])
            .map((m) => MerchantSpend.fromJson(m as Map<String, dynamic>))
            .toList(),
        // The kid's daily rows carry no income; DaySpend reads it as 0.
        daily: (json['daily'] as List<dynamic>? ?? [])
            .map((d) => DaySpend.fromJson(d as Map<String, dynamic>))
            .toList(),
      );
}

/// What `POST /kid/refresh` did about waking the parent's phone.
class KidRefreshResult {
  final bool pinged;

  /// not-configured | no-device | too-soon, when nothing was sent.
  final String? reason;
  final DateTime? nextAllowedAt;

  KidRefreshResult({required this.pinged, this.reason, this.nextAllowedAt});

  factory KidRefreshResult.fromJson(Map<String, dynamic> json) => KidRefreshResult(
        pinged: json['pinged'] as bool? ?? false,
        reason: json['reason'] as String?,
        nextAllowedAt: json['nextAllowedAt'] is String ? DateTime.tryParse(json['nextAllowedAt'] as String) : null,
      );

  /// A quiet line to show, or null for nothing worth saying.
  String? get hint {
    if (pinged) return 'Asked the main phone to check for new messages';
    if (reason == 'too-soon') return 'Checked recently — try again in a few minutes';
    // not-configured / no-device: nothing a kid can do about it, so say nothing.
    return null;
  }
}
