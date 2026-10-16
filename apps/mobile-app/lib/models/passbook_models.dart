/// The passbook and everything that sets an account against the bank: the
/// ledger row by row with the bank's own figure beside each, where the two
/// first parted, what could explain it, the nightly alerts, and a
/// statement compared with the app.
///
/// Shaped as accounts.passbook.routes.ts, accounts.suspects.ts,
/// accounts.drift.ts and statements.compare.ts send them. Read
/// defensively throughout: a bank that never states a balance in its
/// SMS leaves every stated field null, and that is the normal case, not
/// an error. models.dart re-exports this file.
library;

int _int(Object? value) => value is int ? value : (value is num ? value.round() : 0);
int? _intOrNull(Object? value) => value is int ? value : (value is num ? value.round() : null);
String? _str(Object? value) => value is String && value.isNotEmpty ? value : null;
bool _bool(Object? value) => value is bool && value;
DateTime? _date(Object? value) => value is String && value.isNotEmpty ? DateTime.tryParse(value) : null;
Map<String, dynamic>? _mapOrNull(Object? value) => value is Map<String, dynamic> ? value : null;
List<Map<String, dynamic>> _maps(Object? value) =>
    value is List ? value.whereType<Map<String, dynamic>>().toList() : const [];
List<String> _strings(Object? value) => value is List ? value.whereType<String>().toList() : const [];

/// A rupee either way is rounding, not a drift. The same figure the server
/// uses (DRIFT_TOLERANCE_MINOR), so the colours here agree with its alerts.
const int kDriftToleranceMinor = 100;

/// Whether a gap is worth colouring red: past a rupee either way.
bool driftIsOff(int? driftMinor) => driftMinor != null && driftMinor.abs() > kDriftToleranceMinor;

/// How far the app is from the bank's latest figure, and since when. On a
/// wallet tile, a money row and the account overview.
class BalanceDrift {
  /// The bank's figure less the app's: negative means the app shows more.
  final int minor;
  final DateTime? since;
  final DateTime? statedAt;

  const BalanceDrift({required this.minor, this.since, this.statedAt});

  static BalanceDrift? maybe(Object? value) {
    final json = _mapOrNull(value);
    if (json == null) return null;
    final minor = _intOrNull(json['minor']);
    if (minor == null) return null;
    return BalanceDrift(minor: minor, since: _date(json['since']), statedAt: _date(json['statedAt']));
  }
}

/// The account a passbook is about, as its header names it.
class PassbookAccount {
  final String id;
  final String name;
  final String bankName;
  final String? last4;

  /// BANK | CASH
  final String accountType;

  /// The emergency fund, kept hidden behind a tap.
  final bool isSavings;

  /// This bank texts money out and never money in.
  final bool noCreditAlerts;

  /// The starting balance came from a fresh start, and the one before it
  /// can be put back.
  final bool canUndoFreshStart;

  const PassbookAccount({
    required this.id,
    required this.name,
    this.bankName = '',
    this.last4,
    this.accountType = 'BANK',
    this.isSavings = false,
    this.noCreditAlerts = false,
    this.canUndoFreshStart = false,
  });

  bool get isCash => accountType == 'CASH';

  /// "HDFC ••8342", or just the name.
  String get label => last4 == null ? name : '$name ••$last4';

  factory PassbookAccount.fromJson(Map<String, dynamic>? json) => PassbookAccount(
        id: _str(json?['id']) ?? '',
        name: _str(json?['name']) ?? _str(json?['bankName']) ?? 'Account',
        bankName: _str(json?['bankName']) ?? '',
        last4: _str(json?['last4']),
        accountType: _str(json?['accountType']) ?? 'BANK',
        isSavings: _bool(json?['isSavings']),
        noCreditAlerts: _bool(json?['noCreditAlerts']),
        canUndoFreshStart: _bool(json?['canUndoFreshStart']),
      );
}

/// A moment the bank's figure and the app's were both known.
class StatedPoint {
  final int seq;

  /// What the bank said.
  final int minor;
  final DateTime at;
  final String? transactionId;
  final String? checkpointId;

  /// What the app expected at that moment.
  final int expectedMinor;

  /// [minor] less [expectedMinor].
  final int driftMinor;

  const StatedPoint({
    required this.seq,
    required this.minor,
    required this.at,
    this.transactionId,
    this.checkpointId,
    required this.expectedMinor,
    required this.driftMinor,
  });

  bool get isOff => driftIsOff(driftMinor);

  static StatedPoint? maybe(Object? value) {
    final json = _mapOrNull(value);
    if (json == null) return null;
    final at = _date(json['at']);
    if (at == null) return null;
    return StatedPoint(
      seq: _int(json['seq']),
      minor: _int(json['minor']),
      at: at,
      transactionId: _str(json['transactionId']),
      checkpointId: _str(json['checkpointId']),
      expectedMinor: _int(json['expectedMinor']),
      driftMinor: _int(json['driftMinor']),
    );
  }
}

/// Where the app and the bank first parted: the earliest stated figure the
/// app was off from when the one before agreed.
class FirstDrift {
  final String? transactionId;
  final String? checkpointId;
  final DateTime on;
  final int driftMinor;
  final int seq;

  const FirstDrift({this.transactionId, this.checkpointId, required this.on, required this.driftMinor, required this.seq});

  static FirstDrift? maybe(Object? value) {
    final json = _mapOrNull(value);
    if (json == null) return null;
    final on = _date(json['on']);
    if (on == null) return null;
    return FirstDrift(
      transactionId: _str(json['transactionId']),
      checkpointId: _str(json['checkpointId']),
      on: on,
      driftMinor: _int(json['driftMinor']),
      seq: _int(json['seq']),
    );
  }
}

/// One line of the passbook.
class PassbookRow {
  /// Position in the account's history, oldest first; the opening row is 0.
  final int seq;

  /// txn | opening | adjustment | checkpoint | missing_credit
  final String kind;
  final DateTime on;
  final String? transactionId;
  final String? checkpointId;
  final String? merchant;

  /// DEBIT | CREDIT, as the money moved *this* account; null on the
  /// opening row and a checkpoint.
  final String? type;
  final int? amountMinor;

  /// What the app expects the account held after this row.
  final int runningMinor;

  /// What the bank said it held, from the SMS or the checkpoint.
  final int? statedMinor;

  /// stated less running, where there is a stated figure.
  final int? driftMinor;
  final String? countedReason;
  final String? source;
  final bool isTransfer;
  final String? transferAccountId;
  final bool accountUnknown;
  final bool needsExplanation;

  /// Written in by SpendLog for a transfer whose bank never texted this
  /// side, and not yet confirmed by a message.
  final bool autoLeg;
  final String? note;

  /// On a missing_credit row: which one, and when its window opened. The
  /// row stands at the end of the window.
  final String? missingCreditId;
  final DateTime? windowStart;

  const PassbookRow({
    required this.seq,
    required this.kind,
    required this.on,
    this.transactionId,
    this.checkpointId,
    this.merchant,
    this.type,
    this.amountMinor,
    required this.runningMinor,
    this.statedMinor,
    this.driftMinor,
    this.countedReason,
    this.source,
    this.isTransfer = false,
    this.transferAccountId,
    this.accountUnknown = false,
    this.needsExplanation = false,
    this.autoLeg = false,
    this.note,
    this.missingCreditId,
    this.windowStart,
  });

  bool get isOpening => kind == 'opening';
  bool get isCheckpoint => kind == 'checkpoint';
  bool get isAdjustment => kind == 'adjustment';
  bool get isTransaction => kind == 'txn' || kind == 'adjustment';

  /// Money the bank's figures say came in, not yet explained: provisional,
  /// counted in the running balance and nowhere else.
  bool get isMissingCredit => kind == 'missing_credit';
  bool get isDebit => type == 'DEBIT';

  /// A figure from the bank, and the app disagrees with it.
  bool get isOff => driftIsOff(driftMinor);

  /// The IST day this falls on, YYYY-MM-DD, for grouping.
  String get day => on.toUtc().add(const Duration(hours: 5, minutes: 30)).toIso8601String().substring(0, 10);

  factory PassbookRow.fromJson(Map<String, dynamic> json) => PassbookRow(
        seq: _int(json['seq']),
        kind: _str(json['kind']) ?? 'txn',
        on: _date(json['on']) ?? _date(json['at']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        transactionId: _str(json['transactionId']),
        checkpointId: _str(json['checkpointId']),
        merchant: _str(json['merchant']),
        type: _str(json['type']),
        amountMinor: _intOrNull(json['amountMinor']),
        runningMinor: _int(json['runningMinor']),
        statedMinor: _intOrNull(json['statedMinor']),
        driftMinor: _intOrNull(json['driftMinor']),
        countedReason: _str(json['countedReason']),
        source: _str(json['source']),
        isTransfer: _bool(json['isTransfer']),
        transferAccountId: _str(json['transferAccountId']),
        accountUnknown: _bool(json['accountUnknown']),
        needsExplanation: _bool(json['needsExplanation']),
        autoLeg: _bool(json['autoLeg']),
        note: _str(json['note']),
        missingCreditId: _str(json['missingCreditId']),
        windowStart: _date(json['windowStart']),
      );
}

/// One page of `GET /accounts/:id/passbook`, newest first.
class PassbookPage {
  final PassbookAccount account;
  final int openingMinor;
  final DateTime? openingAt;
  final int expectedNowMinor;

  /// Of [expectedNowMinor], money in nobody has explained yet.
  final int provisionalMinor;

  /// The bank's latest figure and how the app stood beside it. Null when
  /// the bank has never said one.
  final StatedPoint? lastStated;
  final FirstDrift? firstDrift;
  final int total;

  /// The cursor for the page before this one; null once the opening row
  /// is on screen.
  final int? nextBefore;
  final List<PassbookRow> rows;

  const PassbookPage({
    required this.account,
    this.openingMinor = 0,
    this.openingAt,
    this.expectedNowMinor = 0,
    this.provisionalMinor = 0,
    this.lastStated,
    this.firstDrift,
    this.total = 0,
    this.nextBefore,
    this.rows = const [],
  });

  bool get hasMore => nextBefore != null;

  /// The bank has never put a figure on this account.
  bool get neverStated => lastStated == null;

  factory PassbookPage.fromJson(Map<String, dynamic> json) => PassbookPage(
        account: PassbookAccount.fromJson(_mapOrNull(json['account'])),
        openingMinor: _int(json['openingMinor']),
        openingAt: _date(json['openingAt']),
        expectedNowMinor: _int(json['expectedNowMinor']),
        provisionalMinor: _int(json['provisionalMinor']),
        lastStated: StatedPoint.maybe(json['lastStated']),
        firstDrift: FirstDrift.maybe(json['firstDrift']),
        total: _int(json['total']),
        nextBefore: _intOrNull(json['nextBefore']),
        rows: _maps(json['rows']).map(PassbookRow.fromJson).toList(),
      );
}

/// A passbook refused: a debit card points at the account it spends from,
/// a credit card or an account with no starting balance has none.
class PassbookRefusal {
  final String error;

  /// The bank account to open instead, when this was a debit card.
  final String? accountId;

  const PassbookRefusal({required this.error, this.accountId});

  factory PassbookRefusal.fromJson(Map<String, dynamic> json) => PassbookRefusal(
        error: _str(json['error']) ?? 'This account has no passbook.',
        accountId: _str(json['accountId']),
      );
}

/// The one request that would put a suspect right, ready to send.
class SuspectFix {
  /// PATCH | POST
  final String method;
  final String path;
  final Map<String, dynamic> body;
  final String label;

  const SuspectFix({required this.method, required this.path, this.body = const {}, required this.label});

  static SuspectFix? maybe(Object? value) {
    final json = _mapOrNull(value);
    if (json == null) return null;
    final path = _str(json['path']);
    if (path == null) return null;
    return SuspectFix(
      method: (_str(json['method']) ?? 'PATCH').toUpperCase(),
      path: path,
      body: _mapOrNull(json['body']) ?? const {},
      label: _str(json['label']) ?? 'Apply',
    );
  }
}

/// Something near the drift that could account for it.
class Suspect {
  /// unknown_account | duplicate | one_sided_transfer | card_bill_on_card |
  /// missing_days | exact_match | missing_credit
  final String kind;
  final List<String> transactionIds;

  /// The money it accounts for, always positive.
  final int amountMinor;
  final String explanation;
  final DateTime? on;
  final DateTime? until;
  final SuspectFix? fix;

  const Suspect({
    required this.kind,
    this.transactionIds = const [],
    required this.amountMinor,
    required this.explanation,
    this.on,
    this.until,
    this.fix,
  });

  /// What kind of mistake this is, as a heading.
  String get title => switch (kind) {
        'unknown_account' => 'A payment with no account',
        'duplicate' => 'The same payment twice',
        'one_sided_transfer' => 'A transfer counted on both sides',
        'card_bill_on_card' => 'A card bill filed under the card',
        'missing_days' => 'Days with something missing',
        'exact_match' => 'One row that is exactly the gap',
        'missing_credit' => 'Money in without a text',
        _ => 'Worth a look',
      };

  /// What to do when there is no one-tap fix: where to look in the bank app.
  String get whatToCheck => switch (kind) {
        'missing_days' => 'Open the bank app and look at these days. Add whatever SpendLog does not have by hand.',
        'exact_match' => 'Check whether the bank shows this on the account. If not, delete it or move it to the right account.',
        'unknown_account' => 'Open each payment and set its account, or say it was cash.',
        'missing_credit' => "Add the credit by hand, or let the bank's statement for those days fill it in.",
        _ => 'Check the bank app for these days.',
      };

  factory Suspect.fromJson(Map<String, dynamic> json) => Suspect(
        kind: _str(json['kind']) ?? 'exact_match',
        transactionIds: _strings(json['transactionIds']),
        amountMinor: _int(json['amountMinor']),
        explanation: _str(json['explanation']) ?? '',
        on: _date(json['on']),
        until: _date(json['until']),
        fix: SuspectFix.maybe(json['fix']),
      );
}

/// `GET /accounts/:id/reconcile`: how far the account is from the bank,
/// and what could explain it, likeliest first.
class Reconcile {
  final PassbookAccount account;
  final int expectedMinor;
  final StatedPoint? lastStated;

  /// The bank's latest figure less the app's at that figure. Null when the
  /// bank has never said one.
  final int? differenceMinor;
  final FirstDrift? firstDrift;
  final List<Suspect> suspects;

  const Reconcile({
    required this.account,
    this.expectedMinor = 0,
    this.lastStated,
    this.differenceMinor,
    this.firstDrift,
    this.suspects = const [],
  });

  /// Within rounding of the bank, with a figure to be within rounding of.
  bool get settled => differenceMinor != null && !driftIsOff(differenceMinor);

  factory Reconcile.fromJson(Map<String, dynamic> json) => Reconcile(
        account: PassbookAccount.fromJson(_mapOrNull(json['account'])),
        expectedMinor: _int(json['expectedMinor']),
        lastStated: StatedPoint.maybe(json['lastStated']),
        differenceMinor: _intOrNull(json['differenceMinor']),
        firstDrift: FirstDrift.maybe(json['firstDrift']),
        suspects: _maps(json['suspects']).map(Suspect.fromJson).toList(),
      );
}

/// A figure the bank gave for the account, kept: `GET /accounts/:id/checkpoints`.
class BalanceCheckpoint {
  final String id;
  final DateTime on;
  final int balanceMinor;
  final String source;
  final String? note;

  const BalanceCheckpoint({required this.id, required this.on, required this.balanceMinor, this.source = 'MANUAL', this.note});

  factory BalanceCheckpoint.fromJson(Map<String, dynamic> json) => BalanceCheckpoint(
        id: _str(json['id']) ?? _str(json['_id']) ?? '',
        on: _date(json['on']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        balanceMinor: _int(json['balanceMinor']),
        source: _str(json['source']) ?? 'MANUAL',
        note: _str(json['note']),
      );
}

/// A night's finding that an account is off from the bank, not yet seen.
class BalanceAlert {
  final String id;
  final String accountId;
  final PassbookAccount? account;
  final int driftMinor;
  final int statedMinor;
  final int expectedMinor;
  final DateTime? statedAt;
  final DateTime? since;
  final String title;
  final String body;

  const BalanceAlert({
    required this.id,
    required this.accountId,
    this.account,
    required this.driftMinor,
    this.statedMinor = 0,
    this.expectedMinor = 0,
    this.statedAt,
    this.since,
    this.title = '',
    this.body = '',
  });

  factory BalanceAlert.fromJson(Map<String, dynamic> json) {
    final account = _mapOrNull(json['account']);
    return BalanceAlert(
      id: _str(json['id']) ?? '',
      accountId: _str(json['accountId']) ?? '',
      account: account == null ? null : PassbookAccount.fromJson({...account, 'id': json['accountId']}),
      driftMinor: _int(json['driftMinor']),
      statedMinor: _int(json['statedMinor']),
      expectedMinor: _int(json['expectedMinor']),
      statedAt: _date(json['statedAt']),
      since: _date(json['since']),
      title: _str(json['title']) ?? '',
      body: _str(json['body']) ?? '',
    );
  }
}

/// Something about the balances to do, from the dashboard's `todos`.
///
/// Five kinds, each carrying what its tap needs: an alert opens the
/// account's passbook, money that came in without a text opens "What came
/// in?", an unexplained difference opens that row, the payments with no
/// account open the ledger narrowed to them, and a statement due opens
/// that account's statements. One class rather than five so the dashboard
/// can list them in one loop; the fields a kind does not use are null.
class BalanceTodo {
  /// balance_alert | missing_credit | unexplained_difference |
  /// unknown_account | statement_due
  final String kind;
  final String title;
  final String body;

  /// balance_alert
  final String? alertId;
  final String? accountId;
  final int? driftMinor;
  final DateTime? since;

  /// unexplained_difference
  final String? transactionId;
  final int? amountMinor;
  final DateTime? on;

  /// unknown_account
  final int count;

  /// missing_credit: which one, its window and its likely answers.
  final String? missingCreditId;
  final DateTime? after;
  final DateTime? before;
  final List<MissingCreditSuggestion> suggestions;

  /// statement_due: the month whose statement is wanted, YYYY-MM.
  final String? month;

  const BalanceTodo({
    required this.kind,
    required this.title,
    required this.body,
    this.alertId,
    this.accountId,
    this.driftMinor,
    this.since,
    this.transactionId,
    this.amountMinor,
    this.on,
    this.count = 0,
    this.missingCreditId,
    this.after,
    this.before,
    this.suggestions = const [],
    this.month,
  });

  bool get isAlert => kind == 'balance_alert';
  bool get isUnexplained => kind == 'unexplained_difference';
  bool get isUnknownAccount => kind == 'unknown_account';
  bool get isMissingCredit => kind == 'missing_credit' && missingCreditId != null;
  bool get isStatementDue => kind == 'statement_due' && accountId != null && month != null;

  /// A kind this build knows how to open. Anything else is left off the
  /// list rather than shown as a row that does nothing.
  bool get isKnown => isAlert || isUnexplained || isUnknownAccount || isMissingCredit || isStatementDue;

  /// The missing credit this stands for, enough for "What came in?" to
  /// open without asking the server again.
  MissingCredit? get missingCredit => isMissingCredit
      ? MissingCredit(
          id: missingCreditId!,
          accountId: accountId ?? '',
          amountMinor: amountMinor ?? 0,
          after: after,
          before: before,
          title: title,
          suggestions: suggestions,
        )
      : null;

  factory BalanceTodo.fromJson(Map<String, dynamic> json) => BalanceTodo(
        kind: _str(json['kind']) ?? '',
        title: _str(json['title']) ?? '',
        body: _str(json['body']) ?? '',
        alertId: _str(json['alertId']),
        accountId: _str(json['accountId']),
        driftMinor: _intOrNull(json['driftMinor']),
        since: _date(json['since']),
        transactionId: _str(json['transactionId']),
        amountMinor: _intOrNull(json['amountMinor']),
        on: _date(json['on']),
        count: _int(json['count']),
        missingCreditId: _str(json['missingCreditId']),
        after: _date(json['after']),
        before: _date(json['before']),
        suggestions: _maps(json['suggestions']).map(MissingCreditSuggestion.fromJson).toList(),
        month: _str(json['month']),
      );
}

/// A likely answer to "what came in?", ready to send as it is.
class MissingCreditSuggestion {
  /// transfer | salary | refund | paid_back | income
  final String as;
  final String label;
  final String? fromAccountId;

  /// The row on the other account a transfer would pair with.
  final String? transactionId;
  final String? contactId;

  const MissingCreditSuggestion({
    required this.as,
    required this.label,
    this.fromAccountId,
    this.transactionId,
    this.contactId,
  });

  /// The body of `POST /accounts/missing-credits/:id/resolve`.
  Map<String, dynamic> toBody() => {
        'as': as,
        if (fromAccountId != null) 'fromAccountId': fromAccountId,
        if (contactId != null) 'contactId': contactId,
      };

  factory MissingCreditSuggestion.fromJson(Map<String, dynamic> json) => MissingCreditSuggestion(
        as: _str(json['as']) ?? 'income',
        label: _str(json['label']) ?? '',
        fromAccountId: _str(json['fromAccountId']),
        transactionId: _str(json['transactionId']),
        contactId: _str(json['contactId']),
      );
}

/// Money the bank's own figures say came into an account, with no message
/// saying so: `GET /accounts/missing-credits`. Not a transaction until the
/// user says what it was.
class MissingCredit {
  final String id;
  final String accountId;
  final PassbookAccount? account;
  final int amountMinor;

  /// The window it arrived in: after the first figure, by the second.
  final DateTime? after;
  final DateTime? before;

  /// open | resolved | dismissed
  final String status;
  final String title;
  final List<MissingCreditSuggestion> suggestions;

  const MissingCredit({
    required this.id,
    required this.accountId,
    this.account,
    required this.amountMinor,
    this.after,
    this.before,
    this.status = 'open',
    this.title = '',
    this.suggestions = const [],
  });

  bool get isOpen => status == 'open';

  factory MissingCredit.fromJson(Map<String, dynamic> json) {
    final account = _mapOrNull(json['account']);
    return MissingCredit(
      id: _str(json['id']) ?? '',
      accountId: _str(json['accountId']) ?? '',
      account: account == null ? null : PassbookAccount.fromJson({...account, 'id': json['accountId']}),
      amountMinor: _int(json['amountMinor']),
      after: _date(json['after']),
      before: _date(json['before']),
      status: _str(json['status']) ?? 'open',
      title: _str(json['title']) ?? '',
      suggestions: _maps(json['suggestions']).map(MissingCreditSuggestion.fromJson).toList(),
    );
  }
}

/// One account on the "Start fresh from today" screen: `GET
/// /accounts/start-fresh`.
class FreshStartAccount {
  final String accountId;
  final String name;
  final String? last4;

  /// BANK | CASH
  final String accountType;
  final bool isSavings;

  /// What SpendLog makes it now; null when it has no starting balance yet.
  final int? expectedMinor;
  final int provisionalMinor;

  /// The bank's latest figure, and whether it is from today - in which
  /// case it is what the bank shows now, and the screen fills it in.
  final int? lastStatedMinor;
  final DateTime? lastStatedAt;
  final bool statedToday;
  final bool canUndo;

  const FreshStartAccount({
    required this.accountId,
    required this.name,
    this.last4,
    this.accountType = 'BANK',
    this.isSavings = false,
    this.expectedMinor,
    this.provisionalMinor = 0,
    this.lastStatedMinor,
    this.lastStatedAt,
    this.statedToday = false,
    this.canUndo = false,
  });

  bool get isCash => accountType == 'CASH';
  String get label => last4 == null ? name : '$name ••$last4';

  /// The figure to start the input with: the bank's own, when it is today's.
  int? get prefillMinor => statedToday ? lastStatedMinor : null;

  factory FreshStartAccount.fromJson(Map<String, dynamic> json) {
    final stated = _mapOrNull(json['lastStated']);
    return FreshStartAccount(
      accountId: _str(json['accountId']) ?? '',
      name: _str(json['name']) ?? 'Account',
      last4: _str(json['last4']),
      accountType: _str(json['accountType']) ?? 'BANK',
      isSavings: _bool(json['isSavings']),
      expectedMinor: _intOrNull(json['expectedMinor']),
      provisionalMinor: _int(json['provisionalMinor']),
      lastStatedMinor: stated == null ? null : _intOrNull(stated['minor']),
      lastStatedAt: stated == null ? null : _date(stated['at']),
      statedToday: _bool(json['statedToday']),
      canUndo: _bool(json['canUndo']),
    );
  }
}

/// A statement line the app has no row for.
class CompareLine {
  final String lineId;
  final DateTime date;
  final String description;
  final int amountMinor;

  /// DEBIT | CREDIT
  final String type;
  final String kind;

  /// The row reconciling added for it, when it has.
  final String? addedTransactionId;

  const CompareLine({
    required this.lineId,
    required this.date,
    required this.description,
    required this.amountMinor,
    required this.type,
    this.kind = '',
    this.addedTransactionId,
  });

  bool get isDebit => type == 'DEBIT';

  factory CompareLine.fromJson(Map<String, dynamic> json) => CompareLine(
        lineId: _str(json['lineId']) ?? '',
        date: _date(json['date']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        description: _str(json['description']) ?? '',
        amountMinor: _int(json['amountMinor']),
        type: _str(json['type']) ?? 'DEBIT',
        kind: _str(json['kind']) ?? '',
        addedTransactionId: _str(json['addedTransactionId']),
      );
}

/// A row of the app's the statement does not list.
class CompareRow {
  final String transactionId;
  final DateTime occurredAt;
  final String? merchant;
  final int amountMinor;
  final String type;
  final String? accountId;

  const CompareRow({
    required this.transactionId,
    required this.occurredAt,
    this.merchant,
    required this.amountMinor,
    required this.type,
    this.accountId,
  });

  bool get isDebit => type == 'DEBIT';

  factory CompareRow.fromJson(Map<String, dynamic> json) => CompareRow(
        transactionId: _str(json['transactionId']) ?? '',
        occurredAt: _date(json['occurredAt']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        merchant: _str(json['merchant']),
        amountMinor: _int(json['amountMinor']),
        type: _str(json['type']) ?? 'DEBIT',
        accountId: _str(json['accountId']),
      );
}

/// `GET /statements/:id/compare`: the statement beside the ledger, both ways.
class StatementComparison {
  final String statementId;

  /// BANK | CARD
  final String kind;
  final String? accountId;
  final int matched;
  final List<CompareLine> onStatementNotInApp;
  final List<CompareRow> inAppNotOnStatement;

  /// A bank statement's closing balance; a card statement's total due.
  final int? closingBalanceMinor;
  final DateTime? closingOn;

  /// The app's running balance at the close. Null for a card, or an
  /// account with no starting balance.
  final int? expectedAtClosingMinor;

  /// Closing less expected: the bank's less the app's.
  final int? differenceMinor;

  const StatementComparison({
    this.statementId = '',
    this.kind = 'CARD',
    this.accountId,
    this.matched = 0,
    this.onStatementNotInApp = const [],
    this.inAppNotOnStatement = const [],
    this.closingBalanceMinor,
    this.closingOn,
    this.expectedAtClosingMinor,
    this.differenceMinor,
  });

  bool get isBank => kind == 'BANK';

  /// Both figures are there to compare.
  bool get hasClosingComparison => isBank && closingBalanceMinor != null && expectedAtClosingMinor != null;

  factory StatementComparison.fromJson(Map<String, dynamic> json) => StatementComparison(
        statementId: _str(json['statementId']) ?? '',
        kind: _str(json['kind']) ?? 'CARD',
        accountId: _str(json['accountId']),
        matched: _int(json['matched']),
        onStatementNotInApp: _maps(json['onStatementNotInApp']).map(CompareLine.fromJson).toList(),
        inAppNotOnStatement: _maps(json['inAppNotOnStatement']).map(CompareRow.fromJson).toList(),
        closingBalanceMinor: _intOrNull(json['closingBalanceMinor']),
        closingOn: _date(json['closingOn']),
        expectedAtClosingMinor: _intOrNull(json['expectedAtClosingMinor']),
        differenceMinor: _intOrNull(json['differenceMinor']),
      );
}
