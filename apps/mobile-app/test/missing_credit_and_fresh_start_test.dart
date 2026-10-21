import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/passbook_screen.dart';
import 'package:spendlog/screens/start_fresh_screen.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_account_sheet.dart';
import 'package:spendlog/widgets/what_came_in_sheet.dart';

// Fixtures, shaped as accounts.missingCredits.routes.ts,
// accounts.freshStart.ts and accounts.passbook.routes.ts send them.
// Paise throughout.

const _federal = '64a000000000000000000011';
const _hdfc = '64a000000000000000000012';
const _cash = '64a000000000000000000013';
const _savings = '64a000000000000000000014';
const _credit = '6ff000000000000000000001';
const _debit = '650000000000000000000021';
const _rahul = '6c0000000000000000000001';
const _freelance = '6ca000000000000000000001';

final _missing = <String, dynamic>{
  'id': _credit,
  'accountId': _federal,
  'account': {'name': 'Federal Bank', 'bankName': 'Federal Bank', 'last4': '5130', 'noCreditAlerts': false},
  'amountMinor': 500000,
  'after': '2026-10-05T04:30:00.000Z',
  'before': '2026-10-12T04:30:00.000Z',
  'status': 'open',
  'title': '₹5,000 came into Federal Bank ••5130 between 5 and 12 Oct',
  'body': 'What was it?',
  'suggestions': [
    {
      'as': 'transfer',
      'label': 'From HDFC ••8342 — you sent ₹5,000 on 11 Oct',
      'fromAccountId': _hdfc,
      'transactionId': _debit,
    },
    {'as': 'paid_back', 'label': 'Rahul paying you back — owed you ₹5,000', 'contactId': _rahul},
  ],
};

Map<String, dynamic> _account(String id, String bank, String? last4, String type, {bool isSavings = false}) => {
      'id': id,
      'bankName': bank,
      'last4': last4,
      'accountType': type,
      'isActive': true,
      'isSavings': isSavings,
    };

final _accounts = [
  _account(_federal, 'Federal Bank', '5130', 'BANK'),
  _account(_hdfc, 'HDFC', '8342', 'BANK'),
  _account(_cash, 'Cash', null, 'CASH'),
  _account('64a000000000000000000099', 'ICICI', '2009', 'CARD'),
];

final _freshRows = [
  {
    'accountId': _federal, 'name': 'Federal Bank', 'last4': '5130', 'accountType': 'BANK', 'isSavings': false,
    'expectedMinor': 1430000, 'provisionalMinor': 500000,
    'lastStated': {'minor': 1430000, 'at': '2026-10-16T04:30:00.000Z'}, 'statedToday': true, 'canUndo': false,
  },
  {
    'accountId': _hdfc, 'name': 'HDFC', 'last4': '8342', 'accountType': 'BANK', 'isSavings': false,
    'expectedMinor': 4500000, 'provisionalMinor': 0,
    'lastStated': {'minor': 4400000, 'at': '2026-10-10T04:30:00.000Z'}, 'statedToday': false, 'canUndo': false,
  },
  {
    'accountId': _cash, 'name': 'Cash', 'last4': null, 'accountType': 'CASH', 'isSavings': false,
    'expectedMinor': 120000, 'provisionalMinor': 0, 'lastStated': null, 'statedToday': false, 'canUndo': false,
  },
  {
    'accountId': _savings, 'name': 'SBI', 'last4': '1111', 'accountType': 'BANK', 'isSavings': true,
    'expectedMinor': 98765400, 'provisionalMinor': 0, 'lastStated': null, 'statedToday': false, 'canUndo': false,
  },
];

Map<String, dynamic> _passbook({bool canUndo = false}) => {
      'account': {
        'id': _federal, 'name': 'Federal Bank', 'bankName': 'Federal Bank', 'last4': '5130', 'accountType': 'BANK',
        'isSavings': false, 'noCreditAlerts': false, 'canUndoFreshStart': canUndo,
      },
      'openingMinor': 1000000,
      'openingAt': '2026-09-30T18:30:00.000Z',
      'expectedNowMinor': 1430000,
      'provisionalMinor': 500000,
      'lastStated': {
        'seq': 3, 'minor': 1430000, 'at': '2026-10-12T04:30:00.000Z', 'transactionId': 't2', 'checkpointId': null,
        'expectedMinor': 1430000, 'driftMinor': 0,
      },
      'firstDrift': null,
      'total': 4,
      'nextBefore': null,
      'rows': [
        {'seq': 3, 'kind': 'txn', 'on': '2026-10-12T04:30:00.000Z', 'transactionId': 't2', 'merchant': 'Swiggy',
          'type': 'DEBIT', 'amountMinor': 20000, 'runningMinor': 1430000, 'statedMinor': 1430000, 'driftMinor': 0,
          'source': 'SMS'},
        {'seq': 2, 'kind': 'missing_credit', 'on': '2026-10-12T04:30:00.000Z', 'transactionId': null,
          'type': 'CREDIT', 'amountMinor': 500000, 'runningMinor': 1450000, 'statedMinor': null, 'driftMinor': null,
          'needsExplanation': true, 'missingCreditId': _credit, 'windowStart': '2026-10-05T04:30:00.000Z'},
        {'seq': 1, 'kind': 'txn', 'on': '2026-10-05T04:30:00.000Z', 'transactionId': 't1', 'merchant': 'Zepto',
          'type': 'DEBIT', 'amountMinor': 50000, 'runningMinor': 950000, 'statedMinor': 950000, 'driftMinor': 0,
          'source': 'SMS'},
        {'seq': 0, 'kind': 'opening', 'on': '2026-09-30T18:30:00.000Z', 'runningMinor': 1000000,
          'statedMinor': 1000000, 'driftMinor': 0},
      ],
    };

// ---- A server ----------------------------------------------------------

typedef _Handler = http.Response Function(http.Request request);

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

MockClient _server(Map<String, Object> routes, List<http.Request> log) => MockClient((request) async {
      log.add(request);
      final path = request.url.path;
      for (final entry in routes.entries) {
        if (path.endsWith(entry.key)) {
          final value = entry.value;
          if (value is http.Response) return value;
          if (value is _Handler) return value(request);
          return _json(value);
        }
      }
      return _json([]);
    });

final _resolved = {
  'missingCredit': {..._missing, 'status': 'resolved'},
  'transaction': {
    'id': 'new', 'amountMinor': 500000, 'type': 'CREDIT', 'source': 'MANUAL', 'occurredAt': '2026-10-12T04:29:59.000Z',
  },
  'transferLeg': null,
};

Map<String, Object> _routes({bool canUndo = false}) => {
      '/accounts/missing-credits/$_credit/resolve': _resolved,
      '/accounts/missing-credits/$_credit/dismiss': {..._missing, 'status': 'dismissed'},
      '/accounts/missing-credits/$_credit': _missing,
      '/accounts/start-fresh': (http.Request request) =>
          request.method == 'POST' ? _json({'accounts': []}) : _json(_freshRows),
      '/accounts/$_federal/passbook': _passbook(canUndo: canUndo),
      '/accounts/$_federal/start-fresh/undo': {'accountId': _federal, 'canUndo': false},
      '/accounts/$_federal/start-fresh': {'accountId': _federal, 'note': null},
      '/accounts': _accounts,
      '/categories': [
        {'id': _freelance, 'name': 'Freelance', 'direction': 'IN', 'isSystem': false},
        {'id': '6ca000000000000000000002', 'name': 'Groceries', 'direction': 'OUT', 'isSystem': true},
      ],
      '/contacts': {
        'contacts': [
          {'id': _rahul, 'name': 'Rahul', 'balanceMinor': 500000},
        ],
      },
    };

List<http.Request> _posts(List<http.Request> log, String suffix) =>
    log.where((r) => r.method == 'POST' && r.url.path.endsWith(suffix)).toList();

Map<String, dynamic> _body(http.Request request) => jsonDecode(request.body) as Map<String, dynamic>;

/// 360 logical pixels wide; tall enough that nothing is lazily left out.
Future<void> _pump(WidgetTester tester, Widget home, {Brightness brightness = Brightness.light}) async {
  tester.view.physicalSize = const Size(1080, 4800);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: home));
}

Widget _sheetOpener() => Scaffold(
      body: Builder(
        builder: (context) => Center(
          child: TextButton(
            onPressed: () => showWhatCameInSheet(context, credit: MissingCredit.fromJson(_missing)),
            child: const Text('Open sheet'),
          ),
        ),
      ),
    );

Future<void> _openSheet(WidgetTester tester) async {
  await tester.tap(find.text('Open sheet'));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('models', () {
    test('a missing_credit to-do carries what the sheet needs, and statement_due its month', () {
      final data = DashboardData.fromJson({
        'todos': [
          {
            'kind': 'missing_credit', 'title': _missing['title'], 'body': 'What was it?', 'missingCreditId': _credit,
            'accountId': _federal, 'amountMinor': 500000, 'after': _missing['after'], 'before': _missing['before'],
            'suggestions': _missing['suggestions'],
          },
          {
            'kind': 'statement_due',
            'title': "Upload Federal Bank ••3295's statement for September to catch credits it didn't text you about",
            'body': 'x', 'accountId': _federal, 'month': '2026-09',
          },
        ],
      });
      expect(data.todos.map((t) => t.kind), ['missing_credit', 'statement_due']);
      final credit = data.todos.first.missingCredit!;
      expect(credit.id, _credit);
      expect(credit.amountMinor, 500000);
      expect(credit.suggestions.first.toBody(), {'as': 'transfer', 'fromAccountId': _hdfc});
      expect(data.todos.last.month, '2026-09');
    });

    test('the passbook reads the provisional row and the fresh-start flags', () {
      final page = PassbookPage.fromJson(_passbook(canUndo: true));
      expect(page.provisionalMinor, 500000);
      expect(page.account.canUndoFreshStart, isTrue);
      final row = page.rows[1];
      expect(row.isMissingCredit, isTrue);
      expect(row.isTransaction, isFalse);
      expect(row.missingCreditId, _credit);
      expect(row.windowStart, isNotNull);
    });

    test('a fresh-start row fills in only a figure the bank gave today', () {
      final rows = _freshRows.map(FreshStartAccount.fromJson).toList();
      expect(rows[0].prefillMinor, 1430000);
      expect(rows[1].prefillMinor, isNull);
      expect(rows[3].isSavings, isTrue);
    });
  });

  group('What came in?', () {
    testWidgets('shows the amount and window, and a suggestion answers in one tap', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, _sheetOpener());
        await _openSheet(tester);
        expect(find.text('What came in?'), findsOneWidget);
        expect(find.text('+₹5,000.00'), findsOneWidget);
        expect(find.text('₹5,000 came into Federal Bank ••5130 between 5 and 12 Oct'), findsOneWidget);
        expect(find.text('Most likely'), findsOneWidget);

        await tester.tap(find.text('From HDFC ••8342 — you sent ₹5,000 on 11 Oct'));
        await tester.pumpAndSettle();
        final sent = _posts(log, '/resolve');
        expect(sent, hasLength(1));
        expect(_body(sent.single), {'as': 'transfer', 'fromAccountId': _hdfc});
        expect(find.text('What came in?'), findsNothing);
      }, () => _server(_routes(), log));
    });

    testWidgets('salary, and dismissing', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, _sheetOpener());
        await _openSheet(tester);
        await tester.tap(find.text('Salary'));
        await tester.pumpAndSettle();
        expect(_body(_posts(log, '/resolve').single), {'as': 'salary'});

        await _openSheet(tester);
        await tester.tap(find.text('Not sure — dismiss'));
        await tester.pumpAndSettle();
        expect(_posts(log, '/dismiss'), hasLength(1));
      }, () => _server(_routes(), log));
    });

    testWidgets('from my other account offers only the others, bank and cash', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, _sheetOpener());
        await _openSheet(tester);
        await tester.tap(find.text('From my other account'));
        await tester.pumpAndSettle();
        expect(find.text('Which account did it come from?'), findsOneWidget);
        expect(find.text('Federal Bank ••5130'), findsNothing);
        expect(find.text('ICICI ••2009'), findsNothing);
        expect(find.text('Cash'), findsOneWidget);
        await tester.tap(find.text('HDFC ••8342'));
        await tester.pumpAndSettle();
        expect(_body(_posts(log, '/resolve').single), {'as': 'transfer', 'fromAccountId': _hdfc});
      }, () => _server(_routes(), log));
    });

    testWidgets('someone paid me back, through the People picker', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, _sheetOpener());
        await _openSheet(tester);
        await tester.tap(find.text('Someone paid me back'));
        await tester.pumpAndSettle();
        expect(find.text('Who was it with?'), findsOneWidget);
        await tester.tap(find.text('Rahul').last);
        await tester.pumpAndSettle();
        expect(_body(_posts(log, '/resolve').single), {'as': 'paid_back', 'contactId': _rahul});
      }, () => _server(_routes(), log));
    });

    testWidgets('other income, in a category for money in', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, _sheetOpener());
        await _openSheet(tester);
        await tester.tap(find.text('Other income'));
        await tester.pumpAndSettle();
        expect(find.text('Groceries'), findsNothing);
        await tester.tap(find.text('Freelance'));
        await tester.pumpAndSettle();
        expect(_body(_posts(log, '/resolve').single), {'as': 'income', 'categoryId': _freelance});
      }, () => _server(_routes(), log));
    });
  });

  group('Start fresh from today', () {
    testWidgets('skips empty accounts, keeps savings masked, and posts the batch', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const StartFreshScreen());
        await tester.pumpAndSettle();

        expect(find.textContaining('Only the balances start again from these figures'), findsOneWidget);
        // Federal's figure from today is filled in; HDFC's from the 10th is not.
        expect(find.text('14300.00'), findsOneWidget);
        expect(find.text("From the bank's message today"), findsOneWidget);
        // Savings: nothing shown until tapped.
        expect(find.text('₹ • • • •'), findsOneWidget);
        expect(find.textContaining('9,87,654'), findsNothing);
        expect(find.byKey(const ValueKey('input-$_savings')), findsNothing);
        await tester.tap(find.byKey(const ValueKey('reveal-$_savings')));
        await tester.pumpAndSettle();
        expect(find.textContaining('9,87,654'), findsOneWidget);
        expect(find.byKey(const ValueKey('input-$_savings')), findsOneWidget);

        await tester.enterText(find.byKey(const ValueKey('input-$_cash')), '1,150');
        await tester.pumpAndSettle();
        await tester.tap(find.text('Start 2 accounts fresh'));
        await tester.pumpAndSettle();
        expect(find.text('Start 2 accounts fresh?'), findsOneWidget);
        await tester.tap(find.widgetWithText(FilledButton, 'Start fresh'));
        await tester.pumpAndSettle();

        final sent = _posts(log, '/accounts/start-fresh');
        expect(sent, hasLength(1));
        expect(_body(sent.single), {
          'accounts': [
            {'accountId': _federal, 'balanceMinor': 1430000},
            {'accountId': _cash, 'balanceMinor': 115000},
          ],
        });
        expect(tester.takeException(), isNull);
      }, () => _server(_routes(), log));
    });
  });

  group('passbook', () {
    testWidgets('the amber row opens What came in?, and the header says what is provisional', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const PassbookScreen(accountId: _federal));
        await tester.pumpAndSettle();
        expect(find.text('Includes ₹5,000.00 not yet explained'), findsOneWidget);
        expect(find.text('Came in without a text'), findsOneWidget);
        expect(find.text('+₹5,000.00'), findsOneWidget);
        expect(find.textContaining('between 5 Oct and 12 Oct'), findsOneWidget);
        expect(find.text('Starting balance'), findsOneWidget);

        await tester.tap(find.text('Came in without a text'));
        await tester.pumpAndSettle();
        expect(find.text('What came in?'), findsOneWidget);
        expect(log.where((r) => r.method == 'GET' && r.url.path.endsWith('/missing-credits/$_credit')), hasLength(1));
      }, () => _server(_routes(), log));
    });

    testWidgets('undo is offered only once there is a fresh start to undo', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const PassbookScreen(accountId: _federal));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('passbook-menu')));
        await tester.pumpAndSettle();
        expect(find.text('Start fresh from today'), findsOneWidget);
        expect(find.text('Undo fresh start'), findsNothing);
      }, () => _server(_routes(), log));
    });

    testWidgets('after a fresh start the opening says so, and undo posts', (tester) async {
      final undoLog = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const PassbookScreen(accountId: _federal));
        await tester.pumpAndSettle();
        expect(find.textContaining('Started fresh on'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('passbook-menu')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Undo fresh start'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Undo'));
        await tester.pumpAndSettle();
        expect(_posts(undoLog, '/start-fresh/undo'), hasLength(1));
      }, () => _server(_routes(canUndo: true), undoLog));
    });

    testWidgets('start fresh for this account posts what the bank shows now', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const PassbookScreen(accountId: _federal));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('passbook-menu')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Start fresh from today'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField).last, '14,000');
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Start fresh'));
        await tester.pumpAndSettle();
        expect(_body(_posts(log, '/accounts/$_federal/start-fresh').single), {'balanceMinor': 1400000});
      }, () => _server(_routes(), log));
    });
  });

  group('account edit sheet', () {
    Widget opener(Account account) => Scaffold(
          body: Builder(
            builder: (context) => Center(
              child: TextButton(
                onPressed: () => showEditAccountSheet(context, account: account, accounts: [account]),
                child: const Text('Edit'),
              ),
            ),
          ),
        );

    Account federal({bool suggest = true, bool on = false}) => Account.fromJson({
          ..._account(_federal, 'Federal Bank', '3295', 'BANK'),
          'noCreditAlerts': on,
          'suggestNoCreditAlerts': suggest,
          'textMessages': {'debits': 28, 'credits': 1, 'days': 90},
        });

    testWidgets('suggests the setting from the texts, and saves the toggle', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        tester.view.physicalSize = const Size(1440, 6000);
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: opener(federal())));
        await tester.tap(find.text('Edit'));
        await tester.pumpAndSettle();

        expect(find.text("This bank doesn't text me about money coming in"), findsOneWidget);
        expect(find.text("We've seen 28 debits and 1 credit by text in 90 days — turn this on?"), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('no-credit-alerts')));
        await tester.pumpAndSettle();
        // On now: the hint has done its job.
        expect(find.textContaining("We've seen"), findsNothing);
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();
        final patch = log.where((r) => r.method == 'PATCH' && r.url.path.endsWith('/accounts/$_federal')).single;
        expect(_body(patch)['noCreditAlerts'], isTrue);
      }, () => MockClient((request) async {
            log.add(request);
            return _json(_account(_federal, 'Federal Bank', '3295', 'BANK'));
          }));
    });

    testWidgets('no hint without the suggestion', (tester) async {
      await http.runWithClient(() async {
        tester.view.physicalSize = const Size(1440, 6000);
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: opener(federal(suggest: false))));
        await tester.tap(find.text('Edit'));
        await tester.pumpAndSettle();
        expect(find.text("This bank doesn't text me about money coming in"), findsOneWidget);
        expect(find.textContaining("We've seen"), findsNothing);
      }, () => MockClient((request) async => _json({})));
    });
  });

  group('at 360 wide', () {
    for (final brightness in Brightness.values) {
      testWidgets('nothing overflows ($brightness)', (tester) async {
        final log = <http.Request>[];
        await http.runWithClient(() async {
          await _pump(tester, _sheetOpener(), brightness: brightness);
          await _openSheet(tester);
          expect(tester.takeException(), isNull);

          await _pump(tester, const StartFreshScreen(), brightness: brightness);
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);

          await _pump(tester, const PassbookScreen(accountId: _federal, key: ValueKey('wide')), brightness: brightness);
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
        }, () => _server(_routes(canUndo: true), log));
      });
    }
  });
}
