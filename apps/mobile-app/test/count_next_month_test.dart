import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';

/// Pay day the 20th: 15 November still belongs to the month that opened
/// on 20 October, and the one the pay is really for opens on the 20th.
const _around = {
  'bySalary': true,
  'month': {'month': '2026-10', 'from': '2026-10-20', 'to': '2026-11-19', 'label': '20 Oct – 19 Nov'},
  'next': {'month': '2026-11', 'from': '2026-11-20', 'to': '2026-12-19', 'label': '20 Nov – 19 Dec'},
};

Transaction _row({String type = 'DEBIT', String? countInMonth}) => Transaction.fromJson({
      'id': 't1',
      'amountMinor': 450000,
      'type': type,
      'merchant': 'Croma',
      'source': 'SMS',
      'countInMonth': countInMonth,
      'occurredAt': '2026-11-15T10:00:00.000Z',
    });

MockClient _server(List<Map<String, dynamic>> patches, {Object? around = _around}) => MockClient((request) async {
      if (request.method == 'PATCH') {
        patches.add(jsonDecode(request.body) as Map<String, dynamic>);
        return http.Response('{}', 200);
      }
      final path = request.url.path;
      if (path.endsWith('/months-around')) {
        if (around == null) return http.Response('{"error": "nope"}', 400);
        // A month's label holds an en dash, which Latin-1 cannot carry.
        return http.Response.bytes(
          utf8.encode(jsonEncode(around)),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      }
      if (path.endsWith('/subscriptions')) return http.Response('{"items": [], "totals": {}}', 200);
      final body = path.endsWith('/contacts') ? '{"contacts": []}' : '[]';
      return http.Response(body, 200);
    });

Future<void> _open(WidgetTester tester, Transaction transaction) async {
  tester.view.physicalSize = const Size(1440, 3000);
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

Future<void> _save(WidgetTester tester) async {
  await tester.ensureVisible(find.text('Save'));
  await tester.tap(find.text('Save'));
  await tester.pumpAndSettle();
}

Future<void> _toggle(WidgetTester tester) async {
  await tester.ensureVisible(find.byKey(const ValueKey('count-next-month')));
  await tester.tap(find.byKey(const ValueKey('count-next-month')));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('counting a payment against the next month', () {
    testWidgets('names both months, and sends the one it counts against', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _row());
        await _toggle(tester);
        expect(
          find.textContaining('Counted against 20 Nov – 19 Dec instead of 20 Oct – 19 Nov'),
          findsOneWidget,
        );
        await _save(tester);
      }, () => _server(patches));

      expect(patches.single['countInMonth'], '2026-11');
      // The day it happened on is untouched.
      expect(patches.single['occurredAt'], contains('2026-11-15'));
    });

    testWidgets('a payment already pushed on opens with the chip on', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _row(countInMonth: '2026-11'));
        expect(find.textContaining('Counted against 20 Nov – 19 Dec'), findsOneWidget);
        await _save(tester);
      }, () => _server(patches));

      expect(patches.single['countInMonth'], '2026-11');
    });

    testWidgets('turning it off puts it back in its own month', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _row(countInMonth: '2026-11'));
        await _toggle(tester);
        expect(find.textContaining('Counted against'), findsNothing);
        await _save(tester);
      }, () => _server(patches));

      expect(patches.single['countInMonth'], isNull);
    });

    testWidgets('money in can be moved too, in its own words', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _row(type: 'CREDIT'));
        await _toggle(tester);
        expect(find.textContaining('For money in that belongs to'), findsOneWidget);
        await _save(tester);
      }, () => _server(patches));

      expect(patches.single['countInMonth'], '2026-11');
    });

    testWidgets('no chip when the server cannot say which months', (tester) async {
      await http.runWithClient(() async {
        await _open(tester, _row());
        expect(find.byKey(const ValueKey('count-next-month')), findsNothing);
      }, () => _server([], around: null));
    });
  });
}
