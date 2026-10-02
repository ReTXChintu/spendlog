import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/charts/column_chart.dart';
import 'package:spendlog/widgets/charts/daily_spend_chart.dart';
import 'package:spendlog/widgets/charts/donut_chart.dart';
import 'package:spendlog/widgets/home/earmarks_tile.dart';
import 'package:spendlog/widgets/home/home_grid.dart';
import 'package:spendlog/widgets/home/money_carousel.dart';
import 'package:spendlog/widgets/home/plan_warnings.dart';

final _dashboardJson = <String, dynamic>{
  'money': {
    'accounts': [
      {'id': 'a1', 'name': 'HDFC', 'last4': '1234', 'accountType': 'BANK', 'isSavings': false, 'balanceMinor': 4523000},
      {'id': 'a2', 'name': 'ICICI', 'last4': null, 'accountType': 'BANK', 'isSavings': false, 'balanceMinor': null},
      {'id': 'c1', 'name': 'Cash', 'accountType': 'CASH', 'isSavings': false, 'balanceMinor': 120000},
      {'id': 's1', 'name': 'SBI', 'last4': '9876', 'accountType': 'BANK', 'isSavings': true, 'balanceMinor': 50000000},
    ],
    'onHandMinor': 4643000,
    'inBankMinor': 4523000,
    'cashMinor': 120000,
    'savingsMinor': 50000000,
    'untracked': 1,
  },
  'earmarks': {
    'count': 3,
    'totalMinor': 800000,
    'items': [
      {'id': 'e1', 'merchant': 'Dad', 'note': 'New phone', 'occurredAt': '2026-09-20T10:00:00.000Z', 'amountMinor': 800000, 'spentMinor': 200000, 'leftMinor': 600000},
      {'id': 'e2', 'merchant': 'Mum', 'note': null, 'occurredAt': null, 'amountMinor': 100000, 'spentMinor': 0, 'leftMinor': 100000},
      {'id': 'e3', 'merchant': null, 'note': null, 'occurredAt': null, 'amountMinor': 100000, 'spentMinor': 0, 'leftMinor': 100000},
    ],
  },
  'planWarnings': [
    {'text': 'Keep food delivery under ₹4,000 a month', 'category': 'Food & dining', 'monthlyCapMinor': 400000, 'spentMinor': 460000, 'expectedSoFarMinor': 260000, 'state': 'over'},
    {'text': 'Shopping at most ₹3,000', 'category': null, 'monthlyCapMinor': 300000, 'spentMinor': 200000, 'expectedSoFarMinor': 150000, 'state': 'watch'},
  ],
  'daily': {'configured': true, 'bucketMinor': 120000, 'extraIncomeMinor': 500000},
};

Widget _wrap(Widget child, Brightness brightness) => MaterialApp(
      theme: buildTheme(brightness),
      home: Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(16), child: child)),
    );

void main() {
  test('DashboardData reads money, earmarks and plan warnings', () {
    final data = DashboardData.fromJson(_dashboardJson);
    expect(data.money.onHandMinor, 4643000);
    expect(data.money.accounts.where((a) => a.isSavings).single.name, 'SBI');
    expect(data.money.accounts[1].balanceMinor, isNull);
    expect(data.earmarks.count, 3);
    expect(data.earmarks.items.first.label, 'New phone');
    expect(data.earmarks.items[1].label, 'Mum');
    expect(data.planWarnings.first.state, 'over');
    expect(data.daily.extraIncomeMinor, 500000);
  });

  test('DashboardData copes with an older server', () {
    final data = DashboardData.fromJson({});
    expect(data.money.accounts, isEmpty);
    expect(data.earmarks.count, 0);
    expect(data.planWarnings, isEmpty);
  });

  test('SavingsPlan reads rules and month', () {
    final plan = SavingsPlan.fromJson({
      'summary': 'Spend less on food.',
      'monthlyTargetMinor': 1500000,
      'model': 'gemini',
      'updatedAt': '2026-10-01T05:00:00.000Z',
      'month': {'from': '2026-09-15', 'to': '2026-10-14'},
      'rules': [
        {'text': 'Cap food', 'category': 'Food', 'monthlyCapMinor': 400000, 'spentMinor': 100000, 'state': 'ok'},
        {'text': 'No impulse buys', 'category': null, 'monthlyCapMinor': null, 'state': 'watch'},
      ],
      'warnings': [],
    });
    expect(plan.rules.length, 2);
    expect(plan.rules[1].monthlyCapMinor, isNull);
    expect(plan.monthFrom, '2026-09-15');
  });

  for (final brightness in Brightness.values) {
    testWidgets('Home pieces lay out without overflow (${brightness.name})', (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      final data = DashboardData.fromJson(_dashboardJson);
      final card = CardStatus.fromJson({
        'accountId': 'k1',
        'name': 'Amazon Pay ICICI credit card',
        'last4': '4321',
        'spentMinor': 2500000,
        'creditLimitMinor': 30000000,
        'availableMinor': 26000000,
        'state': 'ok',
      });

      await tester.pumpWidget(_wrap(
        Column(
          children: [
            PlanWarnings(warnings: data.planWarnings, onOpenPlan: () {}),
            MoneyCarousel(money: data.money, cards: [card], onOpenAccounts: () {}),
            const SizedBox(height: 12),
            HomeGrid(items: [
              GridItem(EarmarksTile(earmarks: data.earmarks)),
              const GridItem(HomeTile(
                label: 'By weekday',
                child: ColumnChart(
                  values: [100, 2000, 300, 400, 500, 600, 7000],
                  labels: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
                  color: Colors.blue,
                  highlight: Colors.indigo,
                ),
              )),
              GridItem(
                HomeTile(
                  label: 'Spending day by day',
                  child: DailySpendChart(days: [
                    for (var d = 1; d <= 30; d++)
                      DaySpend(day: '2026-09-${d.toString().padLeft(2, '0')}', spendMinor: d * 13000 % 90000, incomeMinor: 0),
                  ]),
                ),
                span: 2,
              ),
              const GridItem(
                DonutChart(
                  segments: [
                    DonutSegment(value: 300, color: Colors.red, label: 'Food'),
                    DonutSegment(value: 200, color: Colors.green, label: 'Travel'),
                  ],
                  centerTop: '₹12.4k',
                  centerBottom: 'spent',
                ),
                span: 2,
              ),
            ]),
          ],
        ),
        brightness,
      ));

      expect(tester.takeException(), isNull);
      expect(find.text('Set balance'), findsOneWidget);
      expect(find.text('SET ASIDE FOR LATER'), findsOneWidget);

      // The savings account sits last in the scroll, its amount hidden
      // until asked for.
      await tester.drag(find.byType(ListView), const Offset(-800, 0));
      await tester.pumpAndSettle();
      expect(find.text('Savings · not counted · tap to see'), findsOneWidget);
      expect(find.text('₹5,00,000.00'), findsNothing);
      await tester.tap(find.text('Savings · not counted · tap to see'));
      await tester.pump();
      expect(find.text('₹5,00,000.00'), findsOneWidget);
    });
  }
}
