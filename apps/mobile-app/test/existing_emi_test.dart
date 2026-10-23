import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/emi_plan_screen.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/emi_section.dart';
import 'package:spendlog/widgets/existing_emi_sheet.dart';

// An EMI begun before SpendLog, as emi.routes.ts sends it. Paise throughout.

const _card = '64a000000000000000000021';
const _bank = '64a000000000000000000022';

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

Map<String, dynamic> _account(String id, String type, String bank, String last4) =>
    {'id': id, 'bankName': bank, 'last4': last4, 'accountType': type, 'aliases': [], 'isActive': true};

Map<String, dynamic> _row(int seq, String due, String status, {bool before = false, String? txn, String? id}) => {
      'id': id ?? 'i$seq',
      'seq': seq,
      'dueDate': due,
      'amountMinor': 530000,
      'status': status,
      'transactionId': txn,
      'paidAt': status == 'PAID' && !before ? due : null,
      'paidBeforeTracking': before,
    };

/// Phone, HDFC ••1234: 12 months, the first four paid before SpendLog
/// (which began 15 Oct), the fifth matched to a debit, the rest to come.
Map<String, dynamic> _plan({String id = 'p1', String status = 'ACTIVE', String label = 'Phone', String account = _card}) => {
      'id': id,
      'label': label,
      'origin': 'EXISTING',
      'sourceTransactionId': null,
      'accountId': {'id': account, 'bankName': 'HDFC', 'last4': '1234', 'accountType': 'CARD'},
      'principalMinor': 6360000,
      'months': 12,
      'monthlyAmountMinor': 530000,
      'totalPayableMinor': 6360000,
      'startDate': '2026-06-05T06:30:00.000Z',
      'status': status,
      'paidCount': 5,
      'paidBeforeTrackingCount': 4,
      'remainingMinor': 530000 * 7,
      'nextDue': {'seq': 6, 'dueDate': '2026-11-05T06:30:00.000Z', 'amountMinor': 530000},
      'trackingSince': '2026-10-14T18:30:00.000Z',
      'instalments': [
        for (var seq = 1; seq <= 12; seq++)
          _row(
            seq,
            DateTime.utc(2026, 5 + seq, 5, 6, 30).toIso8601String(),
            seq <= 5 ? 'PAID' : 'DUE',
            before: seq <= 4,
            txn: seq == 5 ? 't5' : null,
          ),
      ],
    };

Future<void> _pump(WidgetTester tester, Widget body, {Brightness brightness = Brightness.light, bool scroll = true}) async {
  // 360 logical pixels: the narrowest phone the app is laid out for.
  tester.view.physicalSize = const Size(1080, 5400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: buildTheme(brightness),
    home: scroll ? Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(16), child: body)) : body,
  ));
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('the model', () {
    test('reads an existing EMI with its card, next instalment and paid-before months', () {
      final plan = EmiPlan.fromJson(_plan());
      expect(plan.isExisting, isTrue);
      expect(plan.accountId, _card);
      expect(plan.accountLabel, 'HDFC ••1234');
      expect(plan.nextDue!.seq, 6);
      expect(plan.paidBeforeTrackingCount, 4);
      expect(plan.instalments, hasLength(12));
      expect(plan.instalments.first.paidBeforeTracking, isTrue);
      expect(plan.instalments[4].transactionId, 't5');
      expect(plan.endsOn, DateTime.utc(2027, 5, 5, 6, 30));
    });

    test('an older server: every plan converted, nothing extra', () {
      final plan = EmiPlan.fromJson({
        'id': 'old',
        'label': null,
        'accountId': _card,
        'principalMinor': 100,
        'months': 3,
        'monthlyAmountMinor': 34,
        'totalPayableMinor': 102,
        'startDate': '2026-09-10T00:00:00.000Z',
      });
      expect(plan.origin, 'CONVERTED');
      expect(plan.isExisting, isFalse);
      expect(plan.accountId, _card);
      expect(plan.accountLabel, isNull);
      expect(plan.name, 'EMI');
      expect(plan.instalments, isEmpty);
      expect(plan.nextDue, isNull);
    });

    test('calendar months clamp to a shorter month', () {
      expect(addCalendarMonths(DateTime(2027, 1, 31), 1), DateTime(2027, 2, 28));
      expect(addCalendarMonths(DateTime(2026, 11, 23), 6), DateTime(2027, 5, 23));
    });
  });

  group('adding one', () {
    final accounts = [
      Account.fromJson(_account(_card, 'CARD', 'HDFC', '1234')),
      Account.fromJson(_account(_bank, 'BANK', 'SBI', '9876')),
      Account.fromJson(_account('64a000000000000000000023', 'CASH', 'Cash', '0000')),
    ];

    Widget sheet() => ExistingEmiSheet(accountId: _card, accounts: accounts, today: DateTime(2026, 10, 23));

    Future<void> fill(WidgetTester tester) async {
      await tester.enterText(find.byKey(const ValueKey('emi-label')), 'Phone');
      await tester.enterText(find.byKey(const ValueKey('emi-monthly')), '5,300');
      await tester.enterText(find.byKey(const ValueKey('emi-months')), '12');
      for (var i = 0; i < 5; i++) {
        await tester.tap(find.byKey(const ValueKey('emi-paid-more')));
      }
      await tester.pump();
    }

    testWidgets('says what is missing before sending anything', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, sheet());
        await tester.tap(find.byKey(const ValueKey('emi-save')));
        await tester.pump();
        expect(find.text('Say what the EMI is for.'), findsOneWidget);

        await tester.enterText(find.byKey(const ValueKey('emi-label')), 'Phone');
        await tester.tap(find.byKey(const ValueKey('emi-save')));
        await tester.pump();
        expect(find.text('Type the monthly amount as a number.'), findsOneWidget);

        await tester.enterText(find.byKey(const ValueKey('emi-monthly')), '5300');
        await tester.enterText(find.byKey(const ValueKey('emi-months')), '0');
        await tester.tap(find.byKey(const ValueKey('emi-save')));
        await tester.pump();
        expect(find.text('The term is a number of months, from 1 to 120.'), findsOneWidget);
      }, () => MockClient((request) async {
            log.add(request);
            return _json({});
          }));
      expect(log, isEmpty);
    });

    testWidgets('only cards and bank accounts can be picked; the card comes picked', (tester) async {
      await _pump(tester, sheet());
      expect(find.text('HDFC ••1234 · credit card'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('emi-account')));
      await tester.pumpAndSettle();
      expect(find.text('SBI ••9876 · bank account'), findsWidgets);
      expect(find.textContaining('Cash'), findsNothing);
    });

    testWidgets('the paid count stays below the term, and the summary follows it', (tester) async {
      await _pump(tester, sheet());
      await tester.enterText(find.byKey(const ValueKey('emi-monthly')), '5300');
      await tester.enterText(find.byKey(const ValueKey('emi-months')), '3');
      for (var i = 0; i < 5; i++) {
        await tester.tap(find.byKey(const ValueKey('emi-paid-more')));
      }
      await tester.pump();
      expect(find.text('2'), findsOneWidget, reason: 'two paid of three: one always left');
      expect(find.text('1 left · ₹5,300 to go · ends Nov 2026'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('emi-months')), '12');
      await tester.pump();
      for (var i = 0; i < 3; i++) {
        await tester.tap(find.byKey(const ValueKey('emi-paid-more')));
      }
      await tester.pump();
      final summary = tester.widget<Text>(
        find.descendant(of: find.byKey(const ValueKey('emi-summary')), matching: find.byType(Text)),
      );
      expect(summary.data, '7 left · ₹37,100 to go · ends May 2027');
    });

    testWidgets('sends the EMI as the server reads it', (tester) async {
      final log = <http.Request>[];
      var saved = false;
      await http.runWithClient(() async {
        await _pump(tester, Builder(builder: (context) {
          return TextButton(
            onPressed: () async => saved = await showExistingEmiSheet(context, accountId: _card, accounts: accounts),
            child: const Text('open'),
          );
        }));
        await tester.tap(find.text('open'));
        await tester.pumpAndSettle();
        await fill(tester);
        expect(find.byKey(const ValueKey('emi-summary')), findsOneWidget);
        await tester.ensureVisible(find.byKey(const ValueKey('emi-save')));
        await tester.tap(find.byKey(const ValueKey('emi-save')));
        await tester.pumpAndSettle();
      }, () => MockClient((request) async {
            log.add(request);
            return _json({'id': 'p1'}, 201);
          }));

      final posts = log.where((r) => r.method == 'POST').toList();
      expect(posts, hasLength(1));
      expect(posts.single.url.path, endsWith('/emi'));
      final body = jsonDecode(posts.single.body) as Map<String, dynamic>;
      expect(body['accountId'], _card);
      expect(body['label'], 'Phone');
      expect(body['months'], 12);
      expect(body['monthlyAmountMinor'], 530000);
      expect(body['paidCount'], 5);
      expect(body.containsKey('force'), isFalse);
      // Midday in India on the day picked, which by default is today's day next month.
      final next = DateTime.parse(body['nextDueDate'] as String);
      expect(next.toUtc().hour, 6);
      expect(next.toUtc().minute, 30);
      expect(saved, isTrue);
    });

    testWidgets('a likely duplicate asks first, and "Add anyway" sends it forced', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, sheet());
        await fill(tester);
        await tester.tap(find.byKey(const ValueKey('emi-save')));
        await tester.pumpAndSettle();
        expect(find.text('Already added?'), findsOneWidget);
        expect(find.textContaining('already bills about the same'), findsOneWidget);
        await tester.tap(find.text('Add anyway'));
        await tester.pumpAndSettle();
      }, () => MockClient((request) async {
            log.add(request);
            final body = jsonDecode(request.body) as Map<String, dynamic>;
            if (body['force'] == true) return _json({'id': 'p2'}, 201);
            return _json({
              'error': '"Phone" on this account already bills about the same each month over the same months.',
              'code': 'duplicate',
              'existing': {'id': 'p1', 'label': 'Phone'},
            }, 409);
          }));

      final posts = log.where((r) => r.method == 'POST').toList();
      expect(posts, hasLength(2));
      expect((jsonDecode(posts.last.body) as Map)['force'], isTrue);
    });
  });

  group('the list', () {
    MockClient server(List<Object> plans, {List<http.Request>? log}) => MockClient((request) async {
          log?.add(request);
          if (request.url.path.endsWith('/emi')) return _json(plans);
          if (request.url.path.endsWith('/accounts')) {
            return _json([_account(_card, 'CARD', 'HDFC', '1234'), _account(_bank, 'BANK', 'SBI', '9876')]);
          }
          return _json({});
        });

    testWidgets('running plans with where they stand; closed ones folded away', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const EmiSection());
        await tester.pumpAndSettle();
        expect(find.text('EMIs'), findsOneWidget);
        expect(find.text('Phone'), findsOneWidget);
        expect(find.text('HDFC ••1234 · 5 of 12 paid · ₹37,100 left'), findsOneWidget);
        expect(find.text('due 5 Nov'), findsOneWidget);
        expect(find.text('Fridge'), findsNothing);
        await tester.tap(find.byKey(const ValueKey('emi-show-closed')));
        await tester.pumpAndSettle();
        expect(find.text('Fridge'), findsOneWidget);
      }, () => server([_plan(), _plan(id: 'p9', status: 'CLOSED', label: 'Fridge')]));
    });

    testWidgets('on a card page: only that card, and adding picks it', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const EmiSection(accountId: _bank));
        await tester.pumpAndSettle();
        expect(find.text('EMIs on this card'), findsOneWidget);
        expect(find.text('No EMIs running on this card.'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('emi-add-existing')));
        await tester.pumpAndSettle();
        expect(find.text('Add an EMI you already have'), findsWidgets);
        expect(find.text('SBI ••9876 · bank account'), findsOneWidget);
      }, () => server([_plan()]));
    });

    for (final brightness in Brightness.values) {
      testWidgets('nothing overflows at 360px, ${brightness.name}', (tester) async {
        await http.runWithClient(() async {
          await _pump(tester, const EmiSection(), brightness: brightness);
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
        }, () => server([_plan(label: 'A very long name for an EMI that goes on and on')]));
      });
    }
  });

  group('one plan', () {
    testWidgets('each month says how SpendLog knows it was paid', (tester) async {
      await _pump(tester, EmiPlanScreen(plan: EmiPlan.fromJson(_plan()), today: '2026-10-23'), scroll: false);
      await tester.pumpAndSettle();
      expect(find.text('Paid before SpendLog'), findsNWidgets(4));
      expect(find.text('Paid · matched to a payment'), findsOneWidget);
      expect(find.text('Mark paid'), findsNWidgets(7));
      expect(find.textContaining('began before SpendLog'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a month gone past unpaid is overdue, and can be marked paid', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, EmiPlanScreen(plan: EmiPlan.fromJson(_plan()), today: '2026-11-20'), scroll: false);
        await tester.pumpAndSettle();
        expect(find.text('Overdue'), findsOneWidget);
        await tester.tap(find.text('Mark paid').first);
        await tester.pumpAndSettle();
      }, () => MockClient((request) async {
            log.add(request);
            return request.url.path.endsWith('/emi') ? _json([_plan()]) : _json({});
          }));
      final posts = log.where((r) => r.method == 'POST').toList();
      expect(posts, hasLength(1));
      expect(posts.single.url.path, endsWith('/emi/instalments/i6/pay'));
    });

    testWidgets('only an existing EMI offers to change its amount; delete says what stays', (tester) async {
      await _pump(tester, EmiPlanScreen(plan: EmiPlan.fromJson(_plan()), today: '2026-10-23'), scroll: false);
      await tester.tap(find.byKey(const ValueKey('emi-menu')));
      await tester.pumpAndSettle();
      expect(find.text('Change the monthly amount'), findsOneWidget);
      expect(find.text('Close early'), findsOneWidget);
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();
      expect(find.textContaining('stay in your transactions as ordinary payments'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      await _pump(
        tester,
        EmiPlanScreen(
          key: const ValueKey('converted'),
          plan: EmiPlan.fromJson({..._plan(), 'origin': 'CONVERTED'}),
          today: '2026-10-23',
        ),
        scroll: false,
      );
      await tester.tap(find.byKey(const ValueKey('emi-menu')));
      await tester.pumpAndSettle();
      expect(find.text('Change the monthly amount'), findsNothing);
    });
  });
}
