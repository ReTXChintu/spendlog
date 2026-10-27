import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/deposit_models.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/investments/deposits_tab.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';

const _list = {
  'deposits': [
    {'id': 'rd1', 'name': 'RD 1', 'kind': 'RD', 'institution': 'Tiki Tripathy', 'monthlyMinor': 200000, 'isActive': true, 'totalMinor': 4200000, 'addedThisMonthMinor': 200000},
    {'id': 'rd2', 'name': 'RD 2', 'kind': 'RD', 'institution': 'Tiki Tripathy', 'monthlyMinor': 100000, 'isActive': true, 'totalMinor': 1300000, 'addedThisMonthMinor': 0},
    {'id': 'fd1', 'name': 'Old FD', 'kind': 'FD', 'isActive': false, 'totalMinor': 5000000},
  ],
  'totalMinor': 5500000,
  'monthlyMinor': 300000,
};

/// Deposits as listed, everything else the editor asks for empty, and every
/// request kept.
MockClient _server(List<http.Request> requests, {Object deposits = _list}) => MockClient((request) async {
      requests.add(request);
      final path = request.url.path;
      if (path.endsWith('/deposits') && request.method == 'GET') return http.Response(jsonEncode(deposits), 200);
      if (request.method == 'POST' && path.endsWith('/deposits')) return http.Response('{}', 201);
      if (request.method == 'PATCH') return http.Response('{}', 200);
      if (path.endsWith('/payments')) return http.Response('[]', 200);
      return http.Response(path.endsWith('/contacts') ? '{"contacts": []}' : '[]', 200);
    });

Future<void> _phone(WidgetTester tester, Widget home, {Brightness brightness = Brightness.light, double width = 1080}) async {
  tester.view.physicalSize = Size(width, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: home));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('reads deposits, and a payment\'s parts in them', () {
    final list = DepositList.fromJson(_list);
    expect(list.deposits.map((d) => d.name), ['RD 1', 'RD 2', 'Old FD']);
    expect(list.active.length, 2);
    expect(list.deposits[0].subtitle, 'RD · Tiki Tripathy');
    expect(list.deposits[2].monthlyMinor, isNull);
    expect(DepositList.fromJson(const {}).isEmpty, isTrue);

    final payment = Transaction.fromJson({
      'id': 't1', 'amountMinor': 300000, 'type': 'DEBIT', 'source': 'SMS', 'occurredAt': '2026-10-15T15:39:00.000Z',
      'depositParts': [{'depositId': 'rd1', 'amountMinor': 200000}, {'depositId': 'rd2', 'amountMinor': 100000}],
    });
    expect(payment.depositParts, {'rd1': 200000, 'rd2': 100000});
  });

  group('the deposits tab', () {
    testWidgets('lists each with its total, and the open ones together', (tester) async {
      await http.runWithClient(() async {
        await _phone(tester, const Scaffold(body: DepositsTab()));
      }, () => _server([]));

      expect(find.text('RD 1'), findsOneWidget);
      expect(find.text('₹55,000.00'), findsOneWidget);
      expect(find.textContaining('₹2,000.00 in this month'), findsOneWidget);
      expect(find.textContaining('nothing in yet this month'), findsOneWidget);
      expect(find.textContaining('Closed'), findsOneWidget);
    });

    testWidgets('says what it is for when there are none, and adds one', (tester) async {
      final requests = <http.Request>[];
      final server = _server(requests, deposits: const {'deposits': [], 'totalMinor': 0, 'monthlyMinor': 0});
      await http.runWithClient(() async {
        await _phone(tester, const Scaffold(body: DepositsTab()));
        expect(find.text('Track your RDs and FDs'), findsOneWidget);
        await tester.tap(find.text('Add a deposit'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byKey(const ValueKey('deposit-name')), 'Post office RD');
        await tester.enterText(find.byKey(const ValueKey('deposit-total')), '40000');
        await tester.enterText(find.byKey(const ValueKey('deposit-monthly')), '2000');
        await tester.tap(find.text('Add deposit'));
        await tester.pumpAndSettle();
      }, () => server);

      final body = jsonDecode(requests.where((r) => r.method == 'POST').single.body) as Map<String, dynamic>;
      expect(body, {'name': 'Post office RD', 'institution': null, 'monthlyMinor': 200000, 'kind': 'RD', 'totalMinor': 4000000});
    });

    for (final brightness in Brightness.values) {
      testWidgets('fits a 360 px phone (${brightness.name})', (tester) async {
        await http.runWithClient(() async {
          await _phone(tester, const Scaffold(body: DepositsTab()), brightness: brightness);
          expect(tester.takeException(), isNull);
        }, () => _server([]));
      });
    }
  });

  group('a payment into RDs', () {
    Transaction agent({Map<String, dynamic> extra = const {}}) => Transaction.fromJson({
          'id': 't1',
          'amountMinor': 300000,
          'type': 'DEBIT',
          'merchant': 'TIKI TRIPATH',
          'source': 'SMS',
          'occurredAt': '2026-10-15T15:39:00.000Z',
          ...extra,
        });

    Future<void> open(WidgetTester tester, Transaction transaction) async {
      // Wider than a phone, as the other sheet tests open it.
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

    testWidgets('splits one payment across two, and sends the parts', (tester) async {
      final requests = <http.Request>[];
      await http.runWithClient(() async {
        await open(tester, agent());
        await tester.ensureVisible(find.text('Into RD/FD'));
        await tester.tap(find.text('Into RD/FD'));
        await tester.pumpAndSettle();
        // A closed one is not offered.
        expect(find.text('Old FD'), findsNothing);
        await tester.enterText(find.descendant(of: find.byKey(const ValueKey('deposit-part-rd1')), matching: find.byType(TextField)), '2000');
        await tester.enterText(find.descendant(of: find.byKey(const ValueKey('deposit-part-rd2')), matching: find.byType(TextField)), '1000');
        await tester.pumpAndSettle();
        expect(find.text('All of it goes into deposits.'), findsOneWidget);
        await save(tester);
      }, () => _server(requests));

      final patch = jsonDecode(requests.where((r) => r.method == 'PATCH').single.body) as Map<String, dynamic>;
      expect(patch['depositParts'], [
        {'depositId': 'rd1', 'amountMinor': 200000},
        {'depositId': 'rd2', 'amountMinor': 100000},
      ]);
    });

    testWidgets('will not put more in than the payment', (tester) async {
      final requests = <http.Request>[];
      await http.runWithClient(() async {
        await open(tester, agent());
        await tester.ensureVisible(find.text('Into RD/FD'));
        await tester.tap(find.text('Into RD/FD'));
        await tester.pumpAndSettle();
        await tester.enterText(find.descendant(of: find.byKey(const ValueKey('deposit-part-rd1')), matching: find.byType(TextField)), '3500');
        await tester.pumpAndSettle();
        await save(tester);
      }, () => _server(requests));

      expect(requests.where((r) => r.method == 'PATCH'), isEmpty);
      expect(find.textContaining('more than the payment'), findsWidgets);
    });

    testWidgets('opens on the parts saved, and turning it off takes them out', (tester) async {
      final requests = <http.Request>[];
      await http.runWithClient(() async {
        await open(tester, agent(extra: {
          'depositParts': [{'depositId': 'rd1', 'amountMinor': 200000}, {'depositId': 'rd2', 'amountMinor': 100000}],
        }));
        await tester.ensureVisible(find.byKey(const ValueKey('deposit-part-rd2')));
        expect(find.text('All of it goes into deposits.'), findsOneWidget);
        await tester.ensureVisible(find.text('Into RD/FD'));
        await tester.tap(find.text('Into RD/FD'));
        await tester.pumpAndSettle();
        await save(tester);
      }, () => _server(requests));

      final patch = jsonDecode(requests.where((r) => r.method == 'PATCH').single.body) as Map<String, dynamic>;
      expect(patch['depositParts'], isEmpty);
    });
  });
}
