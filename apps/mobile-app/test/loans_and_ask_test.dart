import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/ask_screen.dart';

void main() {
  group('Loan.fromJson', () {
    test('reads the next instalment due', () {
      final loan = Loan.fromJson({
        'id': 'l1',
        'label': 'HDFC personal loan',
        'principalMinor': 12000000,
        'months': 12,
        'monthlyAmountMinor': 1050000,
        'totalPayableMinor': 12600000,
        'interestRatePctAnnual': 10.5,
        'startDate': '2026-04-05T00:00:00.000Z',
        'paidCount': 5,
        'remainingMinor': 7350000,
        'status': 'ACTIVE',
        'nextDue': {'seq': 6, 'dueDate': '2026-09-05T00:00:00.000Z', 'amountMinor': 1050000},
      });

      expect(loan.paidCount, 5);
      expect(loan.interestRatePctAnnual, 10.5);
      expect(loan.nextDue?.seq, 6);
      expect(loan.nextDue?.amountMinor, 1050000);
      expect(loan.nextDue?.dueDate, DateTime.utc(2026, 9, 5));
    });

    test('copes with the fields an older server leaves out', () {
      final loan = Loan.fromJson({'id': 'l1', 'label': 'Advance', 'nextDue': null});

      expect(loan.months, 0);
      expect(loan.nextDue, isNull);
      expect(loan.startDate, isNull);
      expect(loan.interestRatePctAnnual, isNull);
    });
  });

  test('the dashboard lists each active loan', () {
    final data = DashboardData.fromJson({
      'loans': {
        'count': 1,
        'monthlyMinor': 500000,
        'remainingMinor': 3000000,
        'loans': [
          {'id': 'l1', 'label': 'Car', 'months': 10, 'monthlyAmountMinor': 500000, 'paidCount': 4},
        ],
      },
    });

    expect(data.loans, hasLength(1));
    expect(data.loans.first.label, 'Car');
    expect(data.loans.first.paidCount, 4);
  });

  group('SimpleMarkdown.inlineSpans', () {
    const base = TextStyle(fontSize: 14);

    test('bolds what sits between double asterisks', () {
      final spans = SimpleMarkdown.inlineSpans('You spent **₹4,200** on food', base);

      expect(spans.map((s) => s.text), ['You spent ', '₹4,200', ' on food']);
      expect(spans[1].style?.fontWeight, FontWeight.w700);
      expect(spans[0].style?.fontWeight, isNull);
    });

    test('leaves an unmatched marker showing rather than bolding the rest', () {
      final spans = SimpleMarkdown.inlineSpans('**Total** is 5 ** 2', base);

      expect(spans.map((s) => s.text).join(), 'Total is 5 ** 2');
      expect(spans.last.style?.fontWeight, isNull);
    });
  });
}
