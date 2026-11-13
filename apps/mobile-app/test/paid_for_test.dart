import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';

final _gifting = Category.fromJson({'id': 'gift', 'name': 'Gifting', 'direction': 'OUT', 'isSystem': true});

MockClient _server(List<http.Request> requests) => MockClient((request) async {
      requests.add(request);
      if (request.method == 'PATCH') return http.Response('{}', 200);
      final path = request.url.path;
      if (path.endsWith('/contacts')) {
        return http.Response(jsonEncode({'contacts': [{'id': 'rahul', 'name': 'Rahul'}, {'id': 'mum', 'name': 'Mum'}]}), 200);
      }
      if (path.endsWith('/deposits')) return http.Response('{"deposits": []}', 200);
      return http.Response('[]', 200);
    });

Future<void> _open(WidgetTester tester, Transaction transaction, {List<Category> categories = const []}) async {
  tester.view.physicalSize = const Size(1440, 2600);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: buildTheme(Brightness.light),
    home: Scaffold(
      body: Builder(
        builder: (context) => TextButton(
          onPressed: () => showEditTransactionSheet(context, transaction: transaction, categories: categories, accounts: const []),
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

Map<String, dynamic> _patch(List<http.Request> requests) =>
    jsonDecode(requests.where((r) => r.method == 'PATCH').single.body) as Map<String, dynamic>;

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('reads paid-for, who a gift was for, and a person\'s paid-for part', () {
    final row = Transaction.fromJson({
      'id': 't', 'amountMinor': 1, 'type': 'DEBIT', 'source': 'SMS', 'occurredAt': '2026-11-08T10:00:00.000Z',
      'paidFor': true, 'giftForContactId': 'mum',
    });
    expect(row.paidFor, isTrue);
    expect(row.giftForContactId, 'mum');
    expect(Contact.fromJson({'id': 'r', 'name': 'Rahul', 'givenMinor': 150000, 'paidForMinor': 50000}).paidForMinor, 50000);
  });

  testWidgets('paid for someone reads as what they owe, and is none of it the user\'s', (tester) async {
    final requests = <http.Request>[];
    final server = _server(requests);
    await http.runWithClient(() async {
      await _open(
        tester,
        Transaction.fromJson({
          'id': 't1', 'amountMinor': 50000, 'type': 'DEBIT', 'merchant': 'Big Bazaar', 'source': 'SMS',
          'occurredAt': '2026-11-08T10:00:00.000Z',
        }),
      );
      await tester.ensureVisible(find.text('Paid for someone'));
      await tester.tap(find.text('Paid for someone'));
      await tester.pumpAndSettle();
      expect(find.text('Who did you pay for?'), findsOneWidget);
      await tester.tap(find.text('Add people'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Rahul').last);
      await tester.pumpAndSettle();
      // The picker ticks, then adds.
      await tester.tap(find.widgetWithText(FilledButton, 'Add'));
      await tester.pumpAndSettle();
      await _save(tester);
    }, () => server);

    final patch = _patch(requests);
    expect(patch['paidFor'], isTrue);
    // None of it was the user's, so the row is about what Rahul owes
    // rather than about the shop.
    expect(patch['merchant'], 'Owed to Rahul');
    expect(patch['split']['myShareMinor'], 0);
    expect((patch['people'] as List).single['contactId'], 'rahul');
  });

  testWidgets('a gift says who it was for', (tester) async {
    final requests = <http.Request>[];
    final server = _server(requests);
    await http.runWithClient(() async {
      await _open(
        tester,
        Transaction.fromJson({
          'id': 't2', 'amountMinor': 250000, 'type': 'DEBIT', 'merchant': 'Tanishq', 'source': 'SMS',
          'occurredAt': '2026-11-08T10:00:00.000Z', 'categoryId': 'gift', 'category': {'id': 'gift', 'name': 'Gifting'},
        }),
        categories: [_gifting],
      );
      await tester.ensureVisible(find.byKey(const ValueKey('gift-for')));
      await tester.tap(find.byKey(const ValueKey('gift-for')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Mum').last);
      await tester.pumpAndSettle();
      // The picker ticks, then adds.
      await tester.tap(find.widgetWithText(FilledButton, 'Add'));
      await tester.pumpAndSettle();
      expect(find.text('For Mum'), findsOneWidget);
      await _save(tester);
    }, () => server);

    expect(_patch(requests)['giftForContactId'], 'mum');
  });
}
