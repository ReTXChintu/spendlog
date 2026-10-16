import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/loans_screen.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/utils/loan_tab.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';

/// A running loan as GET /loans sends it, with its tab.
Map<String, dynamic> _loan(
  String id,
  String label, {
  int monthly = 500000,
  int balance = 0,
  Map<String, dynamic>? nextDue,
  String? coveredThrough,
  List<Map<String, dynamic>> instalments = const [],
  List<Map<String, dynamic>> payments = const [],
  String status = 'ACTIVE',
}) =>
    {
      'id': id,
      'label': label,
      'principalMinor': monthly * 12,
      'months': 12,
      'monthlyAmountMinor': monthly,
      'totalPayableMinor': monthly * 12,
      'paidCount': 1,
      'remainingMinor': monthly * 11,
      'status': status,
      'balanceMinor': balance,
      'paidMinor': monthly + (balance > 0 ? balance : 0),
      'dueToDateMinor': monthly,
      'nextDue': nextDue,
      'coveredThrough': coveredThrough,
      'instalments': instalments,
      'payments': payments,
    };

final _loans = [
  _loan('a', 'HDFC personal loan', monthly: 600000, balance: 50000),
  _loan('b', 'Bike loan', monthly: 700000, balance: -30000),
  _loan('c', 'Gold loan', monthly: 200000),
];

/// What each loan owes for the payment's date: ₹6,000, ₹7,000 and ₹2,000,
/// which add up to exactly ₹15,000.
final _suggestion = {
  'amountMinor': 1500000,
  'on': '2026-10-05',
  'loans': [
    {'loanId': 'a', 'label': 'HDFC personal loan', 'dueMinor': 600000, 'balanceMinor': 50000},
    {'loanId': 'b', 'label': 'Bike loan', 'dueMinor': 700000, 'balanceMinor': -30000},
    {'loanId': 'c', 'label': 'Gold loan', 'dueMinor': 200000, 'balanceMinor': 0},
  ],
  'totalDueMinor': 1500000,
  'remainderMinor': 0,
  'matches': [
    {
      'loanIds': ['a', 'b', 'c'],
    },
  ],
};

/// Answers the sheet's lookups, and keeps every PATCH body.
MockClient _server(List<Map<String, dynamic>> patches, {Object? suggestion}) => MockClient((request) async {
      if (request.method == 'PATCH') {
        patches.add(jsonDecode(request.body) as Map<String, dynamic>);
        return http.Response('{}', 200);
      }
      final path = request.url.path;
      final body = switch (path) {
        _ when path.endsWith('/loans/split-suggestion') => jsonEncode(suggestion ?? _suggestion),
        _ when path.endsWith('/loans') => jsonEncode(_loans),
        _ when path.endsWith('/contacts') => '{"contacts": []}',
        _ => '[]',
      };
      return http.Response(body, 200, headers: {'content-type': 'application/json; charset=utf-8'});
    });

Transaction _payment({List<Map<String, dynamic>>? splits}) => Transaction.fromJson({
      'id': 't1',
      'amountMinor': 1500000,
      'type': 'DEBIT',
      'merchant': 'Loan repayments',
      'source': 'SMS',
      'occurredAt': '2026-10-05T05:00:00.000Z',
      if (splits != null) 'loanSplits': splits,
      if (splits != null && splits.isNotEmpty) 'loanId': splits.first['loanId'],
    });

Future<void> _open(WidgetTester tester, Transaction transaction,
    {double width = 480, Brightness brightness = Brightness.light}) async {
  // Wider than a phone by default: the test font's square glyphs are far
  // wider than the real one's, and the sheet's button row is sized for the
  // real one.
  tester.view.physicalSize = Size(width * 3, 2400 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(MaterialApp(
    theme: buildTheme(brightness),
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

String _amountIn(WidgetTester tester, String loanId) =>
    tester.widget<TextField>(find.byKey(ValueKey('loan-amount-$loanId'))).controller!.text;

bool _ticked(WidgetTester tester, String loanId) =>
    tester.widget<Checkbox>(find.byKey(ValueKey('loan-pick-$loanId'))).value ?? false;

String _assignedLine(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const ValueKey('loan-assigned-line'))).data!;

Future<void> _save(WidgetTester tester) async {
  await tester.ensureVisible(find.text('Save'));
  await tester.tap(find.text('Save'));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('the loan tab, in words', () {
    Loan loan(int balance, {Map<String, dynamic>? next, String? through}) =>
        Loan.fromJson(_loan('x', 'X', balance: balance, nextDue: next, coveredThrough: through));

    test('ahead into an instalment says which', () {
      final ahead = loan(50000, next: {
        'seq': 2,
        'dueDate': '2026-11-05T00:00:00.000Z',
        'amountMinor': 600000,
        'alreadyCoveredMinor': 50000,
      });
      expect(loanTabLine(ahead), '₹500 ahead — covers part of the Nov instalment');
      expect(ahead.nextDue!.shortMinor, 550000);
    });

    test('ahead by whole instalments names the last one covered', () {
      final ahead = loan(600000,
          next: {'seq': 3, 'dueDate': '2026-12-05T00:00:00.000Z', 'amountMinor': 600000},
          through: '2026-11-05');
      expect(loanTabLine(ahead), '₹6,000 ahead — covers the Nov instalment');
    });

    test('behind names the instalment still short', () {
      final behind = loan(-30000, next: {
        'seq': 1,
        'dueDate': '2026-10-05T00:00:00.000Z',
        'amountMinor': 600000,
        'alreadyCoveredMinor': 570000,
      });
      expect(loanTabLine(behind), '₹300 behind on the Oct instalment');
      expect(behind.behindMinor, 30000);
    });

    test('even is up to date, and paise are never rounded away', () {
      expect(loanTabLine(loan(0)), 'Up to date');
      expect(loanTabShort(-50), '₹0.50 behind');
    });

    test('totals, assigned and shares', () {
      expect(loanTotalLine(120000), '₹1,200 ahead overall');
      expect(loanTotalLine(-80000), '₹800 behind overall');
      expect(loanAssignedLine(assignedMinor: 1450000, totalMinor: 1500000),
          '₹14,500 of ₹15,000 assigned · ₹500 not assigned');
      expect(loanAssignedLine(assignedMinor: 1550000, totalMinor: 1500000),
          '₹15,500 of ₹15,000 assigned · ₹500 over');
      final share = LoanPaymentShare.fromJson({
        'transactionId': 't1',
        'occurredAt': '2026-10-05T05:00:00.000Z',
        'amountMinor': 600000,
        'totalMinor': 1500000,
      });
      expect(loanShareLine(share), '₹6,000 of a ₹15,000 payment on 5 Oct');
    });

    test('a payment from an older server reads as one loan for all of it', () {
      final old = Transaction.fromJson({
        'id': 't',
        'amountMinor': 500000,
        'type': 'DEBIT',
        'source': 'SMS',
        'occurredAt': '2026-10-05T05:00:00.000Z',
        'loanId': 'a',
      });
      expect(old.loanSplits.single.loanId, 'a');
      expect(old.loanSplits.single.amountMinor, 500000);
    });
  });

  group('splitting a repayment across loans', () {
    testWidgets('fills each loan with what it owes, and says what is assigned', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _payment());
        await tester.ensureVisible(find.text('Loan repayment'));
        await tester.tap(find.text('Loan repayment'));
        await tester.pumpAndSettle();

        expect(_amountIn(tester, 'a'), '6000.00');
        expect(_amountIn(tester, 'b'), '7000.00');
        expect(_amountIn(tester, 'c'), '2000.00');
        expect(_ticked(tester, 'a') && _ticked(tester, 'b') && _ticked(tester, 'c'), isTrue,
            reason: 'the one set of loans adding up to the payment');
        expect(_assignedLine(tester), '₹15,000 of ₹15,000 assigned');
        // Each loan's tab beside it.
        expect(find.text('₹500 ahead'), findsOneWidget);
        expect(find.text('₹300 behind'), findsOneWidget);

        // Less to the gold loan: the rest is not assigned, and it says so.
        await tester.enterText(find.byKey(const ValueKey('loan-amount-c')), '1500');
        await tester.pumpAndSettle();
        expect(_assignedLine(tester), '₹14,500 of ₹15,000 assigned · ₹500 not assigned');
        final line = tester.widget<Text>(find.byKey(const ValueKey('loan-assigned-line')));
        expect(line.style!.color, buildTheme(Brightness.light).extension<SpendColors>()!.warn);

        await _save(tester);
      }, () => _server(patches));

      expect(patches, hasLength(1), reason: 'an unassigned remainder still saves');
      expect(patches.single['loanSplits'], [
        {'loanId': 'a', 'amountMinor': 600000},
        {'loanId': 'b', 'amountMinor': 700000},
        {'loanId': 'c', 'amountMinor': 150000},
      ]);
      expect(patches.single.containsKey('loanId'), isFalse);
    });

    testWidgets('unticking a loan leaves it out of the save', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _payment());
        await tester.ensureVisible(find.text('Loan repayment'));
        await tester.tap(find.text('Loan repayment'));
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const ValueKey('loan-pick-b')));
        await tester.pumpAndSettle();
        expect(_assignedLine(tester), '₹8,000 of ₹15,000 assigned · ₹7,000 not assigned');

        await _save(tester);
      }, () => _server(patches));

      expect((patches.single['loanSplits'] as List).map((split) => split['loanId']), ['a', 'c']);
    });

    testWidgets('refuses loans adding up to more than the payment', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _payment());
        await tester.ensureVisible(find.text('Loan repayment'));
        await tester.tap(find.text('Loan repayment'));
        await tester.pumpAndSettle();

        await tester.enterText(find.byKey(const ValueKey('loan-amount-a')), '7000');
        await tester.pumpAndSettle();
        expect(_assignedLine(tester), '₹16,000 of ₹15,000 assigned · ₹1,000 over');

        await _save(tester);
        expect(find.textContaining('more than the payment'), findsOneWidget);
      }, () => _server(patches));

      expect(patches, isEmpty);
    });

    testWidgets('reopening a combined payment shows its own split', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(
          tester,
          _payment(splits: [
            {'loanId': 'a', 'amountMinor': 600000},
            {'loanId': 'b', 'amountMinor': 900000},
          ]),
        );

        // Opens as a loan repayment, with what was saved - not the dues.
        expect(_ticked(tester, 'a'), isTrue);
        expect(_ticked(tester, 'b'), isTrue);
        expect(_ticked(tester, 'c'), isFalse);
        expect(_amountIn(tester, 'a'), '6000.00');
        expect(_amountIn(tester, 'b'), '9000.00');
        expect(_amountIn(tester, 'c'), '2000.00', reason: 'its due, ready for if it is ticked');
        expect(_assignedLine(tester), '₹15,000 of ₹15,000 assigned');

        await _save(tester);
      }, () => _server(patches));

      expect(patches.single['loanSplits'], [
        {'loanId': 'a', 'amountMinor': 600000},
        {'loanId': 'b', 'amountMinor': 900000},
      ]);
    });

    testWidgets('another kind sends an empty list, taking it off every loan', (tester) async {
      final patches = <Map<String, dynamic>>[];
      await http.runWithClient(() async {
        await _open(tester, _payment(splits: [
          {'loanId': 'a', 'amountMinor': 1500000},
        ]));
        await tester.ensureVisible(find.text('Spending'));
        await tester.tap(find.text('Spending'));
        await tester.pumpAndSettle();
        await _save(tester);
      }, () => _server(patches));

      expect(patches.single['loanSplits'], isEmpty);
    });

    for (final brightness in Brightness.values) {
      testWidgets('the loan rows fit at 360 px (${brightness.name})', (tester) async {
        final patches = <Map<String, dynamic>>[];
        await http.runWithClient(() async {
          await _open(tester, _payment(), width: 360, brightness: brightness);
          // The sheet's own button row is sized for the real font and runs
          // over with the test one's square glyphs before any loan row is
          // on screen (why the other sheet tests open at 480). Set aside,
          // so what is checked is the loan panel alone.
          tester.takeException();
          await tester.ensureVisible(find.text('Loan repayment'));
          await tester.tap(find.text('Loan repayment'));
          await tester.pumpAndSettle();
          await tester.enterText(find.byKey(const ValueKey('loan-amount-c')), '1500');
          await tester.pumpAndSettle();
          await tester.ensureVisible(find.byKey(const ValueKey('loan-assigned-line')));
          await tester.pumpAndSettle();
        }, () => _server(patches));

        expect(tester.takeException(), isNull);
      });
    }
  });

  group('the loans view', () {
    final listed = {
      'totals': {'paidMinor': 1700000, 'dueToDateMinor': 1580000, 'balanceMinor': 120000},
      'loans': [
        _loan(
          'a',
          'HDFC personal loan with a name long enough to need cutting short',
          monthly: 600000,
          balance: 150000,
          nextDue: {
            'seq': 2,
            'dueDate': '2026-11-05T00:00:00.000Z',
            'amountMinor': 600000,
            'alreadyCoveredMinor': 150000,
          },
          instalments: [
            {'seq': 1, 'dueDate': '2026-10-05T00:00:00.000Z', 'amountMinor': 600000, 'paidMinor': 600000, 'status': 'PAID'},
            {'seq': 2, 'dueDate': '2026-11-05T00:00:00.000Z', 'amountMinor': 600000, 'paidMinor': 150000, 'status': 'PARTIAL'},
            {'seq': 3, 'dueDate': '2026-12-05T00:00:00.000Z', 'amountMinor': 600000, 'paidMinor': 0, 'status': 'DUE'},
          ],
          payments: [
            {
              'transactionId': 't1',
              'occurredAt': '2026-10-05T05:00:00.000Z',
              'merchant': 'NACH ACH DR HDFC BANK LTD LOAN COLLECTIONS',
              'amountMinor': 750000,
              'totalMinor': 1500000,
            },
          ],
        ),
        _loan(
          'b',
          'Bike loan',
          monthly: 700000,
          balance: -30000,
          nextDue: {
            'seq': 1,
            'dueDate': '2026-10-05T00:00:00.000Z',
            'amountMinor': 700000,
            'alreadyCoveredMinor': 670000,
          },
          instalments: [
            {'seq': 1, 'dueDate': '2026-10-05T00:00:00.000Z', 'amountMinor': 700000, 'paidMinor': 670000, 'status': 'PARTIAL'},
          ],
        ),
      ],
    };

    MockClient server() => MockClient((request) async =>
        http.Response(jsonEncode(listed), 200, headers: {'content-type': 'application/json; charset=utf-8'}));

    for (final brightness in Brightness.values) {
      testWidgets('shows each tab, the total, statuses and shares at 360 px (${brightness.name})', (tester) async {
        tester.view.physicalSize = const Size(1080, 7200);
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);

        await http.runWithClient(() async {
          await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: const LoansScreen(focusLoanId: 'a')));
          await tester.pumpAndSettle();
        }, server);

        expect(tester.takeException(), isNull);
        expect(find.text('₹1,200 ahead overall'), findsOneWidget);
        expect(find.text('₹1,500 ahead — covers part of the Nov instalment'), findsOneWidget);
        expect(find.text('₹300 behind on the Oct instalment'), findsOneWidget);
        expect(find.text('Part paid'), findsWidgets);
        expect(find.text('Paid'), findsOneWidget);
        expect(find.text('₹1,500 of ₹6,000 · ₹4,500 short'), findsOneWidget);
        expect(find.text('₹7,500 of a ₹15,000 payment on 5 Oct'), findsOneWidget);
      });
    }
  });
}
