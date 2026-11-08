import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/savings_goals_screen.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';
import 'package:spendlog/widgets/home/savings_goals_tile.dart';

const _ps5 = {
  'id': 'ps5', 'name': 'PS5', 'targetMinor': 5500000, 'targetOn': '2027-10-01', 'accountId': 'sbi',
  'accountLabel': 'SBI ••1234', 'isActive': true, 'savedMinor': 1500000, 'leftMinor': 4000000, 'monthsLeft': 11,
  'perMonthMinor': 363700, 'percent': 27.3, 'isDone': false, 'addedThisMonthMinor': 1000000,
};
const _trip = {
  'id': 'trip', 'name': 'Goa trip', 'targetMinor': 2000000, 'targetOn': '2027-01-15', 'isActive': true,
  'savedMinor': 2000000, 'leftMinor': 0, 'monthsLeft': 3, 'perMonthMinor': 0, 'percent': 100, 'isDone': true,
};
const _list = {'goals': [_ps5, _trip], 'savedMinor': 3500000, 'perMonthMinor': 363700};

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

MockClient _server(List<http.Request> requests, {Object goals = _list}) => MockClient((request) async {
      requests.add(request);
      final path = request.url.path;
      if (path.endsWith('/savings-goals') && request.method == 'GET') return _json(goals);
      if (path.endsWith('/entries')) {
        return http.Response(
          jsonEncode({
            'entries': [
              {'kind': 'TRANSFER', 'transactionId': 't1', 'label': 'To savings', 'on': '2026-11-02T10:00:00.000Z', 'amountMinor': 800000},
              {'kind': 'BY_HAND', 'label': 'Birthday money', 'on': '2026-11-05T10:00:00.000Z', 'amountMinor': 200000},
            ],
            'openingMinor': 500000,
          }),
          200,
        );
      }
      if (request.method == 'POST') return http.Response('{}', 201);
      if (request.method == 'PATCH') return http.Response('{}', 200);
      if (path.endsWith('/accounts')) {
        return http.Response(
          jsonEncode([
            {'id': 'sbi', 'bankName': 'SBI', 'last4': '1234', 'accountType': 'BANK', 'isSavings': true, 'isActive': true},
            {'id': 'hdfc', 'bankName': 'HDFC', 'last4': '9988', 'accountType': 'BANK', 'isActive': true},
          ]),
          200,
        );
      }
      return http.Response(path.endsWith('/contacts') ? '{"contacts": []}' : '[]', 200);
    });

Future<void> _phone(WidgetTester tester, Widget home, {Brightness brightness = Brightness.light, double width = 1080, double height = 2400}) async {
  tester.view.physicalSize = Size(width, height);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: home));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('reads goals, a row\'s parts for them, and what of an account is for goals', () {
    final list = SavingsGoalList.fromJson(_list);
    expect(list.open.map((g) => g.name), ['PS5', 'Goa trip']);
    expect(list.goals.first.perMonthMinor, 363700);
    expect(list.goals.last.isDone, isTrue);
    expect(SavingsGoalList.fromJson(null).isEmpty, isTrue);

    final row = Transaction.fromJson({
      'id': 't1', 'amountMinor': 1000000, 'type': 'CREDIT', 'source': 'SMS', 'occurredAt': '2026-11-02T10:00:00.000Z',
      'goalParts': [{'goalId': 'ps5', 'amountMinor': 800000}],
    });
    expect(row.goalParts, {'ps5': 800000});
    expect(BankFace.fromJson({'accountId': 'sbi', 'name': 'SBI', 'forGoalsMinor': 1500000}).forGoalsMinor, 1500000);
    expect(DashboardData.fromJson({'savingsGoals': _list}).savingsGoals.savedMinor, 3500000);
  });

  group('the savings goals screen', () {
    testWidgets('shows each goal with what it has and needs a month', (tester) async {
      await http.runWithClient(() async {
        await _phone(tester, const SavingsGoalsScreen());
      }, () => _server([]));

      expect(find.text('PS5'), findsOneWidget);
      expect(find.text('₹3,637.00 a month · 11 months left'), findsOneWidget);
      expect(find.text('₹15,000.00 of ₹55,000.00'), findsOneWidget);
      expect(find.textContaining('in SBI ••1234'), findsOneWidget);
      expect(find.text('Ready'), findsOneWidget);
    });

    testWidgets('adds a goal, kept in the savings account by default', (tester) async {
      final requests = <http.Request>[];
      final server = _server(requests, goals: const {'goals': [], 'savedMinor': 0, 'perMonthMinor': 0});
      await http.runWithClient(() async {
        await _phone(tester, const SavingsGoalsScreen());
        await tester.tap(find.text('Add a goal'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byKey(const ValueKey('savings-goal-name')), 'PS5');
        await tester.enterText(find.byKey(const ValueKey('savings-goal-target')), '55000');
        await tester.enterText(find.byKey(const ValueKey('savings-goal-opening')), '5000');
        await tester.tap(find.text('Pick a date'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('OK'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Add goal'));
        await tester.pumpAndSettle();
      }, () => server);

      final body = jsonDecode(requests.where((r) => r.method == 'POST').single.body) as Map<String, dynamic>;
      expect(body['name'], 'PS5');
      expect(body['targetMinor'], 5500000);
      expect(body['openingMinor'], 500000);
      expect(body['accountId'], 'sbi');
      expect(body['targetOn'], matches(RegExp(r'^\d{4}-\d{2}-\d{2}$')));
    });

    testWidgets('a goal up close lists what went in, and adds money by hand', (tester) async {
      final requests = <http.Request>[];
      final server = _server(requests);
      await http.runWithClient(() async {
        // Tall enough for the whole sheet.
        await _phone(tester, const SavingsGoalsScreen(), height: 4200);
        await tester.tap(find.text('PS5'));
        await tester.pumpAndSettle();
        expect(find.text('Birthday money'), findsOneWidget);
        expect(find.text('Already put aside at the start'), findsOneWidget);
        await tester.tap(find.text('Add money'));
        await tester.pumpAndSettle();
        // Offered what a month needs.
        expect(find.widgetWithText(TextField, '3637'), findsOneWidget);
        await tester.tap(find.widgetWithText(FilledButton, 'Add'));
        await tester.pumpAndSettle();
      }, () => server);

      final post = requests.where((r) => r.method == 'POST').single;
      expect(post.url.path, endsWith('/savings-goals/ps5/adjustments'));
      expect(jsonDecode(post.body)['amountMinor'], 363700);
    });

    for (final brightness in Brightness.values) {
      testWidgets('fits a 360 px phone (${brightness.name})', (tester) async {
        await http.runWithClient(() async {
          await _phone(tester, const SavingsGoalsScreen(), brightness: brightness);
          expect(tester.takeException(), isNull);
          await _phone(
            tester,
            Scaffold(
              body: ListView(children: [
                SavingsGoalsTile(goals: SavingsGoalList.fromJson(_list), onTap: () {}),
                SavingsGoalsTile(goals: const SavingsGoalList(), onTap: () {}),
              ]),
            ),
            brightness: brightness,
          );
          expect(tester.takeException(), isNull);
        }, () => _server([]));
      });
    }
  });

  group('a transfer into savings', () {
    Future<void> open(WidgetTester tester, Transaction transaction) async {
      await _phone(
        tester,
        Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showEditTransactionSheet(context, transaction: transaction, categories: const [], accounts: const []),
              child: const Text('Open'),
            ),
          ),
        ),
        width: 1440,
      );
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
    }

    Future<void> save(WidgetTester tester) async {
      await tester.ensureVisible(find.text('Save'));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
    }

    testWidgets('is marked for a goal, and sends the part', (tester) async {
      final requests = <http.Request>[];
      final server = _server(requests);
      await http.runWithClient(() async {
        await open(
          tester,
          Transaction.fromJson({
            'id': 't1', 'amountMinor': 1000000, 'type': 'CREDIT', 'isTransfer': true, 'source': 'SMS',
            'occurredAt': '2026-11-02T10:00:00.000Z',
          }),
        );
        await tester.ensureVisible(find.byKey(const ValueKey('for-a-goal')));
        await tester.tap(find.byKey(const ValueKey('for-a-goal')));
        await tester.pumpAndSettle();
        await tester.enterText(
          find.descendant(of: find.byKey(const ValueKey('goal-part-ps5')), matching: find.byType(TextField)),
          '8000',
        );
        await tester.pumpAndSettle();
        expect(find.text('₹8,000.00 of ₹10,000.00 is for goals.'), findsOneWidget);
        await save(tester);
      }, () => server);

      final patch = jsonDecode(requests.where((r) => r.method == 'PATCH').single.body) as Map<String, dynamic>;
      expect(patch['goalParts'], [
        {'goalId': 'ps5', 'amountMinor': 800000},
      ]);
    });

    testWidgets('a plain payment is not offered it', (tester) async {
      await http.runWithClient(() async {
        await open(
          tester,
          Transaction.fromJson({
            'id': 't2', 'amountMinor': 50000, 'type': 'DEBIT', 'merchant': 'Swiggy', 'source': 'SMS',
            'occurredAt': '2026-11-02T10:00:00.000Z',
          }),
        );
        expect(find.byKey(const ValueKey('for-a-goal')), findsNothing);
      }, () => _server([]));
    });
  });
}
