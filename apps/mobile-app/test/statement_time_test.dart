import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/transaction_tile.dart';

Transaction _row({bool timeUnknown = false}) => Transaction.fromJson({
      'id': 't1',
      'amountMinor': 2000,
      'type': 'DEBIT',
      'merchant': 'UPIOUT/009162391814/91-',
      'source': 'STATEMENT',
      // Midnight IST: the only time a statement row has.
      'occurredAt': '2026-10-05T18:30:00.000Z',
      'timeUnknown': timeUnknown,
    });

Future<void> _pump(WidgetTester tester, Widget child) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: Scaffold(body: child)));
  await tester.pumpAndSettle();
}

void main() {
  test('reads that only the day is known', () {
    expect(_row(timeUnknown: true).timeUnknown, isTrue);
    expect(_row().timeUnknown, isFalse);
    expect(PassbookRow.fromJson({'seq': 1, 'kind': 'txn', 'at': '2026-10-05T18:30:00.000Z', 'runningMinor': 0, 'timeUnknown': true}).timeUnknown, isTrue);
  });

  testWidgets('a row a statement added says so instead of a made-up midnight', (tester) async {
    await _pump(tester, TransactionTile(transaction: _row(timeUnknown: true), categories: const [], onUpdated: (_) {}));
    expect(find.textContaining('from statement'), findsOneWidget);
    expect(find.textContaining('12:00'), findsNothing);
  });

  testWidgets('a row with its time shows the time', (tester) async {
    await _pump(tester, TransactionTile(transaction: _row(), categories: const [], onUpdated: (_) {}));
    expect(find.textContaining('12:00 am'), findsOneWidget);
  });
}
