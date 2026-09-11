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

/// A spelling of an account that a bank uses in one of its message formats.
class AccountAlias {
  final String bankName;
  final String? last4;
  final String accountType;

  AccountAlias({required this.bankName, this.last4, required this.accountType});

  factory AccountAlias.fromJson(Map<String, dynamic> json) => AccountAlias(
        bankName: json['bankName'] as String,
        last4: json['last4'] as String?,
        accountType: json['accountType'] as String,
      );

  Map<String, dynamic> toJson() => {
        'bankName': bankName,
        'last4': last4,
        'accountType': accountType,
      };
}

class Account {
  final String id;
  final String bankName;
  final String? last4;
  final String accountType;
  final String? nickname;
  final List<AccountAlias> aliases;
  final String? issuer;
  final String? cardNetwork;
  final int? creditLimitMinor;
  final int? statementDay;
  final int? dueDay;
  final bool isActive;

  Account({
    required this.id,
    required this.bankName,
    this.last4,
    required this.accountType,
    this.nickname,
    this.aliases = const [],
    this.issuer,
    this.cardNetwork,
    this.creditLimitMinor,
    this.statementDay,
    this.dueDay,
    this.isActive = true,
  });

  /// What to call it on screen: the name given to it, else the bank's own.
  String get label {
    final name = (nickname?.trim().isNotEmpty ?? false) ? nickname!.trim() : bankName;
    return last4 != null ? '$name ••$last4' : name;
  }

  factory Account.fromJson(Map<String, dynamic> json) => Account(
        id: json['id'] as String,
        bankName: json['bankName'] as String,
        last4: json['last4'] as String?,
        accountType: json['accountType'] as String,
        nickname: json['nickname'] as String?,
        aliases: (json['aliases'] as List<dynamic>? ?? [])
            .map((a) => AccountAlias.fromJson(a as Map<String, dynamic>))
            .toList(),
        issuer: json['issuer'] as String?,
        cardNetwork: json['cardNetwork'] as String?,
        creditLimitMinor: json['creditLimitMinor'] as int?,
        statementDay: json['statementDay'] as int?,
        dueDay: json['dueDay'] as int?,
        isActive: json['isActive'] as bool? ?? true,
      );
}

/// One message that reported a transaction.
class TransactionSourceEntry {
  final String source;
  final String? sourceRef;
  final String? rawText;
  final DateTime receivedAt;

  TransactionSourceEntry({
    required this.source,
    this.sourceRef,
    this.rawText,
    required this.receivedAt,
  });

  factory TransactionSourceEntry.fromJson(Map<String, dynamic> json) => TransactionSourceEntry(
        source: json['source'] as String,
        sourceRef: json['sourceRef'] as String?,
        rawText: json['rawText'] as String?,
        receivedAt: DateTime.parse(json['receivedAt'] as String),
      );
}

/// The part of a shared bill that was actually the user's own spending.
class TransactionSplit {
  final int myShareMinor;
  final String? groupLabel;

  TransactionSplit({required this.myShareMinor, this.groupLabel});

  factory TransactionSplit.fromJson(Map<String, dynamic> json) => TransactionSplit(
        myShareMinor: json['myShareMinor'] as int,
        groupLabel: json['groupLabel'] as String?,
      );
}

/// Part of a credit, attributed to the purchase it gives money back from.
class RefundAllocation {
  final String transactionId;
  final int amountMinor;

  RefundAllocation({required this.transactionId, required this.amountMinor});

  factory RefundAllocation.fromJson(Map<String, dynamic> json) => RefundAllocation(
        transactionId: json['transactionId'] as String,
        amountMinor: json['amountMinor'] as int,
      );
}

class Transaction {
  final String id;
  final int amountMinor;
  final String currency;
  final String type; // DEBIT | CREDIT
  final String? merchant;
  final String? note;
  /// The SMS or email this was parsed from, shown on demand so figures the
  /// user never typed can be checked.
  final String? rawText;
  final String source; // SMS | EMAIL | MANUAL
  /// On a credit: how much of it belongs to which earlier purchases. One
  /// credit often settles several cancelled orders at once.
  final List<RefundAllocation> refundOf;
  /// On a purchase: how much of it has since come back.
  final int refundedMinor;
  final String? emiPlanId;
  /// "PARENT" on the purchase converted to an EMI, "INSTALMENT" on each
  /// monthly payment.
  final String? emiRole;
  final bool isTransfer;
  final TransactionSplit? split;
  final bool isSettlement;
  final bool pending;
  final DateTime occurredAt;
  /// Set when a person corrected the transaction by hand, so the list can
  /// say so rather than implying the figures came straight from the bank.
  final DateTime? editedAt;
  /// Every message that reported this transaction, oldest first.
  final List<TransactionSourceEntry> sources;
  final Category? category;
  final Account? account;

  Transaction({
    required this.id,
    required this.amountMinor,
    required this.currency,
    required this.type,
    this.merchant,
    this.note,
    this.rawText,
    required this.source,
    this.refundOf = const [],
    this.refundedMinor = 0,
    this.emiPlanId,
    this.emiRole,
    required this.isTransfer,
    this.split,
    this.isSettlement = false,
    required this.pending,
    required this.occurredAt,
    this.editedAt,
    this.sources = const [],
    this.category,
    this.account,
  });

  /// The distinct kinds of message behind this row. Older rows predate the
  /// per-message list, so fall back to the single source they carry.
  List<String> get sourceKinds {
    if (sources.isEmpty) return [source];
    final seen = <String>[];
    for (final entry in sources) {
      if (!seen.contains(entry.source)) seen.add(entry.source);
    }
    return seen;
  }

  bool get wasReportedTwice => sources.length > 1;

  /// What a refunded purchase actually cost: the tax and fees that never
  /// came back.
  int get lostMinor => refundedMinor > 0 ? (amountMinor - refundedMinor).clamp(0, amountMinor) : 0;

  factory Transaction.fromJson(Map<String, dynamic> json) => Transaction(
        id: json['id'] as String,
        amountMinor: json['amountMinor'] as int,
        currency: json['currency'] as String? ?? 'INR',
        type: json['type'] as String,
        merchant: json['merchant'] as String?,
        note: json['note'] as String?,
        rawText: json['rawText'] as String?,
        source: json['source'] as String,
        refundOf: (json['refundOf'] as List<dynamic>? ?? [])
            .map((a) => RefundAllocation.fromJson(a as Map<String, dynamic>))
            .toList(),
        refundedMinor: json['refundedMinor'] as int? ?? 0,
        emiPlanId: json['emiPlanId'] as String?,
        emiRole: json['emiRole'] as String?,
        isTransfer: json['isTransfer'] as bool? ?? false,
        split: json['split'] != null
            ? TransactionSplit.fromJson(json['split'] as Map<String, dynamic>)
            : null,
        isSettlement: json['isSettlement'] as bool? ?? false,
        pending: json['pending'] as bool? ?? false,
        occurredAt: DateTime.parse(json['occurredAt'] as String),
        editedAt: json['editedAt'] != null ? DateTime.parse(json['editedAt'] as String) : null,
        sources: (json['sources'] as List<dynamic>? ?? [])
            .map((s) => TransactionSourceEntry.fromJson(s as Map<String, dynamic>))
            .toList(),
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

/// The running balance with everyone the user splits bills with.
class OwedSummary {
  final int balanceMinor;
  final int lentMinor;
  final int settledInMinor;
  final int settledOutMinor;
  final int splitCount;

  OwedSummary({
    required this.balanceMinor,
    required this.lentMinor,
    required this.settledInMinor,
    required this.settledOutMinor,
    required this.splitCount,
  });

  factory OwedSummary.fromJson(Map<String, dynamic> json) => OwedSummary(
        balanceMinor: json['balanceMinor'] as int? ?? 0,
        lentMinor: json['lentMinor'] as int? ?? 0,
        settledInMinor: json['settledInMinor'] as int? ?? 0,
        settledOutMinor: json['settledOutMinor'] as int? ?? 0,
        splitCount: json['splitCount'] as int? ?? 0,
      );
}

class EmiPlan {
  final String id;
  final String? label;
  final int principalMinor;
  final int months;
  final int monthlyAmountMinor;
  final int totalPayableMinor;
  final int paidCount;
  final int remainingMinor;
  final String status;

  EmiPlan({
    required this.id,
    this.label,
    required this.principalMinor,
    required this.months,
    required this.monthlyAmountMinor,
    required this.totalPayableMinor,
    required this.paidCount,
    required this.remainingMinor,
    required this.status,
  });

  factory EmiPlan.fromJson(Map<String, dynamic> json) => EmiPlan(
        id: json['id'] as String,
        label: json['label'] as String?,
        principalMinor: json['principalMinor'] as int,
        months: json['months'] as int,
        monthlyAmountMinor: json['monthlyAmountMinor'] as int,
        totalPayableMinor: json['totalPayableMinor'] as int,
        paidCount: json['paidCount'] as int? ?? 0,
        remainingMinor: json['remainingMinor'] as int? ?? 0,
        status: json['status'] as String? ?? 'ACTIVE',
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
