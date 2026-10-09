import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/monthly_budget_screen.dart';
import 'package:spendlog/services/vault_session.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/home/card_face.dart';
import 'package:spendlog/widgets/home/monthly_budget_card.dart';
import 'package:spendlog/widgets/home/wallet.dart';

Widget _wrap(Widget child, {Brightness brightness = Brightness.light, bool reduceMotion = false}) => MaterialApp(
      theme: buildTheme(brightness),
      home: Builder(
        builder: (context) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
          child: Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(16), child: child)),
        ),
      ),
    );

/// A phone: 360 × 800 logical pixels.
void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

MonthPace _pace(String status, {int safe = 30000, int daysLeft = 6, String? runOutOn, int remaining = 234000}) =>
    MonthPace(status: status, safeDailyMinor: safe, daysLeft: daysLeft, runOutOn: runOutOn, remainingMinor: remaining);

CardFace _card({bool hasDetails = true, String state = 'ok'}) => CardFace.fromJson({
      'accountId': 'k1',
      'name': 'Regalia',
      'bankName': 'HDFC Bank',
      'network': 'VISA',
      'last4': '1234',
      'creditLimitMinor': 30000000,
      'usedMinor': 4000000,
      'availableMinor': 26000000,
      'cycleSpentMinor': 2500000,
      'nextDueOn': '2026-10-18',
      'daysToDue': 9,
      'state': state,
      'hasCardDetails': hasDetails,
    });

const _details = VaultDetails(
  accountId: 'k1',
  number: '4111111111111234',
  expiry: '08/29',
  nameOnCard: 'Biswajit Panda',
  last4: '1234',
);

void main() {
  group('MonthlyBudgetStatus', () {
    test('reads a month with limits, the pool and the bucket', () {
      final status = MonthlyBudgetStatus.fromJson({
        'configured': true,
        'everSet': true,
        'month': {'key': '2026-10', 'label': 'Oct 2026', 'isCurrent': true, 'daysInMonth': 31, 'dayOfMonth': 9, 'daysLeft': 23},
        'budgetMinor': 2000000,
        'spentMinor': 500000,
        'leftMinor': 1500000,
        'pace': {'status': 'on_track', 'safeDailyMinor': 65000, 'daysLeft': 23, 'runOutOn': null},
        'categories': [
          {'categoryId': 'c1', 'name': 'Dining', 'limitMinor': 300000, 'spentMinor': 100000, 'pace': {'status': 'high'}},
        ],
        'unassigned': null,
        'bucket': {'configured': false},
        'suggestedMonthlyMinor': 3100000,
      });
      expect(status.configured, isTrue);
      expect(status.month.dayOfMonth, 9);
      expect(status.pace!.status, 'on_track');
      expect(status.pace!.runOutOn, isNull);
      expect(status.categories.single.pace!.isHigh, isTrue);
      expect(status.unassigned, isNull);
      expect(status.bucket.configured, isFalse);
      expect(status.suggestedMonthlyMinor, 3100000);
    });

    test('a status with no amount is not a budget, and unknown values fall back', () {
      final status = MonthlyBudgetStatus.fromJson({
        'configured': true,
        'budgetMinor': null,
        'pace': {'status': 'something new'},
        'categories': 'not a list',
      });
      expect(status.configured, isFalse);
      expect(status.pace!.status, 'on_track');
      expect(status.categories, isEmpty);
    });

    test('card faces fall back for a state or network they do not know', () {
      final card = CardFace.fromJson({'accountId': 'x', 'network': 'visa', 'state': 'weird'});
      expect(card.network, 'VISA');
      expect(card.state, 'unset');
      expect(card.name, 'Card');
    });
  });

  group('paceMessage', () {
    test('on track says what a day can safely cost', () {
      expect(paceMessage(_pace('on_track', safe: 65000, daysLeft: 23)), 'On track · ₹650/day is safe for the next 23 days');
      expect(paceMessage(_pace('on_track', daysLeft: 1)), 'On track · ₹300/day is safe for today');
    });

    test('high names the daily figure and the day it runs out', () {
      expect(
        paceMessage(_pace('high', runOutOn: '2026-10-03')),
        "Pace is high — slow down. Keep to ₹300/day or you'll run out by 3 Oct.",
      );
      expect(
        paceMessage(_pace('high')),
        'Pace is high — slow down. Keep to ₹300/day for the next 6 days to stay inside the budget.',
      );
      expect(paceMessage(_pace('high', safe: 0)), contains('spoken for by bills still due'));
    });

    test('over is firm and says by how much', () {
      expect(paceMessage(_pace('over', remaining: -230000)), startsWith('Over budget by ₹2,300.'));
      expect(paceMessage(_pace('over', remaining: 0)), startsWith('The budget is used up.'));
    });
  });

  group('MonthlyBudgetCard', () {
    testWidgets('shows the pace line, the over limit and the bucket', (tester) async {
      _phone(tester);
      final budget = MonthlyBudgetStatus.fromJson({
        'configured': true,
        'month': {'label': 'Oct 2026', 'isCurrent': true, 'daysInMonth': 31, 'dayOfMonth': 28, 'daysLeft': 4},
        'budgetMinor': 2000000,
        'spentMinor': 1900000,
        'leftMinor': 100000,
        'pace': {'status': 'high', 'safeDailyMinor': 25000, 'daysLeft': 4, 'runOutOn': '2026-10-30', 'expectedSpentMinor': 1800000},
        'categories': [
          {'categoryId': 'c1', 'name': 'Dining', 'limitMinor': 300000, 'spentMinor': 350000, 'isOver': true},
        ],
        'unassigned': {'amountMinor': 1700000, 'spentMinor': 1550000, 'categories': [{'name': 'Rent', 'spentMinor': 1200000}]},
        'bucket': {'configured': true, 'balanceMinor': 1000000, 'balanceIfMonthEndedNowMinor': 1100000},
      });
      var edited = false;
      await tester.pumpWidget(_wrap(MonthlyBudgetCard(budget: budget, onEdit: () => edited = true)));

      expect(tester.takeException(), isNull);
      expect(find.text("Pace is high — slow down. Keep to ₹250/day or you'll run out by 30 Oct."), findsOneWidget);
      expect(find.text('Over by ₹500'), findsOneWidget);
      expect(find.text('Unplanned'), findsOneWidget);
      expect(find.text('Mostly Rent'), findsOneWidget);
      expect(find.text('+₹1,000 if the month ended now'), findsOneWidget);

      await tester.tap(find.text('Edit budget'));
      expect(edited, isTrue);
    });

    testWidgets('offers the old daily budget as a start when none is set', (tester) async {
      _phone(tester);
      await tester.pumpWidget(_wrap(MonthlyBudgetCard(
        budget: MonthlyBudgetStatus.fromJson({'configured': false, 'suggestedMonthlyMinor': 3100000}),
        onEdit: () {},
      )));
      expect(find.text('Set a monthly budget'), findsOneWidget);
      expect(find.text('Start with ₹31,000'), findsOneWidget);
    });
  });

  group('MonthlyBudgetScreen', () {
    final categories = [
      Category(id: 'dining', name: 'Dining', direction: 'OUT', isSystem: true),
      Category(id: 'groceries', name: 'Groceries', direction: 'OUT', isSystem: true),
      Category(id: 'salary', name: 'Salary', direction: 'IN', isSystem: true),
    ];
    final status = MonthlyBudgetStatus.fromJson({
      'configured': true,
      'month': {'label': 'Oct 2026'},
      'budgetMinor': 2000000,
      'categories': [
        {'categoryId': 'dining', 'name': 'Dining', 'limitMinor': 500000},
      ],
    });

    FilledButton saveButton(WidgetTester tester) =>
        tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Save budget'));

    testWidgets('meters what is assigned and refuses to save past the total', (tester) async {
      _phone(tester);
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(Brightness.light),
        home: MonthlyBudgetScreen(initial: status, categories: categories),
      ));

      expect(find.text('₹5,000 of ₹20,000 assigned · ₹15,000 unassigned'), findsOneWidget);
      expect(saveButton(tester).onPressed, isNotNull);

      await tester.enterText(find.byKey(const Key('limit-dining')), '25000');
      await tester.pump();
      expect(find.text('₹25,000 of ₹20,000 assigned · ₹5,000 over'), findsOneWidget);
      expect(find.textContaining("Limits can't come to more than the budget"), findsOneWidget);
      expect(saveButton(tester).onPressed, isNull);

      // Raising the total is the other way out.
      await tester.enterText(find.byKey(const Key('budget-total')), '30000');
      await tester.pump();
      expect(find.text('₹25,000 of ₹30,000 assigned · ₹5,000 unassigned'), findsOneWidget);
      expect(saveButton(tester).onPressed, isNotNull);

      // No total, nothing to save.
      await tester.enterText(find.byKey(const Key('budget-total')), '');
      await tester.pump();
      expect(find.text('Enter the total for the month first.'), findsOneWidget);
      expect(saveButton(tester).onPressed, isNull);
    });

    testWidgets('only offers categories money goes out on', (tester) async {
      _phone(tester);
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(Brightness.light),
        home: MonthlyBudgetScreen(initial: status, categories: categories),
      ));

      await tester.tap(find.text('Add a limit'));
      await tester.pumpAndSettle();
      expect(find.text('Groceries'), findsOneWidget);
      expect(find.text('Salary'), findsNothing);

      await tester.tap(find.text('Groceries'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('limit-groceries')), '6000');
      await tester.pump();
      expect(find.text('₹11,000 of ₹20,000 assigned · ₹9,000 unassigned'), findsOneWidget);
    });
  });

  group('CardFaceView', () {
    testWidgets('shows only the last four, and the eye only with details stored', (tester) async {
      _phone(tester);
      await tester.pumpWidget(_wrap(SizedBox(width: 328, child: CardFaceView(card: _card(), onAddDetails: () {}))));

      expect(tester.takeException(), isNull);
      expect(find.text('•••• •••• •••• 1234'), findsOneWidget);
      expect(find.textContaining('4111'), findsNothing);
      expect(find.text('VISA'), findsOneWidget);
      expect(find.byTooltip('Show card details'), findsOneWidget);
      expect(find.text('Add card details'), findsNothing);

      await tester.pumpWidget(_wrap(SizedBox(
        width: 328,
        child: CardFaceView(card: _card(hasDetails: false), onAddDetails: () {}),
      )));
      expect(find.byTooltip('Show card details'), findsNothing);
      expect(find.text('Add card details'), findsOneWidget);
    });

    testWidgets('the eye asks for the PIN, turns the card over, and turns it back', (tester) async {
      _phone(tester);
      String? pinUsed;
      var opened = false;
      await tester.pumpWidget(_wrap(SizedBox(
        width: 328,
        child: CardFaceView(
          card: _card(),
          onOpen: () => opened = true,
          askPin: (_) async => '2468',
          reveal: (accountId, pin) async {
            pinUsed = pin;
            return _details;
          },
          showFor: const Duration(seconds: 5),
        ),
      )));

      // A tap on the face itself is for its transactions, not the back.
      await tester.tap(find.text('•••• •••• •••• 1234'));
      expect(opened, isTrue);

      await tester.tap(find.byTooltip('Show card details'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 700));
      expect(pinUsed, '2468');
      expect(find.text('4111 1111 1111 1234'), findsOneWidget);
      expect(find.text('BISWAJIT PANDA'), findsOneWidget);
      expect(find.text('•••• •••• •••• 1234'), findsNothing);
      expect(find.textContaining('CVV'), findsNothing);

      // A tap on the back turns it face up and forgets the number.
      await tester.tap(find.text('4111 1111 1111 1234'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.text('4111 1111 1111 1234'), findsNothing);
      expect(find.text('•••• •••• •••• 1234'), findsOneWidget);

      // Left alone, it turns itself back.
      await tester.tap(find.byTooltip('Show card details'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.text('4111 1111 1111 1234'), findsOneWidget);
      await tester.pump(const Duration(seconds: 6));
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.text('4111 1111 1111 1234'), findsNothing);

      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('with reduced motion the two sides cross-fade instead', (tester) async {
      _phone(tester);
      await tester.pumpWidget(_wrap(
        SizedBox(
          width: 328,
          child: CardFaceView(card: _card(), askPin: (_) async => '2468', reveal: (_, __) async => _details),
        ),
        reduceMotion: true,
      ));

      await tester.tap(find.byTooltip('Show card details'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 700));
      expect(find.text('4111 1111 1111 1234'), findsOneWidget);
      expect(find.byType(Transform).evaluate().where((e) {
        final transform = (e.widget as Transform).transform;
        return transform.entry(3, 2) != 0;
      }), isEmpty);

      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a cancelled PIN leaves the card face up', (tester) async {
      _phone(tester);
      var asked = false;
      await tester.pumpWidget(_wrap(SizedBox(
        width: 328,
        child: CardFaceView(
          card: _card(),
          askPin: (_) async => null,
          reveal: (_, __) async {
            asked = true;
            return _details;
          },
        ),
      )));
      await tester.tap(find.byTooltip('Show card details'));
      await tester.pump(const Duration(milliseconds: 700));
      expect(asked, isFalse);
      expect(find.text('•••• •••• •••• 1234'), findsOneWidget);
    });
  });

  group('Wallet', () {
    testWidgets('the savings balance stays hidden until tapped', (tester) async {
      _phone(tester);
      const savings = BankFace(accountId: 's1', name: 'SBI', last4: '9876', balanceMinor: 50000000, isSavings: true);
      await tester.pumpWidget(_wrap(BankTile(bank: savings, onOpen: () {})));

      expect(find.text('₹ • • • •'), findsOneWidget);
      expect(find.text('₹5,00,000.00'), findsNothing);
      await tester.tap(find.text('Savings · tap to show'));
      await tester.pump();
      expect(find.text('₹5,00,000.00'), findsOneWidget);
      await tester.tap(find.text('Savings · not counted · tap to hide'));
      await tester.pump();
      expect(find.text('₹5,00,000.00'), findsNothing);
    });

    test('the caption under a card says what is used and what you allowed', () {
      final card = CardFace.fromJson({
        'accountId': 'k1',
        'creditLimitMinor': 30000000,
        'usedMinor': 4000000,
        'availableMinor': 26000000,
        'cycleSpentMinor': 3500000,
        'spendLimitMinor': 3000000,
        'state': 'over',
      });
      expect(cardLimitLine(card), '₹40,000 used of ₹3,00,000 · ₹2,60,000 free');
      expect(cardSecondLine(card), '₹5,000 past your ₹30,000 limit this cycle');
      expect(cardBarFraction(card), closeTo(4000000 / 30000000, 1e-9));
    });

    for (final brightness in Brightness.values) {
      testWidgets('cards and accounts lay out without overflow (${brightness.name})', (tester) async {
        _phone(tester);
        final wallet = Wallet.fromJson({
          'cards': [
            for (final (network, state) in [('VISA', 'ok'), ('MASTERCARD', 'close'), ('RUPAY', 'over'), ('AMEX', 'unset')])
              {
                'accountId': network,
                'name': 'A card with a rather long name for its face',
                'bankName': 'Standard Chartered Bank',
                'network': network,
                'last4': '1234',
                'creditLimitMinor': 30000000,
                'usedMinor': 29000000,
                'cycleSpentMinor': 123456789,
                'spendLimitMinor': 3000000,
                'nextDueOn': '2026-10-10',
                'daysToDue': 1,
                'state': state,
                'hasCardDetails': network != 'AMEX',
              },
          ],
          'banks': [
            {'accountId': 'a1', 'name': 'HDFC', 'accountType': 'BANK', 'balanceMinor': 4523000, 'debitCards': [{'accountId': 'd1', 'last4': '5555', 'network': 'MASTERCARD'}, {'accountId': 'd2', 'last4': '6666'}]},
            {'accountId': 's1', 'name': 'SBI', 'accountType': 'BANK', 'balanceMinor': 50000000, 'isSavings': true},
          ],
        });

        await tester.pumpWidget(_wrap(
          WalletSection(
            money: MoneyOnHand(),
            wallet: wallet,
            onOpenCard: (_) {},
            onOpenAccount: (_) {},
            onManage: () {},
          ),
          brightness: brightness,
        ));
        expect(tester.takeException(), isNull);
        expect(find.byType(CardFaceView), findsWidgets);

        // Swiping brings the next card in.
        await tester.drag(find.byType(PageView), const Offset(-300, 0));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(find.text('Add card details'), findsNothing);
        await tester.drag(find.byType(PageView), const Offset(-300, 0));
        await tester.pumpAndSettle();
        await tester.drag(find.byType(PageView), const Offset(-300, 0));
        await tester.pumpAndSettle();
        expect(find.text('Add card details'), findsOneWidget);
      });
    }
  });
}
