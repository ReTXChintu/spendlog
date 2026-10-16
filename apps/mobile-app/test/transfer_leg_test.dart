import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/passbook_screen.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';
import 'package:spendlog/widgets/transaction_tile.dart';

// The other side of a transfer, as the server writes it in when that
// bank never texted it: the chip that says so, on a ledger row and in the
// passbook, and the snackbar that says what saving a transfer did.

const _hdfc = {'id': '64a000000000000000000001', 'bankName': 'HDFC Bank', 'last4': '8342', 'accountType': 'BANK'};
const _federal = {'id': '64a000000000000000000002', 'bankName': 'Federal Bank', 'last4': '3295', 'accountType': 'BANK'};

Transaction _row({bool autoLeg = false, bool isTransfer = true}) => Transaction.fromJson({
      'id': '650000000000000000000001',
      'amountMinor': 300000,
      'type': 'CREDIT',
      'merchant': 'Transfer from HDFC Bank ••8342',
      'source': 'MANUAL',
      'isTransfer': isTransfer,
      'transferAccountId': _hdfc['id'],
      'transferPairId': '650000000000000000000002',
      'autoLeg': autoLeg,
      'account': _federal,
      'occurredAt': '2026-10-05T04:30:00.000Z',
    });

Map<String, dynamic> _leg({String action = 'created', String type = 'CREDIT', int amountMinor = 300000}) => {
      'action': action,
      'transactionId': '650000000000000000000002',
      'accountId': _federal['id'],
      'accountName': 'Federal Bank ••3295',
      'type': type,
      'amountMinor': amountMinor,
    };

Future<void> _pump(WidgetTester tester, Widget home) async {
  // Wider than a phone: the test font's square glyphs are far wider than
  // the real one's.
  tester.view.physicalSize = const Size(1440, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: home));
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('the model', () {
    test('reads autoLeg off a transaction, false when it is missing', () {
      expect(_row(autoLeg: true).autoLeg, isTrue);
      expect(Transaction.fromJson({
        'id': 't', 'amountMinor': 1, 'type': 'DEBIT', 'source': 'SMS', 'occurredAt': '2026-10-05T04:30:00.000Z',
      }).autoLeg, isFalse);
    });

    test('reads autoLeg off a passbook row', () {
      final row = PassbookRow.fromJson({'seq': 1, 'kind': 'txn', 'on': '2026-10-05T04:30:00.000Z', 'runningMinor': 1, 'autoLeg': true});
      expect(row.autoLeg, isTrue);
      expect(PassbookRow.fromJson({'seq': 1, 'kind': 'txn', 'runningMinor': 1}).autoLeg, isFalse);
    });

    test('says what saving a transfer did on the other account', () {
      expect(TransferLeg.maybe(_leg())!.message, 'Also recorded ₹3,000 into Federal Bank ••3295');
      expect(
        TransferLeg.maybe({..._leg(type: 'DEBIT'), 'accountName': 'HDFC Bank ••8342'})!.message,
        'Also recorded ₹3,000 out of HDFC Bank ••8342',
      );
      expect(TransferLeg.maybe(_leg(action: 'paired'))!.message, 'Matched with the ₹3,000 already into Federal Bank ••3295');
      expect(TransferLeg.maybe(_leg(amountMinor: 300050))!.message, 'Also recorded ₹3,000.50 into Federal Bank ••3295');
      expect(TransferLeg.maybe(null), isNull);
      expect(TransferLeg.maybe({'action': 'created'}), isNull);
    });
  });

  group('the chip', () {
    testWidgets('marks a written-in leg on a ledger row, with why on a tap', (tester) async {
      await _pump(tester, Scaffold(body: TransactionTile(transaction: _row(autoLeg: true), categories: const [], onUpdated: (_) {})));
      expect(find.text('Added for your transfer'), findsOneWidget);

      await tester.tap(find.text('Added for your transfer'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.textContaining("Your bank didn't text this one"), findsOneWidget);
      await tester.pump(const Duration(seconds: 6));
    });

    testWidgets('is not on a leg a message stands behind', (tester) async {
      await _pump(tester, Scaffold(body: TransactionTile(transaction: _row(), categories: const [], onUpdated: (_) {})));
      expect(find.text('Added for your transfer'), findsNothing);
      expect(find.text('Not counted'), findsOneWidget);
    });

    testWidgets('marks it in the passbook too', (tester) async {
      final page = {
        'account': {..._federal, 'name': 'Federal Bank'},
        'openingMinor': 500000,
        'openingAt': '2026-10-01T00:00:00.000Z',
        'expectedNowMinor': 800000,
        'lastStated': null,
        'firstDrift': null,
        'total': 2,
        'nextBefore': null,
        'rows': [
          {
            'seq': 1, 'kind': 'txn', 'on': '2026-10-05T04:30:00.000Z', 'transactionId': '650000000000000000000001',
            'merchant': 'Transfer from HDFC Bank ••8342', 'type': 'CREDIT', 'amountMinor': 300000, 'runningMinor': 800000,
            'source': 'MANUAL', 'isTransfer': true, 'transferAccountId': _hdfc['id'], 'autoLeg': true,
          },
          {'seq': 0, 'kind': 'opening', 'on': '2026-10-01T00:00:00.000Z', 'runningMinor': 500000, 'statedMinor': 500000, 'driftMinor': 0},
        ],
      };
      await http.runWithClient(() async {
        await _pump(tester, PassbookScreen(accountId: _federal['id']!));
        await tester.pumpAndSettle();
        expect(find.text('Transfer from HDFC Bank ••8342'), findsOneWidget);
        expect(find.text('Added for your transfer'), findsOneWidget);
        expect(tester.takeException(), isNull);
      }, () => MockClient((request) async {
            final body = request.url.path.endsWith('/passbook') ? jsonEncode(page) : '[]';
            return http.Response(body, 200, headers: {'content-type': 'application/json; charset=utf-8'});
          }));
    });
  });

  group('marking a transfer', () {
    testWidgets('says what was recorded on the other account once the sheet closes', (tester) async {
      final accounts = [Account.fromJson(_hdfc), Account.fromJson(_federal)];
      final transfer = Transaction.fromJson({
        'id': '650000000000000000000002',
        'amountMinor': 300000,
        'type': 'DEBIT',
        'merchant': 'Transfer to Federal Bank ••3295',
        'source': 'SMS',
        'isTransfer': true,
        'transferAccountId': _federal['id'],
        'account': _hdfc,
        'occurredAt': '2026-10-05T04:30:00.000Z',
      });

      await http.runWithClient(() async {
        await _pump(
          tester,
          Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showEditTransactionSheet(context, transaction: transfer, categories: const [], accounts: accounts),
                child: const Text('Open'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();

        await tester.ensureVisible(find.text('Save'));
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();

        expect(find.text('Also recorded ₹3,000 into Federal Bank ••3295'), findsOneWidget);
      }, () => MockClient((request) async {
            if (request.method == 'PATCH') {
              return http.Response(jsonEncode({'id': transfer.id, 'transferLeg': _leg()}), 200,
                  headers: {'content-type': 'application/json; charset=utf-8'});
            }
            final body = request.url.path.endsWith('/contacts') ? '{"contacts": []}' : '[]';
            return http.Response(body, 200);
          }));
    });

    testWidgets('says nothing when the other side was already in place', (tester) async {
      await http.runWithClient(() async {
        await _pump(
          tester,
          Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showEditTransactionSheet(context, transaction: _row(), categories: const [], accounts: const []),
                child: const Text('Open'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Save'));
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();
        expect(find.byType(SnackBar), findsNothing);
      }, () => MockClient((request) async {
            if (request.method == 'PATCH') return http.Response('{"transferLeg": null}', 200);
            final body = request.url.path.endsWith('/contacts') ? '{"contacts": []}' : '[]';
            return http.Response(body, 200);
          }));
    });
  });

  group('a card bill', () {
    const hdfcCard = {'id': '64a000000000000000000003', 'bankName': 'HDFC Bank', 'last4': '1377', 'accountType': 'CARD'};
    Transaction cardLeg() => Transaction.fromJson({
          'id': '650000000000000000000003',
          'amountMinor': 1200000,
          'type': 'CREDIT',
          'merchant': 'Payment from Federal Bank ••5130',
          'source': 'MANUAL',
          'isTransfer': true,
          'transferAccountId': _federal['id'],
          'transferPairId': '650000000000000000000004',
          'autoLeg': true,
          'account': hdfcCard,
          'occurredAt': '2026-10-05T04:30:00.000Z',
        });
    Map<String, dynamic> cardResult({String action = 'created'}) => {
          'action': action,
          'transactionId': '650000000000000000000003',
          'accountId': hdfcCard['id'],
          'accountName': 'HDFC Bank ••1377',
          'type': 'CREDIT',
          'amountMinor': 1200000,
          'kind': 'CARD_BILL',
        };

    test('words the snackbar as money paid into the card', () {
      expect(TransferLeg.maybe(cardResult())!.message, 'Also recorded ₹12,000 paid into HDFC Bank ••1377');
      expect(TransferLeg.maybe(cardResult(action: 'paired'))!.message,
          'Matched with the ₹12,000 already paid into HDFC Bank ••1377');
      expect(TransferLeg.maybe(cardResult())!.forCardBill, isTrue);
      expect(TransferLeg.maybe(_leg())!.forCardBill, isFalse);
    });

    testWidgets('marks the written-in payment on the card as one, with why on a tap', (tester) async {
      await _pump(tester, Scaffold(body: TransactionTile(transaction: cardLeg(), categories: const [], onUpdated: (_) {})));
      expect(find.text('Added for your bill payment'), findsOneWidget);
      expect(find.text('Added for your transfer'), findsNothing);

      await tester.tap(find.text('Added for your bill payment'));
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.textContaining("Your card company didn't text this one"), findsOneWidget);
      await tester.pump(const Duration(seconds: 6));
    });

    testWidgets('says what was recorded on the card once a payment is marked as its bill', (tester) async {
      final accounts = [Account.fromJson(_federal), Account.fromJson(hdfcCard)];
      final payment = Transaction.fromJson({
        'id': '650000000000000000000004',
        'amountMinor': 1200000,
        'type': 'DEBIT',
        'merchant': 'NEFT HDFC CARDS',
        'source': 'SMS',
        'isTransfer': false,
        'cardPaymentFor': hdfcCard['id'],
        'account': _federal,
        'occurredAt': '2026-10-05T04:30:00.000Z',
      });

      await http.runWithClient(() async {
        await _pump(
          tester,
          Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showEditTransactionSheet(context, transaction: payment, categories: const [], accounts: accounts),
                child: const Text('Open'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();

        await tester.ensureVisible(find.text('Save'));
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();

        expect(find.text('Also recorded ₹12,000 paid into HDFC Bank ••1377'), findsOneWidget);
      }, () => MockClient((request) async {
            if (request.method == 'PATCH') {
              return http.Response(jsonEncode({'id': payment.id, 'transferLeg': cardResult()}), 200,
                  headers: {'content-type': 'application/json; charset=utf-8'});
            }
            final body = request.url.path.endsWith('/contacts') ? '{"contacts": []}' : '[]';
            return http.Response(body, 200);
          }));
    });
  });
}
