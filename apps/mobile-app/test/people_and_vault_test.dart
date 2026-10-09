import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/services/api_client.dart';
import 'package:spendlog/services/vault_session.dart';
import 'package:spendlog/utils/format.dart';
import 'package:spendlog/utils/split.dart';
import 'package:spendlog/widgets/account_balance_panel.dart';
import 'package:spendlog/widgets/refund_sheet.dart';

Transaction _debit(int amountMinor, {String? merchant, String? note}) => Transaction.fromJson({
      'id': 't1',
      'amountMinor': amountMinor,
      'type': 'DEBIT',
      'merchant': merchant,
      'note': note,
      'source': 'SMS',
      'occurredAt': '2026-09-20T10:00:00.000Z',
    });

void main() {
  group('splitEvenly', () {
    test('puts the leftover paise on the first person', () {
      expect(splitEvenly(10000, 3), [3334, 3333, 3333]);
      expect(splitEvenly(5, 2), [3, 2]);
    });

    test('always adds back up to the whole', () {
      for (final (total, count) in [(800000, 3), (99, 7), (1, 4), (123457, 6)]) {
        expect(splitEvenly(total, count).reduce((a, b) => a + b), total);
      }
    });

    test('nobody, or nothing to share', () {
      expect(splitEvenly(10000, 0), isEmpty);
      expect(splitEvenly(0, 3), [0, 0, 0]);
      expect(splitEvenly(-500, 2), [0, 0]);
    });
  });

  group('parseRupees', () {
    test('reads amounts however they were typed', () {
      expect(parseRupees('1,499.50'), 149950);
      expect(parseRupees('₹ 2000'), 200000);
      expect(parseRupees('0.1'), 10);
    });

    test('refuses a negative unless a balance is being typed', () {
      expect(parseRupees('-350'), isNull);
      expect(parseRupees('-350', allowNegative: true), -35000);
    });

    test('is null for anything that is not a number', () {
      expect(parseRupees(''), isNull);
      expect(parseRupees('abc'), isNull);
      expect(parseRupees('-'), isNull);
    });
  });

  group('refund search', () {
    test('finds a purchase by its amount however it is written', () {
      final purchase = _debit(49900, merchant: 'Amazon');
      expect(refundCandidateMatches(purchase, '499'), isTrue);
      expect(refundCandidateMatches(purchase, '₹499.00'), isTrue);
      expect(refundCandidateMatches(purchase, '499.00'), isTrue);
      expect(refundCandidateMatches(_debit(149900), '1,499'), isTrue);
    });

    test('finds by merchant or note, ignoring case', () {
      final purchase = _debit(12000, merchant: 'Swiggy', note: 'Birthday cake');
      expect(refundCandidateMatches(purchase, 'SWIG'), isTrue);
      expect(refundCandidateMatches(purchase, 'cake'), isTrue);
      expect(refundCandidateMatches(purchase, 'zomato'), isFalse);
      expect(refundCandidateMatches(purchase, '  '), isTrue);
    });
  });

  group('FixedCommitment', () {
    test('this period falls back to the amount from an older server', () {
      final rent = FixedCommitment.fromJson({
        'id': 'c1',
        'name': 'Rent',
        'amountMinor': 300000,
        'dayOfMonth': 5,
      });
      expect(rent.thisPeriodAmountMinor, 300000);
      expect(rent.changesNextPeriod, isFalse);
      expect(rent.amountLabel, '₹3,000.00');
    });

    test('says both figures when a raise starts next period', () {
      final rent = FixedCommitment.fromJson({
        'id': 'c1',
        'name': 'Rent',
        'amountMinor': 300000,
        'thisPeriodAmountMinor': 200000,
        'dayOfMonth': 5,
      });
      expect(rent.changesNextPeriod, isTrue);
      expect(rent.amountLabel, '₹2,000 this month · ₹3,000 from next');
    });
  });

  group('people on a transaction', () {
    test('reads who it was with, and defaults to nobody', () {
      final json = {
        'id': 't1',
        'amountMinor': 120000,
        'type': 'DEBIT',
        'source': 'MANUAL',
        'occurredAt': '2026-09-20T10:00:00.000Z',
        'split': {'myShareMinor': 40000},
        'people': [
          {'contactId': 'a', 'amountMinor': 40000},
          {'contactId': 'b', 'amountMinor': 40000},
        ],
      };
      final withPeople = Transaction.fromJson(json);
      expect(withPeople.people.map((p) => p.contactId), ['a', 'b']);
      expect(withPeople.people.first.toJson(), {'contactId': 'a', 'amountMinor': 40000});

      expect(Transaction.fromJson({...json}..remove('people')).people, isEmpty);
    });

    test('a contact reads its balance', () {
      final contact = Contact.fromJson({
        'id': 'a',
        'name': 'Ravi',
        'phone': '9876543210',
        'balanceMinor': -25000,
        'lastAt': '2026-09-20T10:00:00.000Z',
      });
      expect(contact.youOwe, isTrue);
      expect(contact.owesYou, isFalse);
      expect(contact.lastAt, DateTime.utc(2026, 9, 20, 10));
    });
  });

  group('expected balance', () {
    test('says what the gap most likely is', () {
      expect(describeBalanceCheck(expectedMinor: 500000, bankMinor: 500000), 'Matches — nothing missing.');
      expect(
        describeBalanceCheck(expectedMinor: 500000, bankMinor: 450000),
        "₹500.00 less than expected — likely a payment SpendLog hasn't seen.",
      );
      expect(
        describeBalanceCheck(expectedMinor: 500000, bankMinor: 520000),
        startsWith('₹200.00 more than expected'),
      );
    });

    test('the end of a day is 23:59:59.999 in India', () {
      expect(endOfIstDay(DateTime(2026, 9, 30)).toIso8601String(), '2026-09-30T18:29:59.999Z');
    });
  });

  group('VaultSession', () {
    TestWidgetsFlutterBinding.ensureInitialized();

    late DateTime now;
    late int reveals;
    late VaultSession session;

    setUp(() {
      now = DateTime.utc(2026, 10, 1, 12);
      reveals = 0;
      session = VaultSession(
        clock: () => now,
        revealAll: (pin) async {
          reveals++;
          if (pin != '1234') throw ApiException(403, 'Wrong PIN. 4 attempts left.');
          return [
            {'accountId': 'card', 'number': '4111111111111111', 'expiry': '08/29'},
            {'accountId': 'bank', 'number': '50100123456789', 'ifsc': 'HDFC0001234'},
          ];
        },
        revealOne: (accountId, pin) async {
          if (accountId == 'gone') throw ApiException(404, 'No details are stored for this card.');
          return {'accountId': accountId, 'number': '9999888877776666'};
        },
      );
      addTearDown(session.dispose);
    });

    test('one PIN opens every account', () async {
      await session.unlock('1234');
      expect(reveals, 1);
      expect(session.isUnlocked, isTrue);
      expect(session.pin, '1234');
      expect(session.detailsFor('card')?.number, '4111111111111111');
      expect(session.detailsFor('bank')?.ifsc, 'HDFC0001234');
      expect(session.minutesLeft, 5);
    });

    test('a wrong PIN stays locked and says why', () async {
      await expectLater(
        session.unlock('0000'),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('attempts left'))),
      );
      expect(session.isUnlocked, isFalse);
      expect(session.pin, isNull);
    });

    test('forgets everything after five minutes', () async {
      await session.unlock('1234');
      now = now.add(const Duration(minutes: 4, seconds: 1));
      expect(session.minutesLeft, 1);
      expect(session.isUnlocked, isTrue);

      now = now.add(const Duration(minutes: 1));
      expect(session.isUnlocked, isFalse);
      expect(session.detailsFor('card'), isNull);
      expect(session.pin, isNull);
    });

    test('locks when asked, and when the app goes to the background', () async {
      await session.unlock('1234');
      session.lock();
      expect(session.detailsFor('card'), isNull);

      await session.unlock('1234');
      session.didChangeAppLifecycleState(AppLifecycleState.paused);
      expect(session.isUnlocked, isFalse);
      expect(session.pin, isNull);
    });

    test('refreshes one account after a save, and drops one that is gone', () async {
      await session.unlock('1234');
      await session.refresh('card');
      expect(session.detailsFor('card')?.number, '9999888877776666');

      await session.refresh('gone');
      expect(session.detailsFor('gone'), isNull);
      expect(session.isUnlocked, isTrue);
    });
  });

  group('clearing what someone owes', () {
    test('reads clearances apart from the transaction history', () {
      final detail = ContactDetail.fromJson({
        'id': 'c1',
        'name': 'Rahul',
        'balanceMinor': 100,
        'openingBalanceMinor': 100000,
        'clearedMinor': 99900,
        'history': [],
        'clearances': [
          {
            'id': 'k1',
            'amountMinor': 99900,
            'direction': 'OWED_TO_ME',
            'note': 'Bought me a watch',
            'on': '2026-10-01T06:30:00.000Z',
            'effectMinor': -99900,
          },
          {'id': 'k2', 'amountMinor': 5000, 'direction': 'OWED_BY_ME', 'on': '2026-09-01T06:30:00.000Z'},
        ],
      });
      expect(detail.contact.clearedMinor, 99900);
      expect(detail.history, isEmpty);
      expect(detail.clearances.length, 2);
      expect(detail.clearances.first.clearedTheirs, isTrue);
      expect(detail.clearances.first.note, 'Bought me a watch');
      // An older server without effectMinor: worked out from the direction.
      expect(detail.clearances.last.clearedTheirs, isFalse);
      expect(detail.clearances.last.effectMinor, 5000);
    });

    test('a server from before clearances still reads', () {
      final detail = ContactDetail.fromJson({'id': 'c1', 'name': 'Rahul', 'history': []});
      expect(detail.clearances, isEmpty);
      expect(detail.contact.clearedMinor, 0);
    });
  });
}
