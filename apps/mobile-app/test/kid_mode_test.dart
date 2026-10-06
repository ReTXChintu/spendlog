import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/main.dart';
import 'package:spendlog/models/kid_models.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/home_shell.dart';
import 'package:spendlog/screens/kid/kid_home_shell.dart';
import 'package:spendlog/screens/kid/kid_settings_screen.dart';
import 'package:spendlog/screens/login_screen.dart';
import 'package:spendlog/screens/start_screen.dart';
import 'package:spendlog/services/api_client.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/kid_transaction_sheet.dart';

KidAccount _account(String id, String name) => KidAccount(id: id, name: name);

Widget _sheet({List<KidAccount>? accounts, Transaction? transaction}) => MaterialApp(
      theme: buildTheme(Brightness.light),
      home: Scaffold(
        body: KidTransactionSheet(
          transaction: transaction,
          accounts: accounts ?? [_account('a1', 'Pocket')],
          categories: [Category(id: 'c1', name: 'Food', isSystem: true)],
          presets: const [],
        ),
      ),
    );

void main() {
  group('kid login routing', () {
    test('a stored kid session opens the kid shell and skips owner start-up', () async {
      SharedPreferences.setMockInitialValues({});
      await ApiClient.setKidSession('kid-token');

      final role = await currentRole();
      expect(role, AppRole.kid);
      expect(startScreenFor(role), isA<KidHomeShell>());
      expect(runsOwnerStartup(role), isFalse);
      // The background SMS isolate reads the owner key; a kid leaves it empty.
      expect(await ApiClient.getToken(), isNull);
    });

    test('an owner session opens the owner shell and runs owner start-up', () async {
      SharedPreferences.setMockInitialValues({});
      await ApiClient.setKidSession('kid-token');
      await ApiClient.setToken('owner-token'); // an owner signing in ends the kid's session

      final role = await currentRole();
      expect(role, AppRole.owner);
      expect(startScreenFor(role), isA<HomeShell>());
      expect(runsOwnerStartup(role), isTrue);
      expect(await ApiClient.getKidToken(), isNull);
    });

    test('no session goes to sign-in, and signing a kid out does too', () async {
      SharedPreferences.setMockInitialValues({});
      expect(startScreenFor(await currentRole()), isA<LoginScreen>());

      await ApiClient.setKidSession('kid-token');
      await ApiClient.clearKidSession();
      expect(await currentRole(), AppRole.signedOut);
    });

    testWidgets('the sign-in screen offers a kid email form', (tester) async {
      SharedPreferences.setMockInitialValues({});
      await tester.pumpWidget(const SpendLogApp());
      await tester.pumpAndSettle();

      await tester.tap(find.text("I'm a kid — sign in with email"));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('kid-email')), findsOneWidget);
      expect(find.byKey(const Key('kid-password')), findsOneWidget);

      // Empty fields are caught before anything is sent.
      await tester.tap(find.text('Sign in'));
      await tester.pumpAndSettle();
      expect(find.text('Enter your email and password.'), findsOneWidget);
    });
  });

  group('kid transaction sheet', () {
    test('validation rules', () {
      expect(kidTransactionProblem(amountText: '', accountId: 'a1'), 'Enter how much it was.');
      expect(kidTransactionProblem(amountText: 'abc', accountId: 'a1'), 'Enter how much it was.');
      expect(kidTransactionProblem(amountText: '0', accountId: 'a1'), 'Enter how much it was.');
      expect(kidTransactionProblem(amountText: '-5', accountId: 'a1'), 'Enter how much it was.');
      expect(kidTransactionProblem(amountText: '120', accountId: null), 'Pick which pocket money this was from.');
      expect(kidTransactionProblem(amountText: '₹1,250.50', accountId: 'a1'), isNull);
    });

    testWidgets('will not save without an amount', (tester) async {
      await tester.pumpWidget(_sheet());
      await tester.tap(find.widgetWithText(FilledButton, 'Add'));
      await tester.pump();
      expect(find.text('Enter how much it was.'), findsOneWidget);
    });

    testWidgets('asks which account when there is more than one', (tester) async {
      await tester.pumpWidget(_sheet(accounts: [_account('a1', 'School'), _account('a2', 'Holiday')]));
      await tester.enterText(find.byKey(const Key('kid-amount')), '50');
      await tester.ensureVisible(find.widgetWithText(FilledButton, 'Add'));
      await tester.tap(find.widgetWithText(FilledButton, 'Add'));
      await tester.pump();
      expect(find.text('Pick which pocket money this was from.'), findsOneWidget);
    });

    testWidgets('edit mode fills the fields and has no delete', (tester) async {
      final transaction = Transaction.fromJson({
        'id': 't1',
        'amountMinor': 24950,
        'type': 'DEBIT',
        'merchant': 'Canteen',
        'source': 'MANUAL',
        'occurredAt': '2026-10-05T06:30:00.000Z',
      });
      await tester.pumpWidget(_sheet(transaction: transaction));
      expect(find.text('249.50'), findsOneWidget);
      expect(find.text('Canteen'), findsOneWidget);
      expect(find.text('Save changes'), findsOneWidget);
      expect(find.textContaining('Delete'), findsNothing);
    });
  });

  test('kid password rules', () {
    expect(kidPasswordProblem(current: '', next: 'abcdef', confirm: 'abcdef'), isNotNull);
    expect(kidPasswordProblem(current: 'old', next: 'abc', confirm: 'abc'), contains('6 characters'));
    expect(kidPasswordProblem(current: 'old', next: 'abcdef', confirm: 'abcdeg'), contains("don't match"));
    expect(kidPasswordProblem(current: 'old', next: 'abcdef', confirm: 'abcdef'), isNull);
  });

  test('refresh hints stay quiet when there is nothing to say', () {
    expect(KidRefreshResult.fromJson({'pinged': true, 'devices': 1}).hint, contains('main phone'));
    expect(KidRefreshResult.fromJson({'pinged': false, 'reason': 'too-soon'}).hint, contains('few minutes'));
    expect(KidRefreshResult.fromJson({'pinged': false, 'reason': 'not-configured'}).hint, isNull);
  });
}
