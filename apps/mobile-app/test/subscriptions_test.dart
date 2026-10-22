import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/models/subscription_models.dart';
import 'package:spendlog/screens/subscription_detail_screen.dart';
import 'package:spendlog/screens/subscriptions_screen.dart';
import 'package:spendlog/screens/transactions_screen.dart';
import 'package:spendlog/services/push_service.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/home/monthly_budget_card.dart';
import 'package:spendlog/widgets/subscription_sheet.dart';

/// A phone: 360 × 800 logical pixels.
void _phone(WidgetTester tester, {double height = 800}) {
  tester.view.physicalSize = Size(1080, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

class _Calls {
  final requests = <http.Request>[];
  Iterable<http.Request> to(String method, String pathEnd) =>
      requests.where((r) => r.method == method && r.url.path.endsWith(pathEnd));
}

const _hdfc = {'id': 'acc1', 'bankName': 'HDFC', 'last4': '1234', 'nickname': null, 'accountType': 'CARD'};

Map<String, dynamic> _netflix({int daysToRenewal = 3, String next = '2026-10-25'}) => {
      'id': 'sub-netflix',
      'name': 'Netflix',
      'amountMinor': 64900,
      'every': 1,
      'unit': 'month',
      'frequencyLabel': 'Monthly',
      'frequencyPreset': 'monthly',
      'monthlyMinor': 64900,
      'yearlyMinor': 778800,
      'nextRenewalOn': next,
      'daysToRenewal': daysToRenewal,
      'startedOn': '2026-01-25',
      'payMethod': 'card',
      'accountId': 'acc1',
      'account': _hdfc,
      'categoryId': 'c1',
      'categoryName': 'OTT',
      'status': 'active',
      'priceHistory': [
        {'amountMinor': 64900, 'fromOn': '2026-01-25'},
      ],
      'sharedWith': [],
      'myShareMinor': 64900,
      'remindDaysBefore': 2,
      'renewals': [
        {'dueOn': '2026-09-25', 'status': 'paid', 'transactionId': 't1', 'amountMinor': 64900, 'paidOn': '2026-09-25'},
      ],
      'lastPaid': {'on': '2026-09-25', 'amountMinor': 64900},
      'alerts': [],
    };

Map<String, dynamic> _prime() => {
      'id': 'sub-prime',
      'name': 'Prime',
      'amountMinor': 149900,
      'every': 1,
      'unit': 'year',
      'frequencyLabel': 'Yearly',
      'frequencyPreset': 'yearly',
      'monthlyMinor': 12492,
      'yearlyMinor': 149900,
      'nextRenewalOn': '2027-10-05',
      'daysToRenewal': 348,
      'startedOn': '2024-10-05',
      'payMethod': 'upi',
      'accountId': null,
      'account': null,
      'categoryId': null,
      'categoryName': null,
      'status': 'active',
      'priceHistory': [
        {'amountMinor': 149900, 'fromOn': '2024-10-05'},
      ],
      'sharedWith': [
        {'contactId': 'asha', 'amountMinor': 50000},
      ],
      'myShareMinor': 99900,
      'remindDaysBefore': 7,
      'renewals': [
        {'dueOn': '2026-10-05', 'status': 'missed', 'transactionId': null, 'amountMinor': null, 'paidOn': null},
        {'dueOn': '2025-10-05', 'status': 'paid', 'transactionId': 't0', 'amountMinor': 159900, 'paidOn': '2025-10-06'},
      ],
      'lastPaid': {'on': '2025-10-06', 'amountMinor': 159900},
      'alerts': [
        {'kind': 'missed', 'dueOn': '2026-10-05', 'amountMinor': 149900},
        {'kind': 'price', 'fromMinor': 149900, 'toMinor': 159900, 'on': '2025-10-06'},
      ],
    };

Map<String, dynamic> _page({List<Map<String, dynamic>>? items, List<Map<String, dynamic>>? suggestions}) => {
      'items': items ?? [_netflix(), _prime()],
      'totals': {
        'activeCount': 2,
        'monthlyMinor': 77392,
        'yearlyMinor': 928700,
        'month': {'key': '2026-10', 'from': '2026-10-15', 'to': '2026-11-14', 'label': '15 Oct – 14 Nov 2026'},
        'dueThisMonthMinor': 64900,
        'dueThisMonthCount': 1,
        'paidThisMonthMinor': 0,
        'upcomingThisMonthMinor': 64900,
        'alertCount': 2,
      },
      'suggestions': suggestions ??
          [
            {
              'key': 'hotstar',
              'merchant': 'HOTSTAR.COM',
              'amountMinor': 29900,
              'every': 1,
              'unit': 'month',
              'label': 'Monthly',
              'monthlyMinor': 29900,
              'count': 3,
              'firstOn': '2026-08-02',
              'lastOn': '2026-10-02',
              'nextOn': '2026-11-02',
              'accountId': 'acc1',
              'categoryId': null,
            },
          ],
    };

/// Answers every subscriptions endpoint the screens ask for.
MockClient _server(_Calls calls, {Map<String, dynamic>? page}) => MockClient((request) async {
      calls.requests.add(request);
      final path = request.url.path;
      if (request.method == 'POST' && path.endsWith('/dismiss')) return http.Response('', 204);
      if (request.method == 'POST' && path.endsWith('/subscriptions')) {
        return _json({..._netflix(), 'id': 'new', 'name': (jsonDecode(request.body) as Map)['name']}, 201);
      }
      if (request.method == 'POST' && path.contains('/renewals/')) return _json(_prime());
      if (request.method == 'PATCH') return _json(_prime());
      if (path.endsWith('/subscriptions/calendar')) {
        return _json({
          'month': request.url.queryParameters['month'],
          'renewals': [
            {'on': '${request.url.queryParameters['month']}-05', 'status': 'missed', 'amountMinor': 149900, 'subscriptionId': 'sub-prime', 'name': 'Prime'},
            {'on': '${request.url.queryParameters['month']}-25', 'status': 'upcoming', 'amountMinor': 64900, 'subscriptionId': 'sub-netflix', 'name': 'Netflix'},
          ],
        });
      }
      if (path.endsWith('/subscriptions')) return _json(page ?? _page());
      if (path.endsWith('/subscriptions/sub-prime')) return _json(_prime());
      if (path.endsWith('/subscriptions/sub-netflix')) return _json(_netflix());
      if (path.endsWith('/accounts')) return _json([]);
      if (path.endsWith('/categories')) return _json([]);
      if (path.endsWith('/contacts')) {
        return _json({
          'contacts': [
            {'id': 'asha', 'name': 'Asha', 'phone': null},
          ],
        });
      }
      return http.Response('{"error":"not found: $path"}', 404);
    });

Future<void> _pump(WidgetTester tester, Widget home, {Brightness brightness = Brightness.light}) async {
  await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: home));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('the models', () {
    test('parse the page, with what is worked out from each subscription', () {
      final page = SubscriptionsPage.fromJson(_page());
      expect(page.items.map((s) => s.name), ['Netflix', 'Prime']);
      final prime = page.items.last;
      expect(prime.isShared, isTrue);
      expect(prime.myShareMinor, 99900);
      expect(prime.paidWithLabel, 'UPI autopay');
      expect(prime.alerts.map((a) => a.kind), ['missed', 'price']);
      expect(page.items.first.paidWithLabel, 'HDFC ••1234');
      expect(page.totals.dueThisMonthCount, 1);
      expect(page.totals.monthLabel, '15 Oct – 14 Nov 2026');
      expect(page.suggestions.single.suggestedName, 'Hotstar');
      expect(SubscriptionTotals.fromJson(null).isEmpty, isTrue);
      expect(frequencyWords(3, 'month'), 'Quarterly');
      expect(frequencyWords(2, 'week'), 'Every 2 weeks');
    });

    test('say when a renewal is', () {
      expect(renewalWords(Subscription.fromJson(_netflix(daysToRenewal: 0))), 'Renews today');
      expect(renewalWords(Subscription.fromJson(_netflix(daysToRenewal: 1))), 'Renews tomorrow');
      expect(renewalWords(Subscription.fromJson(_netflix(daysToRenewal: 5))), 'Renews in 5 days');
      expect(renewalWords(Subscription.fromJson(_netflix(daysToRenewal: -3))), 'Due 3 days ago');
      expect(renewalWords(Subscription.fromJson({..._netflix(), 'status': 'paused', 'pausedOn': '2026-10-01'})), 'Paused since 1 Oct');
    });
  });

  group('the subscriptions screen', () {
    testWidgets('shows the totals, what needs a look, the list, the suggestions - and dismisses one', (tester) async {
      _phone(tester, height: 1800);
      final calls = _Calls();
      await http.runWithClient(() async {
        await _pump(tester, const SubscriptionsScreen());

        expect(find.text('₹773.92'), findsOneWidget);
        expect(find.textContaining('₹9,287 a year · 2 active'), findsOneWidget);
        expect(find.text('Prime: no payment seen for 5 Oct'), findsOneWidget);
        expect(find.text('Prime came in at ₹1,599, not ₹1,499'), findsOneWidget);
        expect(find.text('Netflix'), findsWidgets);
        expect(find.textContaining('Renews in 3 days'), findsOneWidget);
        expect(find.text('₹125/mo'), findsOneWidget, reason: 'a yearly plan shows its monthly equivalent');
        expect(find.text('This week'), findsOneWidget);
        expect(find.text('Later'), findsOneWidget);

        expect(find.text('Looks like a subscription'), findsOneWidget);
        expect(find.text('Hotstar · ₹299 monthly'), findsOneWidget);
        await tester.ensureVisible(find.byKey(const ValueKey('dismiss-hotstar')));
        await tester.tap(find.byKey(const ValueKey('dismiss-hotstar')));
        await tester.pumpAndSettle();
        expect(find.text('Hotstar · ₹299 monthly'), findsNothing);
      }, () => _server(calls));
      expect(calls.to('POST', '/subscriptions/suggestions/hotstar/dismiss'), hasLength(1));
    });

    testWidgets('has a calendar of renewals and a by-card view', (tester) async {
      _phone(tester, height: 1400);
      final calls = _Calls();
      await http.runWithClient(() async {
        await _pump(tester, const SubscriptionsScreen());
        await tester.tap(find.text('Calendar'));
        await tester.pumpAndSettle();
        expect(calls.to('GET', '/subscriptions/calendar'), hasLength(1));
        expect(find.text('Tap a day to see what renews.'), findsOneWidget);
        // The 25th: Netflix's day.
        await tester.tap(find.bySemanticsLabel(RegExp(r'^25, 1 renewals')));
        await tester.pumpAndSettle();
        expect(find.text('To come'), findsOneWidget);
        expect(find.textContaining('₹649'), findsWidgets);

        await tester.tap(find.text('By card'));
        await tester.pumpAndSettle();
        expect(find.text('HDFC ••1234'), findsOneWidget);
        expect(find.text('UPI autopay'), findsOneWidget);
      }, () => _server(calls));
    });

    testWidgets('with nothing tracked and nothing found, says so', (tester) async {
      _phone(tester);
      await http.runWithClient(() async {
        await _pump(tester, const SubscriptionsScreen());
        expect(find.text('Nothing renews yet'), findsOneWidget);
        expect(find.text('Add a subscription'), findsOneWidget);
      }, () => _server(_Calls(), page: {'items': [], 'totals': null, 'suggestions': []}));
    });

    testWidgets('fits a phone in the dark too', (tester) async {
      _phone(tester, height: 1800);
      await http.runWithClient(() async {
        await _pump(tester, const SubscriptionsScreen(), brightness: Brightness.dark);
        expect(find.text('Netflix'), findsWidgets);
      }, () => _server(_Calls()));
    });
  });

  group('one subscription', () {
    testWidgets('shows its history and acts on what needs a look', (tester) async {
      _phone(tester, height: 2000);
      final calls = _Calls();
      await http.runWithClient(() async {
        await _pump(tester, const SubscriptionDetailScreen(id: 'sub-prime'));
        expect(find.textContaining('₹1,499'), findsWidgets);
        expect(find.textContaining('your share ₹999'), findsOneWidget);
        expect(find.text('Asha'), findsOneWidget);
        expect(find.text('Missed'), findsOneWidget);
        expect(find.textContaining('Paid ₹1,599 on 6 Oct'), findsOneWidget);
        expect(find.text('Update to ₹1,599'), findsOneWidget);

        await tester.tap(find.byKey(const ValueKey('alert-paid-2026-10-05')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('alert-update-price')));
        await tester.pumpAndSettle();
      }, () => _server(calls));
      expect(calls.to('POST', '/subscriptions/sub-prime/renewals/2026-10-05/paid'), hasLength(1));
      final patch = calls.to('PATCH', '/subscriptions/sub-prime').single;
      expect(jsonDecode(patch.body), {'amountMinor': 159900});
    });
  });

  group('adding one', () {
    testWidgets('sends what was typed, with the frequency picked', (tester) async {
      tester.view.physicalSize = const Size(1440, 2800);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final calls = _Calls();
      await http.runWithClient(() async {
        await _pump(
          tester,
          Scaffold(body: Builder(builder: (context) => TextButton(onPressed: () => showSubscriptionSheet(context), child: const Text('Open')))),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byKey(const ValueKey('sub-name')), 'Spotify');
        await tester.enterText(find.byKey(const ValueKey('sub-amount')), '119');
        await tester.tap(find.byKey(const ValueKey('sub-freq-yearly')));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.byKey(const ValueKey('sub-save')));
        await tester.tap(find.byKey(const ValueKey('sub-save')));
        await tester.pumpAndSettle();
      }, () => _server(calls));
      final body = jsonDecode(calls.to('POST', '/subscriptions').single.body) as Map<String, dynamic>;
      expect(body['name'], 'Spotify');
      expect(body['amountMinor'], 11900);
      expect(body['every'], 1);
      expect(body['unit'], 'year');
      expect(body['remindDaysBefore'], 2);
      expect(body.containsKey('merchantKeys'), isFalse);
    });

    testWidgets('from a detected one, comes filled in and carries the merchant', (tester) async {
      tester.view.physicalSize = const Size(1440, 2800);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final calls = _Calls();
      final suggestion = SubscriptionsPage.fromJson(_page()).suggestions.single;
      await http.runWithClient(() async {
        await _pump(
          tester,
          Scaffold(body: Builder(builder: (context) => TextButton(onPressed: () => showSubscriptionSheet(context, from: suggestion), child: const Text('Open')))),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        expect(find.text('Track Hotstar'), findsOneWidget);
        expect(find.text('3 charges seen, last on 2 Oct'), findsOneWidget);
        await tester.ensureVisible(find.byKey(const ValueKey('sub-save')));
        await tester.tap(find.byKey(const ValueKey('sub-save')));
        await tester.pumpAndSettle();
      }, () => _server(calls));
      final body = jsonDecode(calls.to('POST', '/subscriptions').single.body) as Map<String, dynamic>;
      expect(body['name'], 'Hotstar');
      expect(body['amountMinor'], 29900);
      expect(body['nextRenewalOn'], '2026-11-02');
      expect(body['startedOn'], '2026-08-02');
      expect(body['accountId'], 'acc1');
      expect(body['merchantKeys'], ['hotstar']);
    });
  });

  group('elsewhere in the app', () {
    testWidgets('the budget card has a subscriptions line that opens the screen', (tester) async {
      _phone(tester, height: 1200);
      final budget = MonthlyBudgetStatus.fromJson({
        'configured': true,
        'everSet': true,
        'month': {'key': '2026-10', 'from': '2026-10-15', 'to': '2026-11-14', 'label': '15 Oct – 14 Nov', 'isCurrent': true, 'daysInMonth': 31, 'dayOfMonth': 8, 'daysLeft': 24},
        'budgetMinor': 5000000,
        'spentMinor': 1200000,
        'leftMinor': 3800000,
        'isOver': false,
        'pace': null,
        'categories': [],
        'unassigned': null,
        'bucket': {'configured': false},
      });
      final totals = SubscriptionTotals.fromJson(_page()['totals'] as Map<String, dynamic>);
      var opened = 0;
      await _pump(
        tester,
        Scaffold(
          body: ListView(children: [MonthlyBudgetCard(budget: budget, onEdit: () {}, subscriptions: totals, onSubscriptions: () => opened += 1)]),
        ),
      );
      expect(find.text('Subscriptions'), findsOneWidget);
      expect(find.textContaining('1 renewal this month'), findsOneWidget);
      expect(find.textContaining('/mo'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('budget-subscriptions-row')));
      expect(opened, 1);
    });

    test('a tapped notification opens the right screen', () {
      expect(PushService.screenFor({'type': 'SUBSCRIPTION', 'subscriptionId': 'sub-prime'}), isA<SubscriptionDetailScreen>());
      expect(PushService.screenFor({'type': 'SUBSCRIPTION'}), isA<SubscriptionsScreen>());
      final month = PushService.screenFor({'type': 'MONTHLY_DIGEST', 'monthKey': '2026-09'});
      expect(month, isA<TransactionsScreen>());
      expect((month as TransactionsScreen).initialMonthKey, '2026-09');
      expect(month.isPushed, isTrue);
      expect(PushService.screenFor({'type': 'MONTHLY_DIGEST'}), isNull);
      expect(PushService.screenFor({'type': 'SMS_SYNC'}), isNull);
    });
  });
}
