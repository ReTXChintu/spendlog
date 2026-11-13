import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';

/// Netflix, due on the 5th of each month, with October's already paid by
/// another payment and November's still open.
const _netflix = {
  'id': 'netflix',
  'name': 'Netflix',
  'amountMinor': 64900,
  'every': 1,
  'unit': 'month',
  'frequencyLabel': 'Monthly',
  'frequencyPreset': 'monthly',
  'monthlyMinor': 64900,
  'yearlyMinor': 778800,
  'nextRenewalOn': '2026-11-05',
  'daysToRenewal': 4,
  'startedOn': '2026-01-05',
  'status': 'active',
  'categoryId': 'ent',
  'renewals': [
    {'dueOn': '2026-10-05', 'status': 'paid', 'transactionId': 'other', 'amountMinor': 64900},
  ],
};

Transaction _row({
  String type = 'DEBIT',
  String? subscriptionId,
  bool isTransfer = false,
  String on = '2026-11-03T10:00:00.000Z',
}) =>
    Transaction.fromJson({
      'id': 't1',
      'amountMinor': 64900,
      'type': type,
      'merchant': 'NETFLIX.COM',
      'source': 'SMS',
      'isTransfer': isTransfer,
      'subscriptionId': subscriptionId,
      'occurredAt': on,
    });

MockClient _server(
  List<Map<String, dynamic>> patches, {
  List<Object> subscriptions = const [_netflix],
}) =>
    MockClient((request) async {
      if (request.method == 'PATCH') {
        patches.add(jsonDecode(request.body) as Map<String, dynamic>);
        return http.Response('{}', 200);
      }
      if (request.url.path.endsWith('/subscriptions')) {
        return http.Response(jsonEncode({'items': subscriptions, 'totals': {}, 'suggestions': []}), 200);
      }
      final body = request.url.path.endsWith('/contacts') ? '{"contacts": []}' : '[]';
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

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('marking a payment as a subscription', () {
    testWidgets('the chip picks the only subscription, and says which renewal', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _row());
        await tester.ensureVisible(find.byKey(const ValueKey('is-subscription')));
        await tester.tap(find.byKey(const ValueKey('is-subscription')));
        await tester.pumpAndSettle();

        // October's is paid by another payment, so the open one is 5 Nov.
        expect(find.textContaining('Settles the renewal due 5 Nov'), findsOneWidget);
        await _save(tester);
      }, () => _server(patches));

      expect(patches.single['subscriptionId'], 'netflix');
    });

    testWidgets('a payment already on one opens with the chip on', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _row(subscriptionId: 'netflix'));
        expect(find.byKey(const ValueKey('subscription-picker')), findsOneWidget);
        await _save(tester);
      }, () => _server(patches));

      expect(patches.single['subscriptionId'], 'netflix');
    });

    testWidgets('turning the chip off takes the payment off it', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _row(subscriptionId: 'netflix'));
        await tester.ensureVisible(find.byKey(const ValueKey('is-subscription')));
        await tester.tap(find.byKey(const ValueKey('is-subscription')));
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('subscription-picker')), findsNothing);
        await _save(tester);
      }, () => _server(patches));

      expect(patches.single['subscriptionId'], isNull);
    });

    testWidgets('refuses to save a date no renewal falls near', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        // Months before anything Netflix has to renew.
        await _open(tester, _row(on: '2025-01-03T10:00:00.000Z'));
        await tester.ensureVisible(find.byKey(const ValueKey('is-subscription')));
        await tester.tap(find.byKey(const ValueKey('is-subscription')));
        await tester.pumpAndSettle();
        expect(find.textContaining('falls anywhere near this date'), findsOneWidget);
        await _save(tester);
        expect(find.textContaining('anywhere near'), findsWidgets);
      }, () => _server(patches));

      // Nothing was sent.
      expect(patches, isEmpty);
    });

    testWidgets('a transfer is never offered it, and letting go is silent', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _row(isTransfer: true));
        expect(find.byKey(const ValueKey('is-subscription')), findsNothing);
      }, () => _server(patches));

      // A payment on a subscription, turned into a transfer, lets go.
      await http.runWithClient(() async {
        await _open(tester, _row(subscriptionId: 'netflix'));
        await tester.ensureVisible(find.text('To own account'));
        await tester.tap(find.text('To own account'));
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('subscription-picker')), findsNothing);
      }, () => _server(patches));
    });

    testWidgets('no subscriptions, no chip', (tester) async {
      await http.runWithClient(() async {
        await _open(tester, _row());
        expect(find.byKey(const ValueKey('is-subscription')), findsNothing);
      }, () => _server([], subscriptions: const []));
    });
  });
}
