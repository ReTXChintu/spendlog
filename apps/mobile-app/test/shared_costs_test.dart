import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';

/// Rent of ₹11,500: Chirayu and Harshang pay back ₹4,000 each, Sapan
/// ₹3,000, and ₹500 is the user's.
const _rent = {
  'id': 'rent',
  'name': 'Rent',
  'amountMinor': 1150000,
  'thisPeriodAmountMinor': 50000,
  'fullAmountMinor': 1150000,
  'periodKey': '2026-10-15',
  'dayOfMonth': 22,
  'merchant': 'PALIVAL BHAV',
  'shares': [
    {'contactId': 'chirayu', 'amountMinor': 400000},
    {'contactId': 'harshang', 'amountMinor': 400000},
    {'contactId': 'sapan', 'amountMinor': 300000},
  ],
  'shareStatus': [
    {'contactId': 'chirayu', 'name': 'Chirayu', 'amountMinor': 400000, 'paidMinor': 0},
    {'contactId': 'harshang', 'name': 'Harshang', 'amountMinor': 400000, 'paidMinor': 400000},
    {'contactId': 'sapan', 'name': 'Sapan', 'amountMinor': 300000, 'paidMinor': 100000},
  ],
};

MockClient _server(List<http.Request> requests) => MockClient((request) async {
      requests.add(request);
      final path = request.url.path;
      if (request.method == 'PATCH') return http.Response('{}', 200);
      if (path.endsWith('/budget/commitments')) return http.Response(jsonEncode([_rent]), 200);
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
      if (path.endsWith('/deposits')) return http.Response('{"deposits": []}', 200);
      return http.Response('[]', 200);
    });

Future<void> _open(WidgetTester tester, Transaction transaction) async {
  // Wider than a phone, as the other sheet tests open it.
  tester.view.physicalSize = const Size(1440, 2600);
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

Future<void> _save(WidgetTester tester) async {
  await tester.ensureVisible(find.text('Save'));
  await tester.tap(find.text('Save'));
  await tester.pumpAndSettle();
}

Map<String, dynamic> _patchOf(List<http.Request> requests) =>
    jsonDecode(requests.where((r) => r.method == 'PATCH').single.body) as Map<String, dynamic>;

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('reads a fixed cost others pay back for, and each one\'s status', () {
    final rent = FixedCommitment.fromJson(_rent);
    expect(rent.isShared, isTrue);
    expect(rent.othersMinor, 1100000);
    expect(rent.thisPeriodAmountMinor, 50000);
    expect(rent.shareStatus[1].isPaid, isTrue);
    expect(rent.shareStatus[2].dueMinor, 200000);
    expect(FixedCommitment.fromJson({..._rent, 'shares': null, 'shareStatus': null}).isShared, isFalse);
  });

  testWidgets('picking rent as the fixed cost splits the payment its way', (tester) async {
    final requests = <http.Request>[];
    await http.runWithClient(() async {
      await _open(
        tester,
        Transaction.fromJson({
          'id': 't1', 'amountMinor': 1150000, 'type': 'DEBIT', 'merchant': 'PALIVAL BHAV', 'source': 'SMS',
          'occurredAt': '2026-10-22T04:06:00.000Z',
        }),
      );
      await tester.ensureVisible(find.text('Fixed cost'));
      await tester.tap(find.text('Fixed cost'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Which fixed cost?'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Rent - ').last);
      await tester.pumpAndSettle();
      await _save(tester);
    }, () => _server(requests));

    final patch = _patchOf(requests);
    expect(patch['commitmentId'], 'rent');
    expect(patch['split']['myShareMinor'], 50000);
    expect(
      {for (final p in patch['people'] as List) p['contactId']: p['amountMinor']},
      {'chirayu': 400000, 'harshang': 400000, 'sapan': 300000},
    );
  });

  testWidgets('money paid back is put towards rent, the rest left to splits', (tester) async {
    final requests = <http.Request>[];
    await http.runWithClient(() async {
      await _open(
        tester,
        Transaction.fromJson({
          'id': 't2', 'amountMinor': 600000, 'type': 'CREDIT', 'merchant': 'Chirayu', 'source': 'SMS',
          'occurredAt': '2026-10-23T05:00:00.000Z', 'isSettlement': true,
          'people': [{'contactId': 'chirayu', 'amountMinor': 600000}],
        }),
      );
      await tester.ensureVisible(find.text('What was it for?'));
      expect(find.text('Rent · Chirayu'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('towards-fill-rent:chirayu')));
      await tester.pumpAndSettle();
      expect(find.textContaining("The rest of Chirayu's, ₹2,000.00, is for other splits."), findsOneWidget);
      await _save(tester);
    }, () => _server(requests));

    final patch = _patchOf(requests);
    expect(patch['towards'], [
      {'commitmentId': 'rent', 'contactId': 'chirayu', 'periodKey': '2026-10-15', 'amountMinor': 400000},
    ]);
  });

  testWidgets('a part saved before keeps the period it was for', (tester) async {
    final requests = <http.Request>[];
    await http.runWithClient(() async {
      await _open(
        tester,
        Transaction.fromJson({
          'id': 't3', 'amountMinor': 400000, 'type': 'CREDIT', 'source': 'SMS', 'occurredAt': '2026-10-14T05:00:00.000Z',
          'isSettlement': true,
          'people': [{'contactId': 'chirayu', 'amountMinor': 400000}],
          'towards': [{'commitmentId': 'rent', 'contactId': 'chirayu', 'periodKey': '2026-09-15', 'amountMinor': 400000}],
        }),
      );
      await _save(tester);
    }, () => _server(requests));

    expect(_patchOf(requests)['towards'], [
      {'commitmentId': 'rent', 'contactId': 'chirayu', 'periodKey': '2026-09-15', 'amountMinor': 400000},
    ]);
  });
}
