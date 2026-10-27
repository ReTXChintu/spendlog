import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/dashboard_screen.dart';
import 'package:spendlog/screens/passbook_screen.dart';
import 'package:spendlog/screens/statement_compare_screen.dart';
import 'package:spendlog/screens/transactions_screen.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/utils/format.dart';
import 'package:spendlog/widgets/home/wallet.dart';
import 'package:spendlog/widgets/reconcile_sheet.dart';

// Fixtures, shaped as accounts.passbook.routes.ts, accounts.suspects.ts,
// accounts.drift.ts and statements.compare.ts send them. Paise throughout.

const _acc = '64a000000000000000000001';
const _debitCard = '64a000000000000000000002';
const _alert = '64b000000000000000000001';
const _salary = '650000000000000000000001';
const _adjust = '650000000000000000000002';
const _amazon = '650000000000000000000003';
const _swiggy = '650000000000000000000004';
const _dupe = '650000000000000000000005';
const _unknown = '650000000000000000000006';
const _checkpoint = '66c000000000000000000001';
const _statement = '67d000000000000000000001';

const _account = {'id': _acc, 'name': 'HDFC', 'bankName': 'HDFC Bank', 'last4': '1234', 'accountType': 'BANK'};

/// Opening ₹1,000 on 1 Oct; salary +₹50,000; a ₹100 unexplained
/// difference; Amazon −₹3,000, where the bank said ₹3,000 less than the
/// app; Swiggy −₹450 with no balance in the SMS; a checkpoint typed in
/// from the bank app on the 14th, still ₹3,000 apart.
final _rows = <Map<String, dynamic>>[
  {
    'seq': 5, 'kind': 'checkpoint', 'on': '2026-10-14T18:29:59.000Z', 'transactionId': null, 'checkpointId': _checkpoint,
    'merchant': null, 'type': null, 'amountMinor': null, 'runningMinor': 4745000, 'statedMinor': 4445000,
    'driftMinor': -300000, 'countedReason': null, 'source': 'MANUAL', 'isTransfer': false, 'transferAccountId': null,
    'accountUnknown': false, 'needsExplanation': false, 'note': 'From the app',
  },
  {
    'seq': 4, 'kind': 'txn', 'on': '2026-10-13T14:02:00.000Z', 'transactionId': _swiggy, 'checkpointId': null,
    'merchant': 'Swiggy', 'type': 'DEBIT', 'amountMinor': 45000, 'runningMinor': 4745000, 'statedMinor': null,
    'driftMinor': null, 'countedReason': 'SPEND', 'source': 'SMS', 'isTransfer': false, 'transferAccountId': null,
    'accountUnknown': false, 'needsExplanation': false, 'note': null,
  },
  {
    'seq': 3, 'kind': 'txn', 'on': '2026-10-12T05:30:00.000Z', 'transactionId': _amazon, 'checkpointId': null,
    'merchant': 'Amazon', 'type': 'DEBIT', 'amountMinor': 300000, 'runningMinor': 4790000, 'statedMinor': 4490000,
    'driftMinor': -300000, 'countedReason': 'SPEND', 'source': 'SMS', 'isTransfer': false, 'transferAccountId': null,
    'accountUnknown': false, 'needsExplanation': false, 'note': null,
  },
  {
    'seq': 2, 'kind': 'adjustment', 'on': '2026-10-11T10:00:00.000Z', 'transactionId': _adjust, 'checkpointId': null,
    'merchant': 'Unexplained difference', 'type': 'DEBIT', 'amountMinor': 10000, 'runningMinor': 5090000,
    'statedMinor': null, 'driftMinor': null, 'countedReason': 'SPEND', 'source': 'MANUAL', 'isTransfer': false,
    'transferAccountId': null, 'accountUnknown': false, 'needsExplanation': true, 'note': null,
  },
  {
    'seq': 1, 'kind': 'txn', 'on': '2026-10-10T04:00:00.000Z', 'transactionId': _salary, 'checkpointId': null,
    'merchant': 'Salary', 'type': 'CREDIT', 'amountMinor': 5000000, 'runningMinor': 5100000, 'statedMinor': 5100000,
    'driftMinor': 0, 'countedReason': 'INCOME', 'source': 'SMS', 'isTransfer': false, 'transferAccountId': null,
    'accountUnknown': false, 'needsExplanation': false, 'note': null,
  },
];

const _opening = {
  'seq': 0, 'kind': 'opening', 'on': '2026-10-01T00:00:00.000Z', 'transactionId': null, 'checkpointId': null,
  'merchant': null, 'type': null, 'amountMinor': null, 'runningMinor': 100000, 'statedMinor': 100000, 'driftMinor': 0,
  'countedReason': null, 'source': null, 'isTransfer': false, 'transferAccountId': null, 'accountUnknown': false,
  'needsExplanation': false, 'note': null,
};

const _lastStated = {
  'seq': 5, 'minor': 4445000, 'at': '2026-10-14T18:29:59.000Z', 'transactionId': null, 'checkpointId': _checkpoint,
  'expectedMinor': 4745000, 'driftMinor': -300000,
};

const _firstDrift = {
  'transactionId': _amazon, 'checkpointId': null, 'on': '2026-10-12T05:30:00.000Z', 'driftMinor': -300000, 'seq': 3,
};

Map<String, dynamic> _passbook({List<Map<String, dynamic>>? rows, int? nextBefore}) => {
      'account': _account,
      'openingMinor': 100000,
      'openingAt': '2026-10-01T00:00:00.000Z',
      'expectedNowMinor': 4745000,
      'lastStated': _lastStated,
      'firstDrift': _firstDrift,
      'total': 6,
      'nextBefore': nextBefore,
      'rows': rows ?? [..._rows, _opening],
    };

/// A bank that never puts a balance in its SMS: no stated figures at all.
final _sparsePassbook = <String, dynamic>{
  'account': {'id': _acc, 'name': 'Kotak', 'bankName': 'Kotak', 'last4': null, 'accountType': 'BANK'},
  'openingMinor': 0,
  'openingAt': '2026-10-01T00:00:00.000Z',
  'expectedNowMinor': 120000,
  'lastStated': null,
  'firstDrift': null,
  'total': 2,
  'nextBefore': null,
  'rows': [
    {'seq': 1, 'kind': 'txn', 'on': '2026-10-13T14:02:00.000Z', 'transactionId': _swiggy, 'merchant': 'Swiggy',
      'type': 'CREDIT', 'amountMinor': 120000, 'runningMinor': 120000},
    {'seq': 0, 'kind': 'opening', 'on': '2026-10-01T00:00:00.000Z', 'runningMinor': 0, 'statedMinor': 0, 'driftMinor': 0},
  ],
};

const _debitRefusal = {
  'error': "A debit card spends from its bank account. Open that account's passbook.",
  'accountId': _acc,
};

final _reconcile = <String, dynamic>{
  'account': _account,
  'expectedMinor': 4745000,
  'lastStated': _lastStated,
  'differenceMinor': -300000,
  'firstDrift': _firstDrift,
  'suspects': [
    {
      'kind': 'duplicate', 'transactionIds': [_amazon, _dupe], 'amountMinor': 300000,
      'explanation': '₹3,000 to Amazon is in twice on 12 Oct, minutes apart - and it is exactly the gap. Probably one payment reported by two messages.',
      'on': '2026-10-12T05:30:00.000Z',
      'fix': {'method': 'POST', 'path': '/transactions/$_amazon/merge', 'body': {'sourceIds': [_dupe]}, 'label': 'Merge them'},
    },
    {
      'kind': 'unknown_account', 'transactionIds': [_unknown], 'amountMinor': 300000,
      'explanation': '₹3,000 to Zomato on 12 Oct has no account, and it is exactly the gap. If it was this account, that is the whole difference.',
      'on': '2026-10-12T09:00:00.000Z',
      'fix': {'method': 'PATCH', 'path': '/transactions/$_unknown', 'body': {'accountId': _acc}, 'label': 'It was on this account'},
    },
    {
      'kind': 'missing_days', 'transactionIds': [_amazon], 'amountMinor': 300000,
      'explanation': 'between 10 Oct and 12 Oct, ₹3,000 more left the account than the rows in between explain. A payment in those days was not captured.',
      'on': '2026-10-10T04:00:00.000Z', 'until': '2026-10-12T05:30:00.000Z',
    },
  ],
};

final _settled = <String, dynamic>{
  'account': _account,
  'expectedMinor': 4445000,
  'lastStated': {..._lastStated, 'expectedMinor': 4445000, 'driftMinor': 0},
  'differenceMinor': 0,
  'firstDrift': null,
  'suspects': [],
};

Map<String, dynamic> _transaction(String id, {bool accountUnknown = false}) => {
      'id': id,
      'amountMinor': 10000,
      'currency': 'INR',
      'type': 'DEBIT',
      'merchant': 'Unexplained difference',
      'source': 'MANUAL',
      'isTransfer': false,
      'pending': false,
      'occurredAt': '2026-10-11T10:00:00.000Z',
      'isAdjustment': true,
      'needsExplanation': true,
      'accountUnknown': accountUnknown,
      'statedBalanceMinor': null,
    };

final _dashboard = <String, dynamic>{
  // A fixed cost others pay back for, so the layout checks see whose part
  // is in, and an entry the AI check doubts.
  'pace': {
    'configured': true,
    'commitmentsRemainingMinor': 0,
    'commitments': [
      {
        'id': 'rent', 'name': 'Rent', 'amountMinor': 1150000, 'thisPeriodAmountMinor': 50000, 'dayOfMonth': 22,
        'isPaid': true,
        'shareStatus': [
          {'contactId': 'c1', 'name': 'Chirayu with a long surname', 'amountMinor': 400000, 'paidMinor': 400000},
          {'contactId': 'c2', 'name': 'Harshang', 'amountMinor': 400000, 'paidMinor': 100000},
          {'contactId': 'c3', 'name': 'Sapan', 'amountMinor': 300000, 'paidMinor': 0},
        ],
      },
    ],
  },
  'flaggedEntries': 2,
  'money': {
    'accounts': [
      {'id': _acc, 'name': 'HDFC', 'last4': '1234', 'accountType': 'BANK', 'balanceMinor': 4745000,
        'drift': {'minor': -300000, 'since': '2026-10-12T05:30:00.000Z'}},
    ],
    'onHandMinor': 4745000, 'inBankMinor': 4745000, 'cashMinor': null, 'savingsMinor': null, 'untracked': 0,
  },
  'wallet': {
    'cards': [],
    'banks': [
      {'accountId': _acc, 'name': 'HDFC', 'bankName': 'HDFC Bank', 'accountType': 'BANK', 'last4': '1234',
        'balanceMinor': 4745000, 'drift': {'minor': -300000, 'since': '2026-10-12T05:30:00.000Z'}, 'debitCards': []},
      {'accountId': 'c1', 'name': 'Cash', 'bankName': 'Cash', 'accountType': 'CASH', 'balanceMinor': 120000,
        'drift': null, 'debitCards': []},
    ],
  },
  'todos': [
    {
      'kind': 'balance_alert', 'title': 'HDFC ••1234 is ₹3,000 off since 12 Oct',
      'body': 'The bank shows ₹44,450; SpendLog expected ₹47,450. A payment may be missing.',
      'alertId': _alert, 'accountId': _acc, 'driftMinor': -300000, 'since': '2026-10-12T05:30:00.000Z',
    },
    {
      'kind': 'unexplained_difference', 'title': '₹100 unexplained out of HDFC ••1234',
      'body': 'Written in on 11 Oct to match the bank. Give it a category or a name once you know what it was.',
      'transactionId': _adjust, 'accountId': _acc, 'amountMinor': 10000, 'on': '2026-10-11T10:00:00.000Z',
    },
    {
      'kind': 'unknown_account', 'title': '2 payments without an account',
      'body': 'Not counted in any balance until you say which account each was on.',
      'count': 2, 'filter': {'accountUnknown': '1'},
    },
    {'kind': 'something_newer', 'title': 'From a server this build does not know', 'body': ''},
  ],
};

final _comparison = <String, dynamic>{
  'statementId': _statement,
  'kind': 'BANK',
  'accountId': _acc,
  'matched': 12,
  'pairs': [],
  'onStatementNotInApp': [
    {'lineId': 'l1', 'date': '2026-10-05T00:00:00.000Z', 'description': 'ATM WDL 1234', 'amountMinor': 200000,
      'type': 'DEBIT', 'kind': 'PURCHASE', 'addedTransactionId': null},
  ],
  'inAppNotOnStatement': [
    {'transactionId': _dupe, 'occurredAt': '2026-10-12T05:31:00.000Z', 'merchant': 'Amazon', 'amountMinor': 300000,
      'type': 'DEBIT', 'accountId': _acc},
  ],
  'closingBalanceMinor': 4445000,
  'closingOn': '2026-10-14T00:00:00.000Z',
  'expectedAtClosingMinor': 4745000,
  'differenceMinor': -300000,
};

// ---- A server ----------------------------------------------------------

typedef _Handler = http.Response Function(http.Request request);

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

/// Routes by path suffix. A value is JSON to send, an [http.Response], or
/// a handler. Anything else gets an empty list, which is what every
/// lookup the edit sheet and the ledger make can live with.
http.Response _handle(Map<String, Object> routes, http.Request request) {
  final path = request.url.path;
  for (final entry in routes.entries) {
    if (path.endsWith(entry.key)) {
      final value = entry.value;
      if (value is http.Response) return value;
      if (value is _Handler) return value(request);
      return _json(value);
    }
  }
  if (path.endsWith('/contacts')) return _json({'contacts': []});
  if (path.endsWith('/by-day')) return _json({'days': [], 'hasMore': false, 'nextBefore': null});
  return _json([]);
}

MockClient _server(Map<String, Object> routes, {List<http.Request>? log}) => MockClient((request) async {
      log?.add(request);
      return _handle(routes, request);
    });

/// The passbook route with real paging: the first page stops short of the
/// opening row and hands back its cursor; `before=1` is the rest.
http.Response _pagedPassbook(http.Request request) {
  final before = request.url.queryParameters['before'];
  if (before == null) return _json(_passbook(rows: _rows, nextBefore: 1));
  return _json(_passbook(rows: [_opening], nextBefore: null));
}

Map<String, Object> _routes({Object? passbook, Object? reconcile}) => {
      '/accounts/$_acc/passbook': passbook ?? _pagedPassbook,
      '/accounts/$_debitCard/passbook': _json(_debitRefusal, 400),
      '/accounts/$_acc/reconcile': reconcile ?? _reconcile,
      '/transactions/$_adjust': _transaction(_adjust),
      '/transactions/$_dupe': _transaction(_dupe),
      '/transactions/$_unknown': _transaction(_unknown, accountUnknown: true),
      '/dashboard': _dashboard,
      '/statements/$_statement/compare': _comparison,
    };

/// A reconcile that is off until the first fix is applied, then settled.
_Handler _reconcileThatSettles(List<http.Request> log) => (request) {
      final fixed = log.any((r) => r.method == 'POST' && r.url.path.endsWith('/merge'));
      return _json(fixed ? _settled : _reconcile);
    };

List<http.Request> _of(List<http.Request> log, String method, String suffix) =>
    log.where((r) => r.method == method && r.url.path.endsWith(suffix)).toList();

/// 360 logical pixels wide, and tall enough that a lazily built list has
/// every row on screen. The edit sheet is laid out for the real font and
/// the test font's square glyphs are far wider, so the tests that open it
/// use [wide], as test/edit_transaction_test.dart does.
Future<void> _pump(WidgetTester tester, Widget home, {Brightness brightness = Brightness.light, bool wide = false}) async {
  tester.view.physicalSize = Size(wide ? 1440 : 1080, 7200);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: home));
}

/// The dashboard as the shell holds it: inside a Scaffold.
Widget _dashboardPage() => const Scaffold(body: DashboardScreen());

/// A page with a button that opens the reconcile sheet.
Widget _sheetOpener() => Scaffold(
      body: Builder(
        builder: (context) => Center(
          child: TextButton(
            onPressed: () => showReconcileSheet(context, accountId: _acc),
            child: const Text('Open sheet'),
          ),
        ),
      ),
    );

Finder _richTextContaining(String text) =>
    find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().contains(text));

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('models', () {
    test('PassbookPage reads the full shape, newest first', () {
      final page = PassbookPage.fromJson(_passbook());
      expect(page.account.label, 'HDFC ••1234');
      expect(page.expectedNowMinor, 4745000);
      expect(page.openingMinor, 100000);
      expect(page.total, 6);
      expect(page.hasMore, isFalse);
      expect(page.neverStated, isFalse);

      expect(page.lastStated!.minor, 4445000);
      expect(page.lastStated!.driftMinor, -300000);
      expect(page.lastStated!.isOff, isTrue);
      expect(page.firstDrift!.seq, 3);
      expect(page.firstDrift!.transactionId, _amazon);

      expect(page.rows.map((r) => r.seq), [5, 4, 3, 2, 1, 0]);
      final checkpoint = page.rows.first;
      expect(checkpoint.isCheckpoint, isTrue);
      expect(checkpoint.statedMinor, 4445000);
      expect(checkpoint.note, 'From the app');
      final swiggy = page.rows[1];
      expect(swiggy.statedMinor, isNull);
      expect(swiggy.driftMinor, isNull);
      expect(swiggy.isOff, isFalse);
      expect(swiggy.day, '2026-10-13');
      expect(page.rows[2].isOff, isTrue);
      expect(page.rows[3].isAdjustment, isTrue);
      expect(page.rows[3].needsExplanation, isTrue);
      expect(page.rows.last.isOpening, isTrue);
    });

    test('a bank that never states a balance leaves every stated field null', () {
      final page = PassbookPage.fromJson(_sparsePassbook);
      expect(page.neverStated, isTrue);
      expect(page.lastStated, isNull);
      expect(page.firstDrift, isNull);
      expect(page.account.label, 'Kotak');
      expect(page.rows.first.statedMinor, isNull);
      expect(page.rows.first.type, 'CREDIT');
      expect(page.rows.first.isDebit, isFalse);
      // Missing fields, not just null ones.
      expect(page.rows.first.isTransfer, isFalse);
      expect(page.rows.first.source, isNull);
      expect(PassbookPage.fromJson({}).rows, isEmpty);
    });

    test('a debit card refusal names the bank account to open instead', () {
      final refusal = PassbookRefusal.fromJson(_debitRefusal);
      expect(refusal.accountId, _acc);
      expect(refusal.error, startsWith('A debit card'));
      expect(PassbookRefusal.fromJson({'error': 'Set a starting balance on this account first.'}).accountId, isNull);
    });

    test('Reconcile keeps the suspects in order with their fixes', () {
      final reconcile = Reconcile.fromJson(_reconcile);
      expect(reconcile.differenceMinor, -300000);
      expect(reconcile.settled, isFalse);
      expect(reconcile.suspects.map((s) => s.kind), ['duplicate', 'unknown_account', 'missing_days']);
      final fix = reconcile.suspects.first.fix!;
      expect(fix.method, 'POST');
      expect(fix.path, '/transactions/$_amazon/merge');
      expect(fix.body, {'sourceIds': [_dupe]});
      expect(fix.label, 'Merge them');
      expect(reconcile.suspects[1].fix!.method, 'PATCH');
      expect(reconcile.suspects.last.fix, isNull);
      expect(reconcile.suspects.last.until, isNotNull);
      expect(Reconcile.fromJson(_settled).settled, isTrue);
      // No figure from the bank: no gap, and nothing is "settled".
      expect(Reconcile.fromJson({'account': _account, 'expectedMinor': 1, 'differenceMinor': null}).settled, isFalse);
    });

    test('drift tolerance: a rupee is rounding, more is off', () {
      expect(driftIsOff(0), isFalse);
      expect(driftIsOff(100), isFalse);
      expect(driftIsOff(-100), isFalse);
      expect(driftIsOff(101), isTrue);
      expect(driftIsOff(null), isFalse);
    });

    test('the dashboard carries drift on tiles and the three to-do kinds', () {
      final data = DashboardData.fromJson(_dashboard);
      expect(data.wallet.banks.first.drift!.minor, -300000);
      expect(data.wallet.banks.first.drift!.since, isNotNull);
      expect(data.wallet.banks.last.drift, isNull);
      expect(data.money.accounts.first.drift!.minor, -300000);
      // The kind this build does not know is left off rather than shown.
      expect(data.todos.map((t) => t.kind), ['balance_alert', 'unexplained_difference', 'unknown_account']);
      expect(data.todos[0].alertId, _alert);
      expect(data.todos[0].accountId, _acc);
      expect(data.todos[1].transactionId, _adjust);
      expect(data.todos[2].count, 2);
      expect(DashboardData.fromJson({}).todos, isEmpty);
      expect(ExpectedBalance.fromJson({'expectedMinor': 5, 'drift': {'minor': 500, 'since': '2026-10-12T05:30:00.000Z', 'statedAt': '2026-10-14T00:00:00.000Z'}}).drift!.statedAt, isNotNull);
    });

    test('Transaction reads the balance fields, and an older row does without', () {
      final row = Transaction.fromJson({..._transaction(_adjust), 'statedBalanceMinor': 4445000});
      expect(row.isAdjustment, isTrue);
      expect(row.needsExplanation, isTrue);
      expect(row.accountUnknown, isFalse);
      expect(row.statedBalanceMinor, 4445000);
      final old = Transaction.fromJson({'id': 'x', 'amountMinor': 1, 'type': 'DEBIT', 'source': 'SMS', 'occurredAt': '2026-10-11T10:00:00.000Z'});
      expect(old.isAdjustment, isFalse);
      expect(old.statedBalanceMinor, isNull);
    });

    test('BalanceAlert and StatementComparison parse', () {
      final alert = BalanceAlert.fromJson({
        'id': _alert, 'accountId': _acc, 'account': {'name': 'HDFC', 'bankName': 'HDFC Bank', 'last4': '1234'},
        'driftMinor': -300000, 'statedMinor': 4445000, 'expectedMinor': 4745000,
        'statedAt': '2026-10-14T18:29:59.000Z', 'since': '2026-10-12T05:30:00.000Z',
        'title': 'HDFC ••1234 is ₹3,000 off since 12 Oct', 'body': 'x',
      });
      expect(alert.account!.label, 'HDFC ••1234');
      expect(BalanceAlert.fromJson({'id': 'a', 'accountId': 'b', 'driftMinor': 5}).account, isNull);

      final comparison = StatementComparison.fromJson(_comparison);
      expect(comparison.isBank, isTrue);
      expect(comparison.hasClosingComparison, isTrue);
      expect(comparison.differenceMinor, -300000);
      expect(comparison.onStatementNotInApp.single.description, 'ATM WDL 1234');
      expect(comparison.inAppNotOnStatement.single.transactionId, _dupe);
      final card = StatementComparison.fromJson({..._comparison, 'kind': 'CARD', 'expectedAtClosingMinor': null, 'differenceMinor': null});
      expect(card.hasClosingComparison, isFalse);
    });
  });

  group('passbook screen', () {
    testWidgets('header, strip, running and stated columns, and the second page', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const PassbookScreen(accountId: _acc));
        await tester.pumpAndSettle();

        // The header: what the app expects, what the bank said, the gap.
        expect(find.text('SpendLog expects'), findsOneWidget);
        expect(find.text('₹47,450.00'), findsWidgets);
        expect(_richTextContaining('Bank said ₹44,450.00 on 14 Oct'), findsOneWidget);
        expect(find.text('₹3,000.00 off'), findsOneWidget);

        // Where it went wrong, pinned.
        expect(find.text('The figures part on 12 Oct (₹3,000)'), findsOneWidget);
        expect(find.text('Jump to it'), findsOneWidget);
        expect(find.text('Find the cause'), findsOneWidget);

        // The Amazon row: amount, running balance, the bank's figure and
        // the gap as a chip.
        expect(find.text('Amazon'), findsOneWidget);
        expect(find.text('−₹3,000.00'), findsOneWidget);
        expect(find.text('₹47,900.00'), findsOneWidget);
        expect(find.text('bank ₹44,900.00'), findsOneWidget);
        expect(find.text('₹3,000 off'), findsWidgets);
        // Swiggy: no stated figure, so only the running balance.
        expect(find.text('Swiggy'), findsOneWidget);
        expect(find.text('bank ₹47,450.00'), findsNothing);
        // Salary agreed with the bank: no chip at all.
        expect(find.text('bank ₹51,000.00'), findsOneWidget);
        expect(find.text('Matches'), findsNothing);
        // Special rows.
        expect(find.text('Bank app said ₹44,450.00'), findsOneWidget);
        expect(find.textContaining('From the app'), findsOneWidget);
        expect(find.text('Unexplained difference'), findsOneWidget);
        expect(find.textContaining('not yet explained'), findsOneWidget);

        // The list is short, so the page before came in on its own and
        // the opening row is on screen.
        expect(find.text('Starting balance'), findsOneWidget);
        expect(find.text('₹1,000.00'), findsOneWidget);
        final pages = _of(log, 'GET', '/passbook');
        expect(pages, hasLength(2));
        expect(pages.first.url.queryParameters['before'], isNull);
        expect(pages.last.url.queryParameters['before'], '1');
        expect(find.textContaining('whole history'), findsOneWidget);
        expect(tester.takeException(), isNull);
      }, () => _server(_routes(), log: log));
    });

    testWidgets('Jump to it tints the row where the figures parted', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const PassbookScreen(accountId: _acc));
        await tester.pumpAndSettle();

        final tinted = find.byWidgetPredicate((w) => w is Material && w.color == DsColors.light.acSoft);
        expect(tinted, findsNothing);
        await tester.tap(find.text('Jump to it'));
        await tester.pumpAndSettle();
        expect(tinted, findsOneWidget);
        expect(find.descendant(of: tinted, matching: find.text('Amazon')), findsOneWidget);
        // The tint lifts on its own.
        await tester.pump(const Duration(seconds: 5));
        expect(tinted, findsNothing);
      }, () => _server(_routes()));
    });

    testWidgets('a bank that never states a balance is told so, with no strip', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const PassbookScreen(accountId: _acc));
        await tester.pumpAndSettle();

        expect(find.text("This bank doesn't send balances in its SMS. Add a checkpoint from your bank app."), findsOneWidget);
        expect(find.text('Add a checkpoint'), findsOneWidget);
        expect(find.text('Jump to it'), findsNothing);
        expect(_richTextContaining('Bank said'), findsNothing);
        expect(find.text('₹1,200.00'), findsWidgets);
        expect(tester.takeException(), isNull);
      }, () => _server(_routes(passbook: _sparsePassbook)));
    });

    testWidgets('a debit card opens the bank account it spends from', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const PassbookScreen(accountId: _debitCard));
        await tester.pumpAndSettle();
        expect(find.text('HDFC ••1234'), findsOneWidget);
        expect(_of(log, 'GET', '/accounts/$_debitCard/passbook'), hasLength(1));
        expect(_of(log, 'GET', '/accounts/$_acc/passbook'), isNotEmpty);
      }, () => _server(_routes(), log: log));
    });

    testWidgets('adding a checkpoint posts the figure at the end of that IST day', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const PassbookScreen(accountId: _acc));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Add checkpoint'));
        await tester.pumpAndSettle();
        expect(find.text('Add a checkpoint'), findsOneWidget);
        await tester.enterText(find.widgetWithText(TextField, 'Balance shown'), '44450');
        await tester.enterText(find.widgetWithText(TextField, 'Note (optional)'), 'App showed this');

        // A day in the past - the 15th of last month - so the figure is
        // taken as the end of that day rather than now.
        await tester.tap(find.text('Today'));
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Previous month'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('15'));
        await tester.tap(find.text('OK'));
        await tester.pumpAndSettle();
        expect(find.text('Today'), findsNothing);

        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();

        final today = DateTime.parse(istToday());
        final lastMonth = DateTime(today.year, today.month - 1, 15);
        final expectedOn = fromIstWallClock(DateTime(lastMonth.year, lastMonth.month, 15, 23, 59, 59));

        final posts = _of(log, 'POST', '/accounts/$_acc/checkpoints');
        expect(posts, hasLength(1));
        final body = jsonDecode(posts.single.body) as Map<String, dynamic>;
        expect(body['balanceMinor'], 4445000);
        expect(body['note'], 'App showed this');
        expect(DateTime.parse(body['on'] as String), expectedOn);
        expect(body['on'], endsWith('T18:29:59.000Z'));
        // The passbook reloads what was on screen.
        expect(_of(log, 'GET', '/passbook').length, greaterThan(2));
      }, () => _server({..._routes(), '/checkpoints': _json({'id': _checkpoint}, 201)}, log: log));
    });

    testWidgets('an alert it was opened from is marked seen', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const PassbookScreen(accountId: _acc, alertId: _alert));
        await tester.pumpAndSettle();
        expect(_of(log, 'POST', '/accounts/alerts/$_alert/seen'), hasLength(1));
      }, () => _server({..._routes(), '/seen': _json({'id': _alert})}, log: log));
    });
  });

  group('reconcile sheet', () {
    testWidgets('suspects render likeliest first; Apply sends the exact fix; then Fixed it', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, _sheetOpener());
        await tester.tap(find.text('Open sheet'));
        await tester.pumpAndSettle();

        expect(find.text('Find the cause'), findsOneWidget);
        expect(find.text('₹3,000.00 off'), findsOneWidget);
        expect(find.text('₹47,450.00'), findsOneWidget);
        expect(find.text('₹44,450.00'), findsOneWidget);

        final first = find.text('The same payment twice');
        final second = find.text('A payment with no account');
        final third = find.text('Days with something missing');
        expect(first, findsOneWidget);
        expect(second, findsOneWidget);
        expect(third, findsOneWidget);
        expect(tester.getTopLeft(first).dy, lessThan(tester.getTopLeft(second).dy));
        expect(tester.getTopLeft(second).dy, lessThan(tester.getTopLeft(third).dy));
        expect(find.text('Merge them'), findsOneWidget);
        expect(find.text('It was on this account'), findsOneWidget);
        // No fix: what to check instead.
        expect(find.textContaining('Open the bank app and look at these days'), findsOneWidget);
        // The last resort is there, after the suspects.
        final adjust = find.text('None of these? Record the difference');
        expect(adjust, findsOneWidget);
        expect(tester.getTopLeft(third).dy, lessThan(tester.getTopLeft(adjust).dy));

        await tester.tap(find.text('Merge them'));
        await tester.pumpAndSettle();

        final merges = _of(log, 'POST', '/transactions/$_amazon/merge');
        expect(merges, hasLength(1));
        expect(jsonDecode(merges.single.body), {'sourceIds': [_dupe]});
        expect(_of(log, 'GET', '/reconcile'), hasLength(2));
        expect(find.text('Fixed it'), findsOneWidget);
        expect(find.text('SpendLog now matches the bank at ₹44,450.00.'), findsOneWidget);
        expect(find.text('None of these? Record the difference'), findsNothing);
        expect(tester.takeException(), isNull);
      }, () => _server({..._routes(), '/accounts/$_acc/reconcile': _reconcileThatSettles(log), '/merge': _json({'ok': true})}, log: log));
    });

    testWidgets('recording the difference needs a confirmation and posts the bank figure', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, _sheetOpener());
        await tester.tap(find.text('Open sheet'));
        await tester.pumpAndSettle();

        await tester.ensureVisible(find.text('None of these? Record the difference'));
        await tester.tap(find.text('None of these? Record the difference'));
        await tester.pumpAndSettle();
        expect(find.text('Record the difference?'), findsOneWidget);
        expect(find.textContaining('stays in your to-dos'), findsOneWidget);
        // Pre-filled with what the bank last said, and the gap it means.
        expect(find.text('44450.00'), findsOneWidget);
        expect(find.textContaining('₹3,000.00 out will be written in'), findsOneWidget);
        expect(_of(log, 'POST', '/adjust'), isEmpty);

        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();
        expect(_of(log, 'POST', '/adjust'), isEmpty);

        await tester.ensureVisible(find.text('None of these? Record the difference'));
        await tester.tap(find.text('None of these? Record the difference'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Record it'));
        await tester.pumpAndSettle();

        final posts = _of(log, 'POST', '/accounts/$_acc/reconcile/adjust');
        expect(posts, hasLength(1));
        expect(jsonDecode(posts.single.body), {'balanceMinor': 4445000});
        // The sheet closes, telling the caller something changed.
        expect(find.text('Find the cause'), findsNothing);
        expect(find.textContaining('Recorded ₹3,000.00 out'), findsOneWidget);
      }, () => _server({
            ..._routes(),
            '/adjust': _json({'gapMinor': -300000, 'transaction': _transaction(_adjust), 'checkpoint': {}}, 201),
          }, log: log));
    });
  });

  group('dashboard', () {
    testWidgets('a drifted bank tile shows the gap and opens the passbook', (tester) async {
      final data = DashboardData.fromJson(_dashboard);
      String? opened;
      await _pump(
        tester,
        Scaffold(
          body: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: WalletSection(
              money: data.money,
              wallet: data.wallet,
              onOpenCard: (_) {},
              onOpenAccount: (_) {},
              onOpenPassbook: (id) => opened = id,
              onManage: () {},
            ),
          ),
        ),
      );
      expect(find.text('₹3,000 off'), findsOneWidget);
      // The cash tile is in step: a quiet link instead.
      expect(find.text('Passbook ›'), findsOneWidget);
      await tester.tap(find.text('₹3,000 off'));
      expect(opened, _acc);
      await tester.tap(find.text('Passbook ›'));
      expect(opened, 'c1');
      expect(tester.takeException(), isNull);
    });

    testWidgets('a balance alert opens the passbook, marks it seen and offers the cause', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, _dashboardPage());
        await tester.pumpAndSettle();
        expect(find.text('HDFC ••1234 is ₹3,000 off since 12 Oct'), findsOneWidget);

        await tester.tap(find.text('HDFC ••1234 is ₹3,000 off since 12 Oct'));
        await tester.pumpAndSettle();

        expect(find.byType(PassbookScreen), findsOneWidget);
        expect(_of(log, 'POST', '/accounts/alerts/$_alert/seen'), hasLength(1));
        // The reconcile sheet came up over it.
        expect(find.byType(ReconcileSheet), findsOneWidget);
        expect(find.text('The same payment twice'), findsOneWidget);
      }, () => _server({..._routes(), '/seen': _json({'id': _alert})}, log: log));
    });

    testWidgets('an unexplained difference opens its editor', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, _dashboardPage(), wide: true);
        await tester.pumpAndSettle();

        await tester.tap(find.text('₹100 unexplained out of HDFC ••1234'));
        await tester.pumpAndSettle();

        expect(_of(log, 'GET', '/transactions/$_adjust'), hasLength(1));
        expect(find.text('Save'), findsOneWidget);
        expect(find.widgetWithText(TextField, 'Unexplained difference'), findsOneWidget);
      }, () => _server(_routes(), log: log));
    });

    testWidgets('a row with no account offers "It was cash", and only a choice clears the flag', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _pump(tester, _dashboardPage(), wide: true);
        await tester.pumpAndSettle();
        // Open the placeless row the way the ledger would: by id.
        await tester.tap(find.text('₹100 unexplained out of HDFC ••1234'));
        await tester.pumpAndSettle();

        // Nothing chosen yet, and the hint says why.
        expect(find.text('No account yet'), findsOneWidget);
        expect(find.textContaining('named no account'), findsOneWidget);
        expect(find.text('It was cash'), findsNothing);

        // Saving without touching the account leaves the flag alone.
        await tester.ensureVisible(find.text('Save'));
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();
        expect(patches, hasLength(1));
        expect(patches.single.containsKey('accountUnknown'), isFalse);

        // Open it again and say it was cash.
        await tester.tap(find.text('₹100 unexplained out of HDFC ••1234'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('No account yet'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('It was cash').last);
        await tester.pumpAndSettle();
        expect(find.text('No account yet'), findsNothing);
        await tester.ensureVisible(find.text('Save'));
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();
        expect(patches, hasLength(2));
        expect(patches.last['accountUnknown'], isFalse);
        expect(patches.last['accountId'], isNull);
      }, () => MockClient((request) async {
            if (request.method == 'PATCH') {
              patches.add(jsonDecode(request.body) as Map<String, dynamic>);
              return _json({});
            }
            if (request.url.path.endsWith('/transactions/$_adjust')) {
              return _json(_transaction(_adjust, accountUnknown: true));
            }
            return _handle(_routes(), request);
          }));
    });

    testWidgets('payments without an account open the ledger narrowed to them', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, _dashboardPage());
        await tester.pumpAndSettle();

        await tester.tap(find.text('2 payments without an account'));
        await tester.pumpAndSettle();

        expect(find.byType(TransactionsScreen), findsOneWidget);
        final loads = _of(log, 'GET', '/transactions/by-day');
        expect(loads, isNotEmpty);
        expect(loads.first.url.queryParameters['accountUnknown'], '1');
        expect(loads.first.url.queryParameters['from'], isNull);
        // The month bar says what the list is, and offers the way back.
        expect(find.text('All time'), findsOneWidget);
        expect(find.text('payments with no account'), findsOneWidget);
        expect(find.text('Back to months'), findsOneWidget);
      }, () => _server(_routes(), log: log));
    });
  });

  group('statement comparison', () {
    testWidgets('both lists and the close, and a SpendLog row opens', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const StatementCompareScreen(statementId: _statement, title: 'HDFC Sep'), wide: true);
        await tester.pumpAndSettle();

        expect(find.text('₹44,450.00'), findsOneWidget);
        expect(find.text('₹47,450.00'), findsOneWidget);
        expect(find.text('₹3,000.00 off'), findsOneWidget);
        expect(find.text('On the statement, not in SpendLog'), findsOneWidget);
        expect(find.text('ATM WDL 1234'), findsOneWidget);
        expect(find.text('In SpendLog, not on the statement'), findsOneWidget);
        expect(find.text('Amazon'), findsOneWidget);
        expect(find.textContaining('12 lines match'), findsOneWidget);

        await tester.tap(find.text('Amazon'));
        await tester.pumpAndSettle();
        expect(_of(log, 'GET', '/transactions/$_dupe'), hasLength(1));
        expect(find.text('Save'), findsOneWidget);
      }, () => _server(_routes(), log: log));
    });

    testWidgets('a card statement has no close to compare', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const StatementCompareScreen(statementId: _statement, title: 'Amex Sep'));
        await tester.pumpAndSettle();
        expect(find.text('At the close'), findsNothing);
        expect(find.text('On the statement, not in SpendLog'), findsOneWidget);
      }, () => _server({
            ..._routes(),
            '/compare': {..._comparison, 'kind': 'CARD', 'expectedAtClosingMinor': null, 'differenceMinor': null},
          }));
    });
  });

  for (final brightness in Brightness.values) {
    group('no overflow at 360px (${brightness.name})', () {
      testWidgets('passbook', (tester) async {
        await http.runWithClient(() async {
          await _pump(tester, const PassbookScreen(accountId: _acc), brightness: brightness);
          await tester.pumpAndSettle();
          expect(find.text('Starting balance'), findsOneWidget);
          expect(tester.takeException(), isNull);
        }, () => _server(_routes()));
      });

      testWidgets('reconcile sheet', (tester) async {
        await http.runWithClient(() async {
          await _pump(tester, _sheetOpener(), brightness: brightness);
          await tester.tap(find.text('Open sheet'));
          await tester.pumpAndSettle();
          expect(find.text('Merge them'), findsOneWidget);
          expect(tester.takeException(), isNull);
        }, () => _server(_routes()));
      });

      testWidgets('dashboard with to-dos and a drifted tile', (tester) async {
        await http.runWithClient(() async {
          await _pump(tester, _dashboardPage(), brightness: brightness);
          await tester.pumpAndSettle();
          expect(find.text('₹3,000 off'), findsOneWidget);
          expect(find.text('2 payments without an account'), findsOneWidget);
          expect(tester.takeException(), isNull);
        }, () => _server(_routes()));
      });

      testWidgets('statement comparison', (tester) async {
        await http.runWithClient(() async {
          await _pump(tester, const StatementCompareScreen(statementId: _statement, title: 'HDFC Sep'), brightness: brightness);
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
        }, () => _server(_routes()));
      });
    });
  }
}
