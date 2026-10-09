import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/charts/column_chart.dart';
import 'package:spendlog/widgets/charts/daily_spend_chart.dart';
import 'package:spendlog/widgets/charts/donut_chart.dart';
import 'package:spendlog/widgets/home/earmarks_tile.dart';
import 'package:spendlog/widgets/home/home_grid.dart';
import 'package:spendlog/widgets/home/monthly_budget_card.dart';
import 'package:spendlog/widgets/home/plan_warnings.dart';
import 'package:spendlog/widgets/home/wallet.dart';

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
  'budget': {
    'configured': true,
    'everSet': true,
    'month': {
      'key': '2026-09', 'from': '2026-09-15', 'to': '2026-10-14', 'label': '15 Sep – 14 Oct', 'bySalary': true,
      'isCurrent': true, 'isClosed': false, 'daysInMonth': 30, 'dayOfMonth': 25, 'daysLeft': 6,
    },
    'budgetMinor': 2000000,
    'spentMinor': 1766000,
    'leftMinor': 234000,
    'isOver': false,
    'pace': {
      'status': 'high', 'dayOfMonth': 25, 'daysInMonth': 30, 'daysLeft': 6, 'remainingMinor': 234000,
      'safeDailyMinor': 30000, 'expectedSpentMinor': 1600000, 'aheadByMinor': 166000, 'dailyAverageMinor': 60000,
      'projectedSpentMinor': 2066000, 'runOutOn': '2026-10-12', 'fixedPaidMinor': 1000000, 'fixedStillDueMinor': 54000,
    },
    'categories': [
      {'categoryId': 'cat1', 'name': 'Food & dining', 'icon': 'ic-food', 'color': '#F97316', 'limitMinor': 400000, 'spentMinor': 460000, 'leftMinor': -60000, 'isOver': true, 'pace': null},
      {'categoryId': 'cat2', 'name': 'Groceries', 'icon': 'ic-basket', 'color': '#16A34A', 'limitMinor': 500000, 'spentMinor': 210000, 'leftMinor': 290000, 'isOver': false, 'pace': null},
    ],
    'unassigned': {
      'amountMinor': 1100000, 'spentMinor': 1096000, 'leftMinor': 4000, 'isOver': false, 'pace': null,
      'categories': [{'categoryId': 'cat9', 'name': 'Rent', 'spentMinor': 1000000}, {'categoryId': null, 'name': 'No category', 'spentMinor': 96000}],
    },
    'bucket': {'configured': true, 'balanceMinor': 4500000, 'balanceIfMonthEndedNowMinor': 4734000},
    'suggestedMonthlyMinor': null,
  },
  'wallet': {
    'cards': [
      {
        'accountId': 'k1', 'name': 'Amazon Pay ICICI credit card', 'bankName': 'ICICI Bank', 'issuer': null,
        'network': 'VISA', 'last4': '4321', 'color': null, 'statementDay': 20, 'dueDay': 8,
        'statementDayInferred': false, 'cycleKnown': true, 'creditLimitMinor': 30000000,
        'billedUnpaidMinor': 1500000, 'unbilledMinor': 2500000, 'outstandingMinor': 4000000,
        'outstandingIsEstimate': false, 'usedMinor': 4000000, 'availableMinor': 26000000, 'sharesLimitWith': [],
        'cycleStart': '2026-09-20', 'cycleEnd': '2026-10-19', 'statementOn': '2026-10-20',
        'lastStatement': {
          'amountMinor': 1500000, 'minimumDueMinor': 75000, 'statementOn': '2026-09-20', 'dueOn': '2026-10-08',
          'paidMinor': 0, 'owedMinor': 1500000, 'isPaid': false, 'isEstimate': false, 'fromStatement': true,
        },
        'billIsPaid': false, 'nextDueOn': '2026-10-08', 'daysToDue': -1, 'state': 'close', 'hasCardDetails': true,
      },
      {
        'accountId': 'k2', 'name': 'HDFC Millennia', 'bankName': 'HDFC Bank', 'network': 'MASTERCARD', 'last4': '8899',
        'cycleKnown': false, 'creditLimitMinor': null, 'usedMinor': null, 'unbilledMinor': null, 'state': 'unset',
        'hasCardDetails': false,
      },
    ],
    'banks': [
      {
        'accountId': 'a1', 'name': 'HDFC', 'bankName': 'HDFC Bank', 'accountType': 'BANK', 'last4': '1234',
        'balanceMinor': 4523000, 'isSavings': false, 'pocket': null,
        'debitCards': [{'accountId': 'd1', 'last4': '5555', 'network': 'RUPAY', 'hasCardDetails': false}],
        'hasCardDetails': false,
      },
      {'accountId': 'a2', 'name': 'ICICI', 'bankName': 'ICICI Bank', 'accountType': 'BANK', 'balanceMinor': null, 'debitCards': []},
      {'accountId': 'c1', 'name': 'Cash', 'bankName': 'Cash', 'accountType': 'CASH', 'balanceMinor': 120000, 'debitCards': []},
      {
        'accountId': 'p1', 'name': 'Kotak', 'bankName': 'Kotak', 'accountType': 'BANK', 'balanceMinor': 150000,
        'pocket': {
          'holder': 'Rahul', 'limitMinor': 200000, 'renewDay': 1, 'from': '2026-10-01', 'to': '2026-10-31',
          'renewsOn': '2026-11-01', 'spentMinor': 50000, 'leftMinor': 150000, 'transactionCount': 4,
          'lastMonthSpentMinor': 180000, 'toppedUpMinor': 0, 'renewsToday': false,
        },
        'debitCards': [],
      },
      {'accountId': 's1', 'name': 'SBI', 'bankName': 'SBI', 'accountType': 'BANK', 'last4': '9876', 'balanceMinor': 50000000, 'isSavings': true, 'debitCards': []},
    ],
  },
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
    expect(data.budget.configured, isTrue);
    expect(data.budget.pace!.status, 'high');
    expect(data.budget.categories.first.isOver, isTrue);
    expect(data.budget.unassigned!.categories.last.categoryId, isNull);
    expect(data.budget.bucket.thisMonthMinor, 234000);
    expect(data.wallet.cards.first.network, 'VISA');
    expect(data.wallet.cards.first.state, 'close');
    expect(data.wallet.cards.last.creditLimitMinor, isNull);
    expect(data.wallet.cards.first.billedUnpaidMinor, 1500000);
    expect(data.wallet.cards.first.unbilledMinor, 2500000);
    expect(data.wallet.cards.first.statementOn, '2026-10-20');
    expect(data.wallet.cards.first.lastStatement!.fromStatement, isTrue);
    expect(data.wallet.cards.last.cycleKnown, isFalse);
    expect(data.wallet.banks.first.debitCards.single.network, 'RUPAY');
    expect(data.wallet.banks[3].pocket!.holder, 'Rahul');
    expect(data.wallet.banks.last.isSavings, isTrue);
  });

  test('pocket money reads off an account and the dashboard', () {
    final account = Account.fromJson({
      'id': 'p1',
      'bankName': 'Kotak',
      'accountType': 'BANK',
      'pocketMoney': {'holder': 'Rahul', 'limitMinor': 200000, 'renewDay': 1},
    });
    expect(account.pocketMoney!.holder, 'Rahul');
    expect(account.pocketMoney!.toJson(), {'holder': 'Rahul', 'limitMinor': 200000, 'renewDay': 1});
    expect(Account.fromJson({'id': 'x', 'bankName': 'X', 'accountType': 'BANK'}).pocketMoney, isNull);

    final data = DashboardData.fromJson({
      'pocketMoney': [
        {
          'accountId': 'p1', 'name': 'Kotak', 'holder': 'Rahul', 'limitMinor': 200000, 'renewDay': 1,
          'from': '2026-10-01', 'to': '2026-10-31', 'renewsOn': '2026-11-01',
          'spentMinor': 50000, 'leftMinor': 150000, 'transactionCount': 4,
          'lastMonthSpentMinor': 180000, 'toppedUpMinor': 0, 'renewsToday': true,
        },
      ],
    });
    final pocket = data.pocketMoney.single;
    expect(pocket.renewsOn, '2026-11-01');
    expect(pocket.topUpDue, isTrue);
  });

  test('DashboardData keeps only the fixed costs from the old salary pace', () {
    final data = DashboardData.fromJson({
      'pace': {
        'configured': true,
        'state': 'watch',
        'perDayMinor': 50000,
        'commitmentsRemainingMinor': 1500000,
        'commitments': [
          {'id': 'rent', 'name': 'Rent', 'amountMinor': 1500000, 'dayOfMonth': 5, 'isPaid': false},
          {'id': 'sip', 'name': 'SIP', 'amountMinor': 500000, 'dayOfMonth': 10, 'isPaid': true},
        ],
      },
    });
    expect(data.fixedCosts.configured, isTrue);
    expect(data.fixedCosts.commitmentsRemainingMinor, 1500000);
    expect(data.fixedCosts.commitments.map((c) => c.name), ['Rent', 'SIP']);
    expect(data.fixedCosts.commitments.last.isPaid, isTrue);
    expect(DashboardData.fromJson({'pace': {'configured': false}}).fixedCosts.commitments, isEmpty);
  });

  test('DashboardData copes with an older server', () {
    final data = DashboardData.fromJson({});
    expect(data.money.accounts, isEmpty);
    expect(data.earmarks.count, 0);
    expect(data.planWarnings, isEmpty);
    expect(data.budget.configured, isFalse);
    expect(data.budget.pace, isNull);
    expect(data.wallet.isEmpty, isTrue);
    expect(data.fixedCosts.configured, isFalse);
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

      await tester.pumpWidget(_wrap(
        Column(
          children: [
            PlanWarnings(warnings: data.planWarnings, onOpenPlan: () {}),
            MonthlyBudgetCard(budget: data.budget, onEdit: () {}),
            const SizedBox(height: 12),
            WalletSection(
              money: data.money,
              wallet: data.wallet,
              onOpenCard: (_) {},
              onOpenAccount: (_) {},
              onManage: () {},
            ),
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

      expect(find.text('Over by ₹600'), findsOneWidget);
      expect(find.text('+₹2,340 if the month ended now'), findsOneWidget);

      // The savings account sits last, its amount hidden until asked for.
      final savings = find.text('Savings · tap to show');
      expect(savings, findsOneWidget);
      expect(find.text('₹5,00,000.00'), findsNothing);
      await tester.ensureVisible(savings);
      await tester.tap(savings);
      await tester.pump();
      expect(find.text('₹5,00,000.00'), findsOneWidget);
      expect(find.text('Savings · not counted · tap to hide'), findsOneWidget);
    });
  }
}
