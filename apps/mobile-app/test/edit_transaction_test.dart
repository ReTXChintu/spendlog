import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';

Transaction _row({required String type, bool isSpecial = false}) => Transaction.fromJson({
      'id': 't1',
      'amountMinor': 4500000,
      'type': type,
      'merchant': 'Croma',
      'source': 'SMS',
      'isSpecial': isSpecial,
      'occurredAt': '2026-10-08T10:00:00.000Z',
    });

/// The sheet, opened over a page. Requests go to whatever client the
/// caller runs it with.
Future<void> _open(WidgetTester tester, Transaction transaction) async {
  // Wider than a phone: the test font's square glyphs are far wider than
  // the real one's, and the sheet's button row is sized for the real one.
  tester.view.physicalSize = const Size(1440, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(MaterialApp(
    theme: buildTheme(Brightness.light),
    home: Scaffold(
      body: Builder(
        builder: (context) => TextButton(
          onPressed: () => showEditTransactionSheet(
            context,
            transaction: transaction,
            categories: const [],
            accounts: const [],
          ),
          child: const Text('Open'),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

/// Answers the sheet's lookups with nothing, and keeps every PATCH body.
MockClient _server(List<Map<String, dynamic>> patches) => MockClient((request) async {
      if (request.method == 'PATCH') {
        patches.add(jsonDecode(request.body) as Map<String, dynamic>);
        return http.Response('{}', 200);
      }
      // Every list the sheet loads is empty; /contacts is an object.
      final body = request.url.path.endsWith('/contacts') ? '{"contacts": []}' : '[]';
      return http.Response(body, 200);
    });

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('one-offs count against the budget', () {
    testWidgets('a payment has no one-off toggle, and saving clears an old one', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _row(type: 'DEBIT', isSpecial: true));

        expect(find.text('One-off'), findsNothing);
        expect(find.textContaining('out of the ordinary'), findsNothing);
        expect(find.text('Keep out of savings bucket'), findsNothing);

        await tester.ensureVisible(find.text('Save'));
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();
      }, () => _server(patches));

      expect(patches, hasLength(1));
      expect(patches.single['isSpecial'], isFalse);
    });

    testWidgets('money in still keeps its "keep out of savings" toggle', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _row(type: 'CREDIT', isSpecial: true));

        expect(find.text('Keep out of savings bucket'), findsOneWidget);
        expect(find.textContaining('Kept out of your savings bucket'), findsOneWidget);

        await tester.ensureVisible(find.text('Save'));
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();
      }, () => _server(patches));

      expect(patches.single['isSpecial'], isTrue);
    });
  });
}
