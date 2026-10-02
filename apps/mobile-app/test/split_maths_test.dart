import 'package:flutter_test/flutter_test.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/utils/split.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';

void main() {
  group('splitEqually', () {
    test('4200 among three people and me: 1050 each, the same for me', () {
      final result = splitEqually(totalMinor: 420000, people: 3, includeMe: true);
      expect(result.owedMinor, [105000, 105000, 105000]);
      expect(result.myShareMinor, 105000);
      expect(result.isOver, isFalse);
    });

    test('leftover paise go to me, not to the people who owe', () {
      final result = splitEqually(totalMinor: 10000, people: 2, includeMe: true);
      expect(result.owedMinor, [3333, 3333]);
      expect(result.myShareMinor, 3334);
    });

    test('without me it is lending: my share is exactly 0', () {
      final result = splitEqually(totalMinor: 10000, people: 3, includeMe: false);
      expect(result.myShareMinor, 0);
      expect(result.owedMinor.reduce((a, b) => a + b), 10000);
    });

    test('nobody named: all mine with me in, none of it without', () {
      expect(splitEqually(totalMinor: 5000, people: 0, includeMe: true).myShareMinor, 5000);
      expect(splitEqually(totalMinor: 5000, people: 0, includeMe: false).myShareMinor, 0);
    });

    test('always adds back up to the total', () {
      for (final (total, people) in [(420000, 3), (99, 7), (1, 4), (123457, 6)]) {
        final result = splitEqually(totalMinor: total, people: people, includeMe: true);
        expect(result.owedMinor.fold<int>(0, (a, b) => a + b) + result.myShareMinor, total);
      }
    });
  });

  group('splitCustom', () {
    test('my share is whatever the typed amounts leave', () {
      final result = splitCustom(totalMinor: 420000, owedMinor: [100000, 150000, 50000]);
      expect(result.myShareMinor, 120000);
      expect(result.isOver, isFalse);
    });

    test('typed amounts that use up the total leave me 0', () {
      final result = splitCustom(totalMinor: 420000, owedMinor: [210000, 210000]);
      expect(result.myShareMinor, 0);
      expect(result.isOver, isFalse);
    });

    test('typing more than the total is flagged, not clamped away', () {
      final result = splitCustom(totalMinor: 100000, owedMinor: [80000, 30000]);
      expect(result.isOver, isTrue);
      expect(result.overByMinor, 10000);
      expect(result.myShareMinor, 0);
    });
  });

  group('looksLikeRawPayee', () {
    test('bank and UPI strings are raw', () {
      expect(looksLikeRawPayee('9876543210@ybl'), isTrue);
      expect(looksLikeRawPayee('NEFT 0042 HDFC'), isTrue);
      expect(looksLikeRawPayee(''), isTrue);
    });

    test('names a person typed are not', () {
      expect(looksLikeRawPayee('Rent to Mr Sharma'), isFalse);
      expect(looksLikeRawPayee('Transfer to Cash'), isFalse);
    });
  });

  test('Transaction reads the transfer and earmark fields, and tolerates them missing', () {
    final base = {
      'id': 't1',
      'amountMinor': 800000,
      'type': 'CREDIT',
      'source': 'MANUAL',
      'occurredAt': '2026-10-01T10:00:00.000Z',
    };
    final plain = Transaction.fromJson(base);
    expect(plain.isEarmarked, isFalse);
    expect(plain.transferAccountId, isNull);
    expect(plain.transferPairId, isNull);

    final full = Transaction.fromJson({
      ...base,
      'isEarmarked': true,
      'transferAccountId': 'a2',
      'transferPairId': 'p1',
    });
    expect(full.isEarmarked, isTrue);
    expect(full.transferAccountId, 'a2');
    expect(full.transferPairId, 'p1');
  });
}
