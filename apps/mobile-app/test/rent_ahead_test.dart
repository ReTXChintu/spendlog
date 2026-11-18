import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';

/// Pay on the 15th. Rent of ₹11,500: Chirayu and Harshang pay back ₹4,000
/// each, Sapan ₹3,000. The editor is opened while the month that began on
/// 15 October is still the current one.
const _rent = {
  'id': 'rent',
  'name': 'Rent',
  'amountMinor': 1150000,
  'thisPeriodAmountMinor': 50000,
  'fullAmountMinor': 1150000,
  'periodKey': '2026-10-15',
  'dayOfMonth': 22,
  'shares': [
    {'contactId': 'chirayu', 'amountMinor': 400000},
    {'contactId': 'harshang', 'amountMinor': 400000},
    {'contactId': 'sapan', 'amountMinor': 300000},
  ],
  'shareStatus': [
    {'contactId': 'chirayu', 'name': 'Chirayu', 'amountMinor': 400000, 'paidMinor': 0},
    {'contactId': 'harshang', 'name': 'Harshang', 'amountMinor': 400000, 'paidMinor': 0},
    {'contactId': 'sapan', 'name': 'Sapan', 'amountMinor': 300000, 'paidMinor': 0},
  ],
};

/// 13 November is still the October month's; the one it is for opens on
/// the 15th.
const _around = {
  'bySalary': true,
  'month': {'month': '2026-10', 'from': '2026-10-15', 'to': '2026-11-14', 'label': '15 Oct – 14 Nov'},
  'next': {'month': '2026-11', 'from': '2026-11-15', 'to': '2026-12-14', 'label': '15 Nov – 14 Dec'},
};

MockClient _server(List<Map<String, dynamic>> patches) => MockClient((request) async {
      final path = request.url.path;
      if (request.method == 'PATCH') {
        patches.add(jsonDecode(request.body) as Map<String, dynamic>);
        return http.Response('{}', 200);
      }
      if (path.endsWith('/budget/commitments')) return http.Response(jsonEncode([_rent]), 200);
      if (path.endsWith('/months-around')) {
        // A month's label holds an en dash, which Latin-1 cannot carry.
        return http.Response.bytes(
          utf8.encode(jsonEncode(_around)),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }
      if (path.endsWith('/contacts')) {
        return http.Response(
          jsonEncode({
            'contacts': [
              {'id': 'chirayu', 'name': 'Chirayu'},
              {'id': 'harshang', 'name': 'Harshang'},
              {'id': 'sapan', 'name': 'Sapan'},
            ],
          }),
          200,
        );
      }
      if (path.endsWith('/subscriptions')) return http.Response('{"items": [], "totals": {}}', 200);
      if (path.endsWith('/deposits')) return http.Response('{"deposits": []}', 200);
      return http.Response('[]', 200);
    });

Transaction _moneyBack(String who, int amountMinor, {String? countInMonth, List<Map<String, dynamic>>? towards}) =>
    Transaction.fromJson({
      'id': 't-$who',
      'amountMinor': amountMinor,
      'type': 'CREDIT',
      'merchant': who,
      'source': 'SMS',
      'occurredAt': '2026-11-13T05:00:00.000Z',
      'isSettlement': true,
      'countInMonth': countInMonth,
      'people': [
        {'contactId': who, 'amountMinor': amountMinor},
      ],
      if (towards != null) 'towards': towards,
    });

Future<void> _open(WidgetTester tester, Transaction transaction) async {
  tester.view.physicalSize = const Size(1440, 3200);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: buildTheme(Brightness.light),
    home: Scaffold(
      body: Builder(
        builder: (context) => TextButton(
          onPressed: () => showEditTransactionSheet(context, transaction: transaction, categories: const [], accounts: const []),
          child: const Text('Open'),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<void> _type(WidgetTester tester, String key, String text) async {
  final box = find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(TextField));
  await tester.ensureVisible(box);
  await tester.enterText(box, text);
  await tester.pumpAndSettle();
}

Future<void> _save(WidgetTester tester) => _tap(tester, find.text('Save'));

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group("Chirayu's ₹4,960: ₹4,000 rent, ₹960 Splitwise", () {
    testWidgets('puts the rent towards rent and the rest down to Splitwise', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _moneyBack('chirayu', 496000));
        await _tap(tester, find.byKey(const ValueKey('splitwise-chirayu')));
        await _type(tester, 'splitwise-amount-chirayu', '960');
        await _tap(tester, find.byKey(const ValueKey('towards-fill-rent:chirayu')));
        expect(find.textContaining("All of Chirayu's goes to that and ₹960.00 to Splitwise."), findsOneWidget);
        await _save(tester);
      }, () => _server(patches));

      final patch = patches.single;
      expect(patch['people'], [
        {'contactId': 'chirayu', 'amountMinor': 496000, 'elsewhereMinor': 96000},
      ]);
      expect((patch['towards'] as List).single['amountMinor'], 400000);
    });

    testWidgets('a row already split that way opens showing it', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(
          tester,
          Transaction.fromJson({
            'id': 't1', 'amountMinor': 496000, 'type': 'CREDIT', 'source': 'SMS',
            'occurredAt': '2026-11-13T05:00:00.000Z', 'isSettlement': true,
            'people': [{'contactId': 'chirayu', 'amountMinor': 496000, 'elsewhereMinor': 96000}],
          }),
        );
        expect(find.text('Settled in Splitwise'), findsOneWidget);
        await _save(tester);
      }, () => _server(patches));

      expect((patches.single['people'] as List).single['elsewhereMinor'], 96000);
    });

    testWidgets('refuses more down to Splitwise than came from him', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _moneyBack('chirayu', 496000));
        await _tap(tester, find.byKey(const ValueKey('splitwise-chirayu')));
        await _type(tester, 'splitwise-amount-chirayu', '6000');
        expect(find.textContaining("That's more than Chirayu's"), findsOneWidget);
        await _save(tester);
        expect(find.textContaining('put down to Splitwise'), findsWidgets);
      }, () => _server(patches));

      expect(patches, isEmpty);
    });
  });

  group("Harshang's rent, sent before pay day", () {
    testWidgets('sent on to next month, it is next month\'s rent', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _moneyBack('harshang', 400000));
        await _tap(tester, find.byKey(const ValueKey('towards-fill-rent:harshang')));
        await _tap(tester, find.byKey(const ValueKey('count-next-month')));
        await _save(tester);
      }, () => _server(patches));

      final patch = patches.single;
      expect(patch['countInMonth'], '2026-11');
      expect(patch['towards'], [
        {'commitmentId': 'rent', 'contactId': 'harshang', 'periodKey': '2026-11-15', 'amountMinor': 400000},
      ]);
    });

    testWidgets('brought back to its own month, it is that month\'s rent again', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(
          tester,
          _moneyBack('harshang', 400000, countInMonth: '2026-11', towards: [
            {'commitmentId': 'rent', 'contactId': 'harshang', 'periodKey': '2026-11-15', 'amountMinor': 400000},
          ]),
        );
        await _tap(tester, find.byKey(const ValueKey('count-next-month')));
        await _save(tester);
      }, () => _server(patches));

      final patch = patches.single;
      expect(patch['countInMonth'], isNull);
      expect((patch['towards'] as List).single['periodKey'], '2026-10-15');
    });
  });
}
