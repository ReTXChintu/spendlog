import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';
import 'package:spendlog/widgets/transaction_tile.dart';

/// My share of a group payment somebody else made: shown as such in the
/// list, and opened on a sheet that changes its category and nothing else.
void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  final mirror = Transaction.fromJson({
    'id': 'm1',
    'userId': 'me',
    'amountMinor': 300000,
    'type': 'DEBIT',
    'merchant': 'Dinner',
    'source': 'MANUAL',
    'occurredAt': '2026-10-20T14:00:00.000Z',
    'offLedger': true,
    'mirrorOf': 'src1',
    'paidByName': 'Asha',
    'groupSplit': true,
    'split': {'myShareMinor': 100000, 'groupLabel': 'Goa'},
    'group': {'id': 'g1', 'name': 'Goa'},
    'category': null,
  });
  final categories = [
    Category.fromJson({'id': 'c1', 'name': 'Food', 'direction': 'DEBIT', 'isSystem': false}),
    Category.fromJson({'id': 'c2', 'name': 'Outings', 'direction': 'DEBIT', 'isSystem': false}),
  ];

  test('is parsed as a mirror', () {
    expect(mirror.mirrorOf, 'src1');
    expect(mirror.offLedger, isTrue);
    expect(mirror.paidByName, 'Asha');
  });

  testWidgets('the tile says whose payment it is a share of', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.light),
      home: Scaffold(
        body: ListView(children: [TransactionTile(transaction: mirror, categories: categories, onUpdated: (_) {})]),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Paid by Asha · your share'), findsOneWidget);
    expect(find.text('My share ₹1,000.00 · Goa'), findsOneWidget);
  });

  testWidgets('opens on a sheet that changes the category and nothing else', (tester) async {
    tester.view.physicalSize = const Size(1440, 2600);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final requests = <http.Request>[];
    final client = MockClient((request) async {
      requests.add(request);
      return http.Response(jsonEncode({'id': 'm1'}), 200, headers: {'content-type': 'application/json'});
    });

    await http.runWithClient(() async {
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(Brightness.light),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showEditTransactionSheet(context, transaction: mirror, categories: categories, accounts: const []),
              child: const Text('Open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();

      expect(find.text('Your share of Dinner'), findsOneWidget);
      expect(find.text('Paid by Asha · Goa'), findsOneWidget);
      expect(find.text('₹1,000.00'), findsOneWidget);
      expect(find.text('₹3,000.00'), findsOneWidget);
      expect(find.text('Delete'), findsNothing);
      expect(find.text('Amount'), findsNothing);

      final save = find.byKey(const ValueKey('mirror-save'));
      expect(tester.widget<FilledButton>(save).onPressed, isNull, reason: 'nothing changed yet');
      await tester.tap(find.byKey(const ValueKey('mirror-category-c2')));
      await tester.pumpAndSettle();
      await tester.tap(save);
      await tester.pumpAndSettle();
    }, () => client);

    expect(requests, hasLength(1));
    expect(requests.single.method, 'PATCH');
    expect(requests.single.url.path, endsWith('/transactions/m1'));
    expect(jsonDecode(requests.single.body), {'categoryId': 'c2'});
    expect(find.text('Your share of Dinner'), findsNothing, reason: 'closed on save');
  });
}
