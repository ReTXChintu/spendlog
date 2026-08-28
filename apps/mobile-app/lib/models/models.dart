class Category {
  final String id;
  final String name;
  final String? icon;
  final String? color;
  final bool isSystem;

  Category({required this.id, required this.name, this.icon, this.color, required this.isSystem});

  factory Category.fromJson(Map<String, dynamic> json) => Category(
        id: json['id'] as String,
        name: json['name'] as String,
        icon: json['icon'] as String?,
        color: json['color'] as String?,
        isSystem: json['isSystem'] as bool? ?? false,
      );
}

class Account {
  final String id;
  final String bankName;
  final String? last4;
  final String accountType;

  Account({required this.id, required this.bankName, this.last4, required this.accountType});

  factory Account.fromJson(Map<String, dynamic> json) => Account(
        id: json['id'] as String,
        bankName: json['bankName'] as String,
        last4: json['last4'] as String?,
        accountType: json['accountType'] as String,
      );
}

class Transaction {
  final String id;
  final int amountMinor;
  final String currency;
  final String type; // DEBIT | CREDIT
  final String? merchant;
  final String? note;
  final String source; // SMS | EMAIL | MANUAL
  final bool isTransfer;
  final bool pending;
  final DateTime occurredAt;
  final Category? category;
  final Account? account;

  Transaction({
    required this.id,
    required this.amountMinor,
    required this.currency,
    required this.type,
    this.merchant,
    this.note,
    required this.source,
    required this.isTransfer,
    required this.pending,
    required this.occurredAt,
    this.category,
    this.account,
  });

  factory Transaction.fromJson(Map<String, dynamic> json) => Transaction(
        id: json['id'] as String,
        amountMinor: json['amountMinor'] as int,
        currency: json['currency'] as String? ?? 'INR',
        type: json['type'] as String,
        merchant: json['merchant'] as String?,
        note: json['note'] as String?,
        source: json['source'] as String,
        isTransfer: json['isTransfer'] as bool? ?? false,
        pending: json['pending'] as bool? ?? false,
        occurredAt: DateTime.parse(json['occurredAt'] as String),
        category: json['category'] != null ? Category.fromJson(json['category'] as Map<String, dynamic>) : null,
        account: json['account'] != null ? Account.fromJson(json['account'] as Map<String, dynamic>) : null,
      );
}

class DayGroup {
  final String date;
  final int spendMinor;
  final int incomeMinor;
  final List<Transaction> transactions;

  DayGroup({required this.date, required this.spendMinor, required this.incomeMinor, required this.transactions});

  factory DayGroup.fromJson(Map<String, dynamic> json) => DayGroup(
        date: json['date'] as String,
        spendMinor: json['spendMinor'] as int,
        incomeMinor: json['incomeMinor'] as int,
        transactions: (json['transactions'] as List<dynamic>)
            .map((t) => Transaction.fromJson(t as Map<String, dynamic>))
            .toList(),
      );
}

class CategorySpend {
  final String? categoryId;
  final String name;
  final int amountMinor;

  CategorySpend({required this.categoryId, required this.name, required this.amountMinor});

  factory CategorySpend.fromJson(Map<String, dynamic> json) => CategorySpend(
        categoryId: json['categoryId'] as String?,
        name: json['name'] as String,
        amountMinor: json['amountMinor'] as int,
      );
}

class AnalyticsSummary {
  final String month;
  final int totalSpendMinor;
  final int totalIncomeMinor;
  final List<CategorySpend> byCategory;
  final int transactionCount;

  AnalyticsSummary({
    required this.month,
    required this.totalSpendMinor,
    required this.totalIncomeMinor,
    required this.byCategory,
    required this.transactionCount,
  });

  factory AnalyticsSummary.fromJson(Map<String, dynamic> json) => AnalyticsSummary(
        month: json['month'] as String,
        totalSpendMinor: json['totalSpendMinor'] as int,
        totalIncomeMinor: json['totalIncomeMinor'] as int,
        byCategory:
            (json['byCategory'] as List<dynamic>).map((c) => CategorySpend.fromJson(c as Map<String, dynamic>)).toList(),
        transactionCount: json['transactionCount'] as int,
      );
}

class EmailConnectionStatus {
  final String id;
  final String email;
  final DateTime? lastSyncedAt;

  EmailConnectionStatus({required this.id, required this.email, this.lastSyncedAt});

  factory EmailConnectionStatus.fromJson(Map<String, dynamic> json) => EmailConnectionStatus(
        id: json['id'] as String,
        email: json['email'] as String,
        lastSyncedAt: json['lastSyncedAt'] != null ? DateTime.parse(json['lastSyncedAt'] as String) : null,
      );
}
