import 'package:flutter_test/flutter_test.dart';
import 'package:spendlog/services/plan_warning_rule.dart';

void main() {
  // Wall-clock IST, as the background task builds it.
  DateTime at(int day, int hour, [int minute = 0]) => DateTime.utc(2026, 10, day, hour, minute);

  const food = 'Food & Dining|over';

  group('shouldWarnAboutPlan', () {
    test('warns the first time, in the daytime', () {
      expect(shouldWarnAboutPlan(nowIst: at(3, 9), signature: food, history: const PlanWarnHistory()), isTrue);
    });

    test('never with nothing to warn about', () {
      expect(shouldWarnAboutPlan(nowIst: at(3, 9), signature: '', history: const PlanWarnHistory()), isFalse);
    });

    test('stays quiet from 22:00 to 08:00', () {
      for (final hour in [22, 23, 0, 3, 7]) {
        expect(
          shouldWarnAboutPlan(nowIst: at(3, hour, 30), signature: food, history: const PlanWarnHistory()),
          isFalse,
          reason: 'hour $hour',
        );
      }
      expect(shouldWarnAboutPlan(nowIst: at(3, 8), signature: food, history: const PlanWarnHistory()), isTrue);
    });

    test('repeats the same warning only after six hours', () {
      final history = recordPlanWarning(const PlanWarnHistory(), at(3, 9), food);
      expect(shouldWarnAboutPlan(nowIst: at(3, 14, 59), signature: food, history: history), isFalse);
      expect(shouldWarnAboutPlan(nowIst: at(3, 15), signature: food, history: history), isTrue);
    });

    test('a newly broken rule can come sooner, but not within the hour', () {
      final history = recordPlanWarning(const PlanWarnHistory(), at(3, 9), food);
      const more = '$food;Shopping|watch';
      expect(shouldWarnAboutPlan(nowIst: at(3, 9, 30), signature: more, history: history), isFalse);
      expect(shouldWarnAboutPlan(nowIst: at(3, 10), signature: more, history: history), isTrue);
    });

    test('no more than three a day, and the count resets the next day', () {
      var history = const PlanWarnHistory();
      final shown = [at(3, 8), at(3, 10, 0), at(3, 12, 0)];
      final signatures = ['a|over', 'b|over', 'c|over'];
      for (var i = 0; i < 3; i += 1) {
        expect(shouldWarnAboutPlan(nowIst: shown[i], signature: signatures[i], history: history), isTrue);
        history = recordPlanWarning(history, shown[i], signatures[i]);
      }
      expect(history.shownThatDay, 3);
      expect(shouldWarnAboutPlan(nowIst: at(3, 20), signature: 'd|over', history: history), isFalse);
      expect(shouldWarnAboutPlan(nowIst: at(4, 9), signature: 'd|over', history: history), isTrue);
      expect(recordPlanWarning(history, at(4, 9), 'd|over').shownThatDay, 1);
    });
  });

  group('wording', () {
    test('signature ignores the amounts and the order', () {
      final a = planWarningSignature([
        {'category': 'Food & Dining', 'state': 'over', 'spentMinor': 420000},
        {'category': 'Shopping', 'state': 'watch'},
      ]);
      final b = planWarningSignature([
        {'category': 'Shopping', 'state': 'watch'},
        {'category': 'Food & Dining', 'state': 'over', 'spentMinor': 430000},
      ]);
      expect(a, b);
    });

    test('one rule over its cap names the figures', () {
      final message = planWarningMessage([
        {
          'text': 'Keep eating out under ₹3,000',
          'category': 'Food & Dining',
          'monthlyCapMinor': 300000,
          'spentMinor': 420000,
          'state': 'over',
        },
      ]);
      expect(message.title, 'Over your plan: Food & Dining ₹4,200 of ₹3,000');
    });

    test('several rules are counted', () {
      final message = planWarningMessage([
        {'text': 'No impulse buys', 'state': 'watch'},
        {'text': 'Cook at home', 'state': 'over'},
      ]);
      expect(message.title, '2 savings rules being broken this month');
    });
  });
}
