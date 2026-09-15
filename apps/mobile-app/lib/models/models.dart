import '../utils/format.dart';

class Category {
  final String id;
  final String name;
  final String? icon;
  final String? color;

  /// IN | OUT | BOTH - which way money has to be moving for this to make
  /// sense. BOTH by default, so a category someone adds is never quietly
  /// hidden from the picker they added it for.
  final String direction;
  final bool isSystem;

  Category({
    required this.id,
    required this.name,
    this.icon,
    this.color,
    this.direction = 'BOTH',
    required this.isSystem,
  });

  factory Category.fromJson(Map<String, dynamic> json) => Category(
        id: json['id'] as String,
        name: json['name'] as String,
        icon: json['icon'] as String?,
        color: json['color'] as String?,
        direction: json['direction'] as String? ?? 'BOTH',
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

  /// For a debit card, the bank account it draws on. A debit card is a
  /// way of reaching an account rather than a pot of its own, so its
  /// spending belongs to that account.
  final String? linkedAccountId;
  final int? creditLimitMinor;
  final int? spendLimitMinor;
  final int? statementDay;
  final int? dueDay;
  final bool isActive;

  /// Whether a statement password is stored. The value itself never
  /// leaves the server, so this is all a client can know about it.
  final bool hasStatementPassword;

  Account({
    required this.id,
    required this.bankName,
    this.last4,
    required this.accountType,
    this.nickname,
    this.aliases = const [],
    this.issuer,
    this.cardNetwork,
    this.linkedAccountId,
    this.creditLimitMinor,
    this.spendLimitMinor,
    this.statementDay,
    this.dueDay,
    this.isActive = true,
    this.hasStatementPassword = false,
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
        linkedAccountId: json['linkedAccountId'] as String?,
        creditLimitMinor: json['creditLimitMinor'] as int?,
        spendLimitMinor: json['spendLimitMinor'] as int?,
        statementDay: json['statementDay'] as int?,
        dueDay: json['dueDay'] as int?,
        isActive: json['isActive'] as bool? ?? true,
        hasStatementPassword: json['hasStatementPassword'] as bool? ?? false,
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
  /// Who this belongs to — the payer, on a shared trip.
  final String? userId;
  /// The trip this was spent on, if any.
  final String? tripId;
  final String? tripName;
  /// Who a trip expense was for. null means everyone on the trip.
  final List<String>? tripShareWith;
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

  /// Marked by hand: the credit that opens a spending period.
  final bool isSalary;

  /// The card whose bill this settled. Counts as nothing when set.
  final String? cardPaymentFor;

  /// The fixed monthly cost this went towards. Still counts as spending.
  final String? commitmentId;
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
    this.userId,
    this.tripId,
    this.tripName,
    this.tripShareWith,
    this.refundOf = const [],
    this.refundedMinor = 0,
    this.emiPlanId,
    this.emiRole,
    required this.isTransfer,
    this.isSalary = false,
    this.cardPaymentFor,
    this.commitmentId,
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
        userId: json['userId'] is String ? json['userId'] as String : null,
        tripId: json['tripId'] as String?,
        tripShareWith: (json['tripShareWith'] as List<dynamic>?)?.cast<String>(),
        tripName: (json['trip'] as Map<String, dynamic>?)?['name'] as String?,
        refundOf: (json['refundOf'] as List<dynamic>? ?? [])
            .map((a) => RefundAllocation.fromJson(a as Map<String, dynamic>))
            .toList(),
        refundedMinor: json['refundedMinor'] as int? ?? 0,
        emiPlanId: json['emiPlanId'] as String?,
        emiRole: json['emiRole'] as String?,
        isTransfer: json['isTransfer'] as bool? ?? false,
        isSalary: json['isSalary'] as bool? ?? false,
        cardPaymentFor: json['cardPaymentFor'] as String?,
        commitmentId: json['commitmentId'] as String?,
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

/// A shortcut for entering a payment by hand: a name and its usual category.
class MerchantPreset {
  final String id;
  final String merchant;
  final String? categoryId;
  final Category? category;

  MerchantPreset({required this.id, required this.merchant, this.categoryId, this.category});

  factory MerchantPreset.fromJson(Map<String, dynamic> json) => MerchantPreset(
        id: json['id'] as String,
        merchant: json['merchant'] as String,
        categoryId: json['categoryId'] as String?,
        category: json['category'] != null
            ? Category.fromJson(json['category'] as Map<String, dynamic>)
            : null,
      );
}

/// A card, with where it is in its cycle and what is left of its limit.
class CardStatus {
  final String accountId;
  final String name;
  final String? last4;
  /// RUPAY | VISA | MASTERCARD | AMEX | DINERS, or null when never set.
  /// Matters at a till rather than in the ledger: a RuPay credit card pays
  /// over UPI and a Visa one does not.
  final String? network;
  final DateTime? statementOn;
  final DateTime? dueOn;
  final int? floatDays;
  final int spentMinor;

  /// What you allow yourself on this card in a period, and what the bank
  /// allows. Different things: being 90% through your own limit matters at
  /// a till, and being 30% through a credit limit tells you nothing.
  final int? limitMinor;
  final int? creditLimitMinor;
  final int? remainingMinor;

  /// Whether spentMinor covers a billing cycle or a calendar month. A card
  /// with no statement day has no cycle to measure.
  final bool periodIsCycle;

  /// "ok" | "close" | "over" | "unset"
  final String state;

  CardStatus({
    required this.accountId,
    required this.name,
    this.last4,
    this.network,
    this.statementOn,
    this.dueOn,
    this.floatDays,
    required this.spentMinor,
    this.limitMinor,
    this.creditLimitMinor,
    this.remainingMinor,
    this.periodIsCycle = true,
    required this.state,
  });

  factory CardStatus.fromJson(Map<String, dynamic> json) => CardStatus(
        accountId: json['accountId'] as String,
        name: json['name'] as String,
        last4: json['last4'] as String?,
        network: json['network'] as String?,
        statementOn:
            json['statementOn'] != null ? DateTime.parse(json['statementOn'] as String) : null,
        dueOn: json['dueOn'] != null ? DateTime.parse(json['dueOn'] as String) : null,
        floatDays: json['floatDays'] as int?,
        spentMinor: json['spentMinor'] as int? ?? 0,
        limitMinor: json['limitMinor'] as int?,
        creditLimitMinor: json['creditLimitMinor'] as int?,
        remainingMinor: json['remainingMinor'] as int?,
        periodIsCycle: json['periodIsCycle'] as bool? ?? true,
        state: json['state'] as String? ?? 'unset',
      );
}

class FixedCommitment {
  final String id;
  final String name;
  final int amountMinor;
  final int dayOfMonth;
  final bool isPaid;

  /// What has actually gone out towards it this period, and what is left.
  final int paidMinor;
  final int shortfallMinor;

  /// Part of it sent and part not - the case worth a sentence rather than
  /// an unticked box.
  final bool isPartial;

  /// Who it goes to and what it counts as, prefilled onto a payment
  /// marked against it. A fixed cost is the same merchant and the same
  /// category every month.
  final String? merchant;
  final String? categoryId;
  final String? categoryName;

  FixedCommitment({
    required this.id,
    required this.name,
    required this.amountMinor,
    required this.dayOfMonth,
    required this.isPaid,
    this.paidMinor = 0,
    this.shortfallMinor = 0,
    this.isPartial = false,
    this.merchant,
    this.categoryId,
    this.categoryName,
  });

  factory FixedCommitment.fromJson(Map<String, dynamic> json) => FixedCommitment(
        id: json['id'] as String,
        name: json['name'] as String,
        amountMinor: json['amountMinor'] as int,
        dayOfMonth: json['dayOfMonth'] as int,
        isPaid: json['isPaid'] as bool? ?? false,
        paidMinor: json['paidMinor'] as int? ?? 0,
        shortfallMinor: json['shortfallMinor'] as int? ?? 0,
        isPartial: json['isPartial'] as bool? ?? false,
        merchant: json['merchant'] as String?,
        // Populated on the way out, so it arrives as the category itself
        // rather than an id - but a bare id after a save.
        categoryId: json['categoryId'] is Map<String, dynamic>
            ? (json['categoryId'] as Map<String, dynamic>)['id'] as String?
            : json['categoryId'] as String?,
        categoryName: json['categoryId'] is Map<String, dynamic>
            ? (json['categoryId'] as Map<String, dynamic>)['name'] as String?
            : null,
      );
}

/// The categories that make sense for money moving this way.
///
/// Sending money out is never income, and a refund is never a way of
/// spending, so offering either is offering a mistake. A category with no
/// direction recorded shows either way.
List<Category> categoriesFor(List<Category> categories, String type) {
  final refused = type == 'CREDIT' ? 'OUT' : 'IN';
  return categories.where((category) => category.direction != refused).toList();
}

/// How fast money is going out against how fast it can. A pace, not a
/// judgement about whether a bill can be paid — SpendLog has never known
/// an account balance.
class BudgetPace {
  final bool configured;
  final int daysLeft;
  final int salaryMinor;
  final int commitmentsRemainingMinor;
  final int spentMinor;
  final int remainingMinor;
  final int perDayMinor;
  final int recentPerDayMinor;
  /// "ok" | "watch" | "over"
  final String state;

  /// Whether salaryMinor is what actually landed, or the figure from the
  /// profile. Worth saying out loud: the two differ in any month with
  /// leave taken in it.
  final bool salaryIsActual;

  /// Set when a fixed cost went out for less than its usual amount.
  final String? shortfallNote;
  final List<FixedCommitment> commitments;

  BudgetPace({
    required this.configured,
    this.daysLeft = 0,
    this.salaryMinor = 0,
    this.commitmentsRemainingMinor = 0,
    this.spentMinor = 0,
    this.remainingMinor = 0,
    this.perDayMinor = 0,
    this.recentPerDayMinor = 0,
    this.state = 'ok',
    this.salaryIsActual = false,
    this.shortfallNote,
    this.commitments = const [],
  });

  factory BudgetPace.fromJson(Map<String, dynamic> json) {
    if (json['configured'] != true) return BudgetPace(configured: false);
    return BudgetPace(
      configured: true,
      daysLeft: json['daysLeft'] as int? ?? 0,
      salaryMinor: json['salaryMinor'] as int? ?? 0,
      commitmentsRemainingMinor: json['commitmentsRemainingMinor'] as int? ?? 0,
      spentMinor: json['spentMinor'] as int? ?? 0,
      remainingMinor: json['remainingMinor'] as int? ?? 0,
      perDayMinor: json['perDayMinor'] as int? ?? 0,
      recentPerDayMinor: json['recentPerDayMinor'] as int? ?? 0,
      state: json['state'] as String? ?? 'ok',
      salaryIsActual: json['salaryIsActual'] as bool? ?? false,
      shortfallNote: json['shortfallNote'] as String?,
      commitments: (json['commitments'] as List<dynamic>? ?? [])
          .map((c) => FixedCommitment.fromJson(c as Map<String, dynamic>))
          .toList(),
    );
  }
}

class Trip {
  final String id;
  final String name;
  final DateTime startedAt;
  final DateTime? endedAt;
  final String joinCode;
  final bool isActive;
  final int totalMinor;
  final int transactionCount;

  Trip({
    required this.id,
    required this.name,
    required this.startedAt,
    this.endedAt,
    required this.joinCode,
    required this.isActive,
    this.totalMinor = 0,
    this.transactionCount = 0,
  });

  factory Trip.fromJson(Map<String, dynamic> json) => Trip(
        id: json['id'] as String,
        name: json['name'] as String,
        startedAt: DateTime.parse(json['startedAt'] as String),
        endedAt: json['endedAt'] != null ? DateTime.parse(json['endedAt'] as String) : null,
        joinCode: json['joinCode'] as String? ?? '',
        isActive: json['isActive'] as bool? ?? (json['endedAt'] == null),
        totalMinor: json['totalMinor'] as int? ?? 0,
        transactionCount: json['transactionCount'] as int? ?? 0,
      );
}

class TripSummary {
  final Trip trip;
  final int totalMinor;
  final int transactionCount;
  final int dayCount;
  final int perDayMinor;
  final List<CategorySpend> byCategory;
  final List<TripMemberSpend> byMember;

  TripSummary({
    required this.trip,
    required this.totalMinor,
    required this.transactionCount,
    required this.dayCount,
    required this.perDayMinor,
    required this.byCategory,
    required this.byMember,
  });

  factory TripSummary.fromJson(Map<String, dynamic> json) => TripSummary(
        trip: Trip.fromJson(json['trip'] as Map<String, dynamic>),
        totalMinor: json['totalMinor'] as int? ?? 0,
        transactionCount: json['transactionCount'] as int? ?? 0,
        dayCount: json['dayCount'] as int? ?? 0,
        perDayMinor: json['perDayMinor'] as int? ?? 0,
        byCategory: (json['byCategory'] as List<dynamic>? ?? [])
            .map((c) => CategorySpend.fromJson(c as Map<String, dynamic>))
            .toList(),
        byMember: (json['byMember'] as List<dynamic>? ?? [])
            .map((m) => TripMemberSpend.fromJson(m as Map<String, dynamic>))
            .toList(),
      );
}

/// What one person on a trip paid for.
class TripMemberSpend {
  final String userId;
  final String name;
  final int spentMinor;

  TripMemberSpend({required this.userId, required this.name, required this.spentMinor});

  factory TripMemberSpend.fromJson(Map<String, dynamic> json) => TripMemberSpend(
        userId: json['userId'] as String,
        name: json['name'] as String? ?? 'Someone',
        spentMinor: json['spentMinor'] as int? ?? 0,
      );
}

/// Who owes whom at the end of a trip, and the payments that square it.
class TripSettlement {
  final List<TripBalance> balances;
  final List<TripTransfer> transfers;

  TripSettlement({required this.balances, required this.transfers});

  factory TripSettlement.fromJson(Map<String, dynamic> json) => TripSettlement(
        balances: (json['balances'] as List<dynamic>? ?? [])
            .map((b) => TripBalance.fromJson(b as Map<String, dynamic>))
            .toList(),
        transfers: (json['transfers'] as List<dynamic>? ?? [])
            .map((t) => TripTransfer.fromJson(t as Map<String, dynamic>))
            .toList(),
      );
}

class TripBalance {
  final String userId;
  final String name;
  final int paidMinor;
  final int netMinor;

  TripBalance({
    required this.userId,
    required this.name,
    required this.paidMinor,
    required this.netMinor,
  });

  factory TripBalance.fromJson(Map<String, dynamic> json) => TripBalance(
        userId: json['userId'] as String,
        name: json['name'] as String? ?? 'Someone',
        paidMinor: json['paidMinor'] as int? ?? 0,
        netMinor: json['netMinor'] as int? ?? 0,
      );
}

class TripTransfer {
  final String fromName;
  final String toName;
  final int amountMinor;

  TripTransfer({required this.fromName, required this.toName, required this.amountMinor});

  factory TripTransfer.fromJson(Map<String, dynamic> json) => TripTransfer(
        fromName: json['fromName'] as String? ?? 'Someone',
        toName: json['toName'] as String? ?? 'Someone',
        amountMinor: json['amountMinor'] as int? ?? 0,
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

/// What each network is called on screen.
const Map<String, String> networkLabels = {
  'RUPAY': 'RuPay',
  'VISA': 'Visa',
  'MASTERCARD': 'Mastercard',
  'AMEX': 'Amex',
  'DINERS': 'Diners',
};

/// Which card to reach for, one answer per network.
class CardPicks {
  final CardStatus? best;
  final List<({String network, CardStatus card})> byNetwork;
  final List<CardStatus> unknownNetwork;

  CardPicks({this.best, this.byNetwork = const [], this.unknownNetwork = const []});

  factory CardPicks.fromJson(Map<String, dynamic> json) => CardPicks(
        best: json['best'] != null ? CardStatus.fromJson(json['best'] as Map<String, dynamic>) : null,
        byNetwork: (json['byNetwork'] as List<dynamic>? ?? []).map((row) {
          final entry = row as Map<String, dynamic>;
          return (
            network: entry['network'] as String,
            card: CardStatus.fromJson(entry['card'] as Map<String, dynamic>),
          );
        }).toList(),
        unknownNetwork: (json['unknownNetwork'] as List<dynamic>? ?? [])
            .map((card) => CardStatus.fromJson(card as Map<String, dynamic>))
            .toList(),
      );
}

/// Something that makes a purchase cheaper.
///
/// A card offer stands until the bank changes it; a coupon is spent once
/// and then gone. One class for both, because every lookup wants both.
class Perk {
  final String id;

  /// CARD_OFFER | COUPON
  final String kind;
  final String title;
  final String? accountId;
  final String? cardName;
  final List<String> merchants;
  final num? percent;
  final int? flatMinor;
  final int? maxDiscountMinor;
  final int? minSpendMinor;
  final DateTime? expiresOn;
  final String? code;
  final DateTime? usedAt;
  final bool isActive;
  final String? notes;
  final bool isLive;
  final int? daysLeft;

  Perk({
    required this.id,
    required this.kind,
    required this.title,
    this.accountId,
    this.cardName,
    this.merchants = const [],
    this.percent,
    this.flatMinor,
    this.maxDiscountMinor,
    this.minSpendMinor,
    this.expiresOn,
    this.code,
    this.usedAt,
    this.isActive = true,
    this.notes,
    this.isLive = true,
    this.daysLeft,
  });

  bool get isCoupon => kind == 'COUPON';

  /// What it is worth, in the words the small print uses.
  String get worth {
    if (flatMinor != null) return formatMoney(flatMinor!);
    if (percent != null) return '$percent%';
    return '';
  }

  factory Perk.fromJson(Map<String, dynamic> json) {
    // accountId arrives populated from the list and the lookup, and as a
    // bare id from a save. Both have to read back the same way.
    final account = json['accountId'];
    final nickname = account is Map<String, dynamic> ? account['nickname'] as String? : null;

    return Perk(
      id: json['id'] as String,
      kind: json['kind'] as String,
      title: json['title'] as String,
      accountId: account is Map<String, dynamic> ? account['id'] as String? : account as String?,
      cardName: account is Map<String, dynamic>
          ? ((nickname?.trim().isNotEmpty ?? false) ? nickname : account['bankName'] as String?)
          : null,
      merchants: (json['merchants'] as List<dynamic>? ?? []).map((m) => m as String).toList(),
      percent: json['percent'] as num?,
      flatMinor: json['flatMinor'] as int?,
      maxDiscountMinor: json['maxDiscountMinor'] as int?,
      minSpendMinor: json['minSpendMinor'] as int?,
      expiresOn: json['expiresOn'] != null ? DateTime.parse(json['expiresOn'] as String) : null,
      code: json['code'] as String?,
      usedAt: json['usedAt'] != null ? DateTime.parse(json['usedAt'] as String) : null,
      isActive: json['isActive'] as bool? ?? true,
      notes: json['notes'] as String?,
      isLive: json['isLive'] as bool? ?? true,
      daysLeft: json['daysLeft'] as int?,
    );
  }
}

/// A perk that applies where you are standing, and how it got there.
class PerkMatch extends Perk {
  /// MERCHANT | CATEGORY | ANYWHERE - most specific first.
  final String reach;

  /// Null until there is an amount to apply a percentage to.
  final int? valueMinor;
  final CardStatus? card;

  PerkMatch({
    required super.id,
    required super.kind,
    required super.title,
    required this.reach,
    this.valueMinor,
    this.card,
    super.merchants,
    super.percent,
    super.flatMinor,
    super.maxDiscountMinor,
    super.minSpendMinor,
    super.expiresOn,
    super.code,
    super.daysLeft,
  });

  factory PerkMatch.fromJson(Map<String, dynamic> json) {
    final base = Perk.fromJson(json);
    return PerkMatch(
      id: base.id,
      kind: base.kind,
      title: base.title,
      reach: json['reach'] as String? ?? 'ANYWHERE',
      valueMinor: json['valueMinor'] as int?,
      card: json['card'] != null ? CardStatus.fromJson(json['card'] as Map<String, dynamic>) : null,
      merchants: base.merchants,
      percent: base.percent,
      flatMinor: base.flatMinor,
      maxDiscountMinor: base.maxDiscountMinor,
      minSpendMinor: base.minSpendMinor,
      expiresOn: base.expiresOn,
      code: base.code,
      daysLeft: base.daysLeft,
    );
  }
}

/// The answer to "I am at Gucci - do I have anything?"
class PerkLookup {
  final String query;
  final List<PerkMatch> matches;

  /// Only set when it is a different card from the one the offer names:
  /// two pieces of advice naming one card reads as noise.
  final CardStatus? floatAlternative;
  final String verdict;

  PerkLookup({
    required this.query,
    required this.matches,
    this.floatAlternative,
    required this.verdict,
  });

  factory PerkLookup.fromJson(Map<String, dynamic> json) => PerkLookup(
        query: json['query'] as String? ?? '',
        matches: (json['matches'] as List<dynamic>? ?? [])
            .map((m) => PerkMatch.fromJson(m as Map<String, dynamic>))
            .toList(),
        floatAlternative: json['floatAlternative'] != null
            ? CardStatus.fromJson(json['floatAlternative'] as Map<String, dynamic>)
            : null,
        verdict: json['verdict'] as String? ?? '',
      );
}

class MerchantSpend {
  final String merchant;
  final int amountMinor;
  final int count;

  MerchantSpend({required this.merchant, required this.amountMinor, required this.count});

  factory MerchantSpend.fromJson(Map<String, dynamic> json) => MerchantSpend(
        merchant: json['merchant'] as String,
        amountMinor: json['amountMinor'] as int,
        count: json['count'] as int? ?? 0,
      );
}

class CategoryChange {
  final String? categoryId;
  final String name;
  final int amountMinor;
  final int previousMinor;
  final int changeMinor;

  CategoryChange({
    this.categoryId,
    required this.name,
    required this.amountMinor,
    required this.previousMinor,
    required this.changeMinor,
  });

  factory CategoryChange.fromJson(Map<String, dynamic> json) => CategoryChange(
        categoryId: json['categoryId'] as String?,
        name: json['name'] as String,
        amountMinor: json['amountMinor'] as int? ?? 0,
        previousMinor: json['previousMinor'] as int? ?? 0,
        changeMinor: json['changeMinor'] as int? ?? 0,
      );
}

class MonthComparison {
  final String previousMonthLabel;
  final int totalSpendMinor;
  final int previousSpendMinor;
  final int changeMinor;
  final List<CategoryChange> categories;

  MonthComparison({
    required this.previousMonthLabel,
    required this.totalSpendMinor,
    required this.previousSpendMinor,
    required this.changeMinor,
    required this.categories,
  });

  factory MonthComparison.fromJson(Map<String, dynamic> json) => MonthComparison(
        previousMonthLabel: json['previousMonthLabel'] as String? ?? '',
        totalSpendMinor: json['totalSpendMinor'] as int? ?? 0,
        previousSpendMinor: json['previousSpendMinor'] as int? ?? 0,
        changeMinor: json['changeMinor'] as int? ?? 0,
        categories: (json['categories'] as List<dynamic>? ?? [])
            .map((c) => CategoryChange.fromJson(c as Map<String, dynamic>))
            .toList(),
      );
}

/// This month so far, against the same point in the last one.
///
/// Day-for-day rather than month-for-month: on the 8th, a whole previous
/// month is not a comparison, it is a number three times larger.
class MonthSoFar {
  final int dayOfMonth;
  final int spentMinor;
  final int previousMinor;
  final int changeMinor;

  MonthSoFar({
    required this.dayOfMonth,
    required this.spentMinor,
    required this.previousMinor,
    required this.changeMinor,
  });

  factory MonthSoFar.fromJson(Map<String, dynamic> json) => MonthSoFar(
        dayOfMonth: json['dayOfMonth'] as int? ?? 1,
        spentMinor: json['spentMinor'] as int? ?? 0,
        previousMinor: json['previousMinor'] as int? ?? 0,
        changeMinor: json['changeMinor'] as int? ?? 0,
      );
}

class StuckStatement {
  final String id;
  final String status;
  final String? problem;

  StuckStatement({required this.id, required this.status, this.problem});

  factory StuckStatement.fromJson(Map<String, dynamic> json) => StuckStatement(
        id: json['id'] as String,
        status: json['status'] as String,
        problem: json['problem'] as String?,
      );
}

/// A card bill that has been read from a statement and not yet paid.
///
/// A statement is the first moment the app can know what a bill actually
/// is, rather than estimating it from the transactions it happened to see.
class UpcomingBill {
  final String statementId;
  final String cardName;
  final int totalDueMinor;

  /// Negative once the due date has gone past.
  final int? daysUntilDue;

  UpcomingBill({
    required this.statementId,
    required this.cardName,
    required this.totalDueMinor,
    this.daysUntilDue,
  });

  factory UpcomingBill.fromJson(Map<String, dynamic> json) => UpcomingBill(
        statementId: json['statementId'] as String,
        cardName: json['cardName'] as String? ?? 'A card',
        totalDueMinor: json['totalDueMinor'] as int? ?? 0,
        daysUntilDue: json['daysUntilDue'] as int?,
      );

  String get whenDue {
    final days = daysUntilDue;
    if (days == null) return '';
    if (days < 0) return ' - ${days.abs()} days overdue';
    if (days == 0) return ' - due today';
    return ' - due in $days days';
  }
}

/// Everything the landing screen needs, in one request.
class DashboardData {
  final BudgetPace pace;
  final List<CardStatus> cards;
  final CardPicks picks;
  final int needsCategoryYesterday;
  final int needsCategoryMonth;
  final int emiCount;
  final int emiMonthlyMinor;
  final int emiRemainingMinor;
  final int owedBalanceMinor;
  final List<Perk> expiringPerks;
  final List<StuckStatement> stuckStatements;
  final List<UpcomingBill> bills;
  final MonthSoFar monthSoFar;

  DashboardData({
    required this.pace,
    required this.cards,
    required this.picks,
    required this.needsCategoryYesterday,
    required this.needsCategoryMonth,
    required this.emiCount,
    required this.emiMonthlyMinor,
    required this.emiRemainingMinor,
    required this.owedBalanceMinor,
    required this.expiringPerks,
    required this.stuckStatements,
    required this.bills,
    required this.monthSoFar,
  });

  factory DashboardData.fromJson(Map<String, dynamic> json) {
    final needs = json['needsCategory'] as Map<String, dynamic>? ?? {};
    final emis = json['emis'] as Map<String, dynamic>? ?? {};
    final statements = json['statements'] as Map<String, dynamic>? ?? {};

    return DashboardData(
      pace: BudgetPace.fromJson(json['pace'] as Map<String, dynamic>? ?? {}),
      cards: (json['cards'] as List<dynamic>? ?? [])
          .map((card) => CardStatus.fromJson(card as Map<String, dynamic>))
          .toList(),
      picks: CardPicks.fromJson(json['picks'] as Map<String, dynamic>? ?? {}),
      needsCategoryYesterday: needs['yesterday'] as int? ?? 0,
      needsCategoryMonth: needs['month'] as int? ?? 0,
      emiCount: emis['count'] as int? ?? 0,
      emiMonthlyMinor: emis['monthlyMinor'] as int? ?? 0,
      emiRemainingMinor: emis['remainingMinor'] as int? ?? 0,
      owedBalanceMinor: (json['owed'] as Map<String, dynamic>? ?? {})['balanceMinor'] as int? ?? 0,
      expiringPerks: (json['expiringPerks'] as List<dynamic>? ?? [])
          .map((perk) => Perk.fromJson(perk as Map<String, dynamic>))
          .toList(),
      stuckStatements: (statements['stuck'] as List<dynamic>? ?? [])
          .map((s) => StuckStatement.fromJson(s as Map<String, dynamic>))
          .toList(),
      bills: (json['bills'] as List<dynamic>? ?? [])
          .map((bill) => UpcomingBill.fromJson(bill as Map<String, dynamic>))
          .toList(),
      monthSoFar: MonthSoFar.fromJson(json['monthSoFar'] as Map<String, dynamic>? ?? {}),
    );
  }
}
