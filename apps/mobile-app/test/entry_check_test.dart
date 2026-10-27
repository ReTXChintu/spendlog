import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/flagged_entries_screen.dart';
import 'package:spendlog/services/push_service.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/home/monthly_budget_card.dart';

Map<String, dynamic> _flagged(String id, String kind, String reason) => {
      'id': id,
      'amountMinor': 300000,
      'type': 'DEBIT',
      'merchant': 'Meesho sent directly to your bank account',
      'source': 'SMS',
      'occurredAt': '2026-10-16T05:09:00.000Z',
      'rawText': 'Get a personal loan of Rs. 3,000 on Meesho sent directly to your bank account. Check your offer now: '
          'https://ltl.sh/1z15jfkk5d6',
      'aiFlag': {'kind': kind, 'reason': reason, 'flaggedAt': '2026-10-28T01:30:00.000Z'},
    };

/// The flagged list, and every request the screen makes.
MockClient _server(List<http.Request> requests, {List<Map<String, dynamic>>? rows}) {
  var list = rows ?? [_flagged('t1', 'NOT_A_TRANSACTION', 'This is a loan advert, not a payment.')];
  return MockClient((request) async {
    requests.add(request);
    final path = request.url.path;
    if (request.method == 'GET' && path.endsWith('/transactions/flagged')) {
      return http.Response(jsonEncode(list), 200);
    }
    if (request.method == 'POST' && path.endsWith('/flag/dismiss')) {
      list = [];
      return http.Response('', 204);
    }
    if (request.method == 'POST' && path.endsWith('/transactions/check')) {
      return http.Response(jsonEncode({'checked': 4, 'flagged': 0}), 200);
    }
    return http.Response('{}', 200);
  });
}

Future<void> _pump(WidgetTester tester, Widget child, [Brightness brightness = Brightness.light]) async {
  // A 360 px phone.
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: child));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('the biggest payments on the budget card', () {
    MonthlyBudgetStatus budget({bool over = false}) => MonthlyBudgetStatus.fromJson({
          'configured': true,
          'month': {'key': '2026-10', 'label': '15 Oct – 14 Nov', 'isCurrent': true, 'daysInMonth': 31, 'dayOfMonth': 14, 'daysLeft': 18},
          'budgetMinor': 6000000,
          'spentMinor': over ? 6788527 : 3000000,
          'leftMinor': over ? -788527 : 3000000,
          'isOver': over,
          'topPayments': [
            {'id': 'p1', 'merchant': 'slice', 'categoryName': 'Lent & borrowed', 'occurredAt': '2026-10-15T15:38:00.000Z', 'amountMinor': 1284605, 'countedAmountMinor': 1284605},
            {'id': 'p2', 'merchant': 'Bar', 'categoryName': 'Food & Dining', 'occurredAt': '2026-10-18T18:28:00.000Z', 'amountMinor': 481400, 'countedAmountMinor': 160467},
            {'merchant': 'no id, dropped', 'amountMinor': 1, 'countedAmountMinor': 1},
          ],
        });

    test('reads them, dropping one without an id, and an older server sends none', () {
      final payments = budget().topPayments;
      expect(payments.map((p) => p.id), ['p1', 'p2']);
      expect(payments[1].countedAmountMinor, 160467);
      expect(MonthlyBudgetStatus.fromJson({'configured': true, 'budgetMinor': 100}).topPayments, isEmpty);
    });

    testWidgets('lists them, says your part of a split, and opens one on tap', (tester) async {
      String? opened;
      await _pump(
        tester,
        Scaffold(
          body: SingleChildScrollView(
            child: MonthlyBudgetCard(budget: budget(over: true), onEdit: () {}, onOpenPayment: (id) => opened = id),
          ),
        ),
      );

      expect(find.text('Biggest payments · why it went over'), findsOneWidget);
      expect(find.text('slice'), findsOneWidget);
      expect(find.textContaining('your part of'), findsOneWidget);

      await tester.ensureVisible(find.byKey(const ValueKey('top-payment-p2')));
      await tester.tap(find.byKey(const ValueKey('top-payment-p2')));
      expect(opened, 'p2');
    });

    testWidgets('is headed for the month when it is not over', (tester) async {
      await _pump(tester, Scaffold(body: SingleChildScrollView(child: MonthlyBudgetCard(budget: budget(), onEdit: () {}))));
      expect(find.text('Biggest payments this month'), findsOneWidget);
    });
  });

  group('entries to check', () {
    test('a flag reads its kind as the user would say it', () {
      final entry = FlaggedEntry.fromJson(_flagged('t1', 'DUPLICATE', 'Twice.'));
      expect(entry.kindLabel, 'Recorded twice');
      expect(entry.deleteFirst, isTrue);
      expect(FlaggedEntry.fromJson(_flagged('t1', 'WRONG_AMOUNT', 'x')).deleteFirst, isFalse);
    });

    testWidgets('shows why and the message, and "it\'s right" takes it off', (tester) async {
      final requests = <http.Request>[];
      // One server for the whole test: runWithClient asks for a client per
      // request, and the dismiss has to be remembered for the reload.
      final server = _server(requests);
      await http.runWithClient(() async {
        await _pump(tester, const FlaggedEntriesScreen());

        expect(find.text('Not a payment'), findsOneWidget);
        expect(find.text('This is a loan advert, not a payment.'), findsOneWidget);
        expect(find.textContaining('Check your offer now'), findsOneWidget);

        await tester.tap(find.text("It's right"));
        // The dismiss, then the reload: a round trip each.
        for (var i = 0; i < 3; i++) {
          await tester.pumpAndSettle();
          await tester.pump(const Duration(milliseconds: 50));
        }

        expect(requests.any((r) => r.method == 'POST' && r.url.path.endsWith('/transactions/t1/flag/dismiss')), isTrue);
        expect(find.text('Nothing looks wrong'), findsOneWidget);
      }, () => server);
    });

    testWidgets('delete asks first, then deletes', (tester) async {
      final requests = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const FlaggedEntriesScreen());
        await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
        await tester.pumpAndSettle();
        expect(find.text('Delete this entry?'), findsOneWidget);
        await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Delete')));
        await tester.pumpAndSettle();
      }, () => _server(requests));

      expect(requests.any((r) => r.method == 'DELETE' && r.url.path.endsWith('/transactions/t1')), isTrue);
    });

    testWidgets('check now runs the check and says what it found', (tester) async {
      final requests = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const FlaggedEntriesScreen());
        await tester.tap(find.text('Check now').first);
        await tester.pumpAndSettle();
      }, () => _server(requests));

      expect(requests.any((r) => r.method == 'POST' && r.url.path.endsWith('/transactions/check')), isTrue);
      expect(find.text('Checked 4 entries · all look right'), findsOneWidget);
    });

    for (final brightness in Brightness.values) {
      testWidgets('fits a 360 px phone (${brightness.name})', (tester) async {
        await http.runWithClient(() async {
          await _pump(tester, const FlaggedEntriesScreen(), brightness);
          expect(tester.takeException(), isNull);
        }, () => _server([], rows: [
              _flagged('t1', 'NOT_A_TRANSACTION', 'This is a loan advert, not a payment.'),
              _flagged('t2', 'WRONG_AMOUNT', 'The message says Rs 300, not Rs 3,000.'),
            ]));
      });
    }

    test('the morning check\'s notification opens the list', () {
      expect(PushService.screenFor({'type': 'ENTRY_CHECK'}), isA<FlaggedEntriesScreen>());
    });
  });
}
