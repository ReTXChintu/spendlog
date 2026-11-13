import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';

/// The user's own categories, as the sheet gets them.
final _categories = [
  for (final (id, name, kind) in const [
    ('transfers', 'Transfers', 'BOTH'),
    ('lent', 'Lent & borrowed', 'BOTH'),
    ('emi', 'EMI & Loans', 'DEBIT'),
    ('income', 'Income', 'CREDIT'),
    ('food', 'Food & Dining', 'DEBIT'),
  ])
    Category.fromJson({'id': id, 'name': name, 'color': '#112233', 'kind': kind}),
];

final _accounts = [
  Account.fromJson({
    'id': 'sbi', 'bankName': 'SBI', 'last4': '1234', 'accountType': 'BANK', 'isActive': true,
  }),
  Account.fromJson({
    'id': 'hdfc-card', 'bankName': 'HDFC', 'last4': '9988', 'accountType': 'CARD', 'isActive': true,
  }),
];

const _loan = {
  'id': 'car', 'label': 'Car loan', 'principalMinor': 50000000, 'months': 36,
  'monthlyAmountMinor': 1500000, 'totalPayableMinor': 54000000, 'paidCount': 4,
  'remainingMinor': 45000000, 'status': 'ACTIVE',
};

Transaction _row({String type = 'DEBIT', String merchant = 'NEFT/MB/0092811', int amountMinor = 1500000}) =>
    Transaction.fromJson({
      'id': 't1',
      'amountMinor': amountMinor,
      'type': type,
      'merchant': merchant,
      'accountId': 'sbi',
      'source': 'SMS',
      'occurredAt': '2026-11-03T10:00:00.000Z',
    });

MockClient _server(List<Map<String, dynamic>> patches) => MockClient((request) async {
      if (request.method == 'PATCH') {
        patches.add(jsonDecode(request.body) as Map<String, dynamic>);
        return http.Response('{}', 200);
      }
      final path = request.url.path;
      if (path.endsWith('/loans')) return http.Response(jsonEncode([_loan]), 200);
      if (path.endsWith('/split-suggestion')) {
        return http.Response(
          jsonEncode({
            'loans': [
              {'loanId': 'car', 'label': 'Car loan', 'dueMinor': 1500000, 'instalmentMinor': 1500000},
            ],
            'matches': [{'loanIds': ['car'], 'totalMinor': 1500000}],
          }),
          200,
        );
      }
      if (path.endsWith('/contacts')) {
        return http.Response(jsonEncode({'contacts': [{'id': 'rahul', 'name': 'Rahul'}]}), 200);
      }
      if (path.endsWith('/subscriptions')) return http.Response('{"items": [], "totals": {}}', 200);
      return http.Response('[]', 200);
    });

Future<void> _open(WidgetTester tester, Transaction transaction) async {
  tester.view.physicalSize = const Size(1600, 3200);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);

  await tester.pumpWidget(MaterialApp(
    theme: buildTheme(Brightness.light),
    home: Scaffold(
      body: Builder(
        builder: (context) => TextButton(
          onPressed: () => showEditTransactionSheet(
            context,
            transaction: transaction,
            categories: _categories,
            accounts: _accounts,
          ),
          child: const Text('Open'),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

Future<void> _pickKind(WidgetTester tester, String label) async {
  await tester.ensureVisible(find.text(label));
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

/// What the merchant box reads now.
String _merchant(WidgetTester tester) =>
    tester.widget<TextField>(find.byKey(const ValueKey('merchant-field'))).controller?.text ?? '';

/// Which category the picker shows as chosen.
String _category(WidgetTester tester) {
  for (final name in ['Transfers', 'Lent & borrowed', 'EMI & Loans', 'Income', 'Food & Dining']) {
    if (find.text(name).evaluate().isNotEmpty) return name;
  }
  return '';
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('a kind names itself', () {
    testWidgets('a card bill takes the card and the Transfers category', (tester) async {
      await http.runWithClient(() async {
        await _open(tester, _row());
        await _pickKind(tester, 'Card bill');
        // Which card it settled has to be picked; the name follows it.
        await tester.tap(find.text('Which card?'));
        await tester.pumpAndSettle();
        await tester.tap(find.textContaining('HDFC').last);
        await tester.pumpAndSettle();

        expect(_merchant(tester), 'HDFC card bill');
        expect(_category(tester), 'Transfers');
      }, () => _server([]));
    });

    testWidgets("an EMI takes its loan's name and EMI & Loans", (tester) async {
      await http.runWithClient(() async {
        await _open(tester, _row());
        await _pickKind(tester, 'Loan repayment');
        expect(_merchant(tester), 'Car loan EMI');
        expect(_category(tester), 'EMI & Loans');
      }, () => _server([]));
    });

    testWidgets('a salary says Salary, and lands in Income', (tester) async {
      await http.runWithClient(() async {
        await _open(tester, _row(type: 'CREDIT', merchant: 'NEFT CR SALARY'));
        await _pickKind(tester, 'Salary');
        expect(_merchant(tester), 'Salary');
        expect(_category(tester), 'Income');
      }, () => _server([]));
    });

    testWidgets('a transfer says where it went', (tester) async {
      await http.runWithClient(() async {
        await _open(tester, _row());
        await _pickKind(tester, 'To own account');
        expect(_category(tester), 'Transfers');
      }, () => _server([]));
    });

    testWidgets('paid for someone reads as what they owe', (tester) async {
      await http.runWithClient(() async {
        await _open(tester, _row(merchant: 'Croma'));
        await _pickKind(tester, 'Paid for someone');
        await tester.pumpAndSettle();
        // Naming the person in the box offers them as a chip; picking it
        // is what puts them on the row.
        await tester.enterText(find.byKey(const ValueKey('merchant-field')), 'Rahul');
        await tester.pumpAndSettle();
        await tester.tap(find.text('Rahul').last);
        await tester.pumpAndSettle();
        await _pickKind(tester, 'Paid for someone');

        expect(_merchant(tester), 'Owed to Rahul');
        expect(_category(tester), 'Lent & borrowed');
      }, () => _server([]));
    });

    testWidgets('a name the user typed is left alone', (tester) async {
      await http.runWithClient(() async {
        await _open(tester, _row());
        await tester.enterText(find.byKey(const ValueKey('merchant-field')), 'My own words');
        await tester.pumpAndSettle();
        await _pickKind(tester, 'Loan repayment');

        expect(_merchant(tester), 'My own words');
        // The category is settled anyway - that is not a name.
        expect(_category(tester), 'EMI & Loans');
      }, () => _server([]));
    });

    testWidgets('plain spending invents nothing', (tester) async {
      await http.runWithClient(() async {
        await _open(tester, _row(merchant: 'Croma'));
        expect(_merchant(tester), 'Croma');
        expect(_category(tester), '');
      }, () => _server([]));
    });
  });
}
