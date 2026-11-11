import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/analytics_screen.dart';
import 'package:spendlog/screens/merchant_screen.dart';
import 'package:spendlog/theme.dart';

const _detail = {
  'merchant': 'Swiggy',
  'range': '6m',
  'label': 'Last 6 months',
  'totalMinor': 1860000,
  'count': 24,
  'averageMinor': 77500,
  'firstOn': '2026-06-03T10:00:00.000Z',
  'lastOn': '2026-11-09T10:00:00.000Z',
  'byMonth': [
    {'month': '2026-06', 'label': 'June 2026', 'amountMinor': 200000, 'count': 3},
    {'month': '2026-07', 'label': 'July 2026', 'amountMinor': 260000, 'count': 4},
    {'month': '2026-08', 'label': 'August 2026', 'amountMinor': 300000, 'count': 4},
    {'month': '2026-09', 'label': 'September 2026', 'amountMinor': 400000, 'count': 5},
    {'month': '2026-10', 'label': 'October 2026', 'amountMinor': 500000, 'count': 6},
    {'month': '2026-11', 'label': 'November 2026', 'amountMinor': 200000, 'count': 2},
  ],
  'byCategory': [
    {'categoryId': 'food', 'name': 'Food', 'amountMinor': 1600000, 'count': 20},
    {'categoryId': null, 'name': 'Uncategorized', 'amountMinor': 260000, 'count': 4},
  ],
  'transactions': [
    {
      'id': 't1', 'amountMinor': 80000, 'type': 'DEBIT', 'merchant': 'Swiggy', 'source': 'SMS',
      'occurredAt': '2026-11-09T10:00:00.000Z',
    },
    {
      'id': 't2', 'amountMinor': 120000, 'type': 'DEBIT', 'merchant': 'Swiggy', 'source': 'SMS',
      'occurredAt': '2026-11-02T10:00:00.000Z',
    },
  ],
};

const _empty = {
  'merchant': 'Swiggy',
  'range': 'month',
  'label': 'November 2026',
  'totalMinor': 0,
  'count': 0,
  'averageMinor': 0,
  'firstOn': null,
  'lastOn': null,
  'byMonth': [],
  'byCategory': [],
  'transactions': [],
};

http.Response _json(Object body) => http.Response.bytes(
      utf8.encode(jsonEncode(body)),
      200,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

MockClient _server(List<http.Request> requests, {Object detail = _detail}) => MockClient((request) async {
      requests.add(request);
      final path = request.url.path;
      if (path.endsWith('/analytics/merchant')) return _json(detail);
      if (path.endsWith('/categories')) {
        return _json([
          {'id': 'food', 'name': 'Food', 'color': '#FF5733'},
        ]);
      }
      return _json(const []);
    });

Future<void> _phone(
  WidgetTester tester,
  Widget home, {
  Brightness brightness = Brightness.light,
  double width = 1080,
  double height = 3600,
}) async {
  tester.view.physicalSize = Size(width, height);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: home));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('the merchant models', () {
    test('read a merchant up close, and average only the months paid', () {
      final detail = MerchantDetail.fromJson(_detail);
      expect(detail.merchant, 'Swiggy');
      expect(detail.totalMinor, 1860000);
      expect(detail.averageMinor, 77500);
      expect(detail.byMonth.length, 6);
      expect(detail.byCategory.first.name, 'Food');
      expect(detail.transactions.length, 2);
      expect(detail.isEmpty, isFalse);
      // 18,600 over six months each with a payment in it.
      expect(detail.perActiveMonthMinor, 1860000 ~/ 6);
    });

    test('an empty stretch divides nothing by nothing', () {
      final detail = MerchantDetail.fromJson(_empty);
      expect(detail.isEmpty, isTrue);
      expect(detail.perActiveMonthMinor, 0);
      expect(detail.firstOn, isNull);
    });

    test('survives an older server that sends less', () {
      final detail = MerchantDetail.fromJson({'merchant': 'Zomato'});
      expect(detail.merchant, 'Zomato');
      expect(detail.totalMinor, 0);
      expect(detail.byMonth, isEmpty);
      expect(detail.transactions, isEmpty);
    });

    test('names every stretch the server takes', () {
      expect(MerchantRange.values.map((r) => r.key), ['month', '3m', '6m', '12m', 'all']);
      expect(MerchantRange.sixMonths.label, '6 months');
    });
  });

  group('one merchant up close', () {
    testWidgets('shows what it has had, how often, and every payment', (tester) async {
      final requests = <http.Request>[];
      await http.runWithClient(() async {
        await _phone(tester, const MerchantScreen(merchant: 'Swiggy'));
      }, () => _server(requests));

      expect(find.text('Swiggy'), findsWidgets);
      expect(find.text('₹18,600'), findsOneWidget);
      expect(find.text('Last 6 months'), findsOneWidget);
      expect(find.text('24'), findsOneWidget);
      expect(find.text('₹775'), findsOneWidget);
      // Both the month bars and what it counted as.
      expect(find.text('Month by month'), findsOneWidget);
      expect(find.text('What it counted as'), findsOneWidget);
      expect(find.text('Food'), findsWidgets);
      expect(find.text('Every payment'), findsOneWidget);

      // Asked for six months, by name.
      final asked = requests.firstWhere((r) => r.url.path.endsWith('/analytics/merchant'));
      expect(asked.url.queryParameters['name'], 'Swiggy');
      expect(asked.url.queryParameters['range'], '6m');
    });

    testWidgets('fetches again when a longer stretch is picked', (tester) async {
      final requests = <http.Request>[];
      await http.runWithClient(() async {
        // Wide enough that every chip is built, so "All time" can be tapped.
        await _phone(tester, const MerchantScreen(merchant: 'Swiggy'), width: 2160);
        await tester.tap(find.byKey(const ValueKey('merchant-range-all')));
        await tester.pumpAndSettle();
      }, () => _server(requests));

      final ranges = requests
          .where((r) => r.url.path.endsWith('/analytics/merchant'))
          .map((r) => r.url.queryParameters['range'])
          .toList();
      expect(ranges, ['6m', 'all']);
    });

    testWidgets('offers all time when the month is empty', (tester) async {
      await http.runWithClient(() async {
        await _phone(tester, const MerchantScreen(merchant: 'Swiggy', range: MerchantRange.month));
        expect(find.text('Nothing in november 2026'), findsOneWidget);
        expect(find.text('See all time'), findsOneWidget);
      }, () => _server([], detail: _empty));
    });

    for (final brightness in Brightness.values) {
      testWidgets('fits a 360 px phone (${brightness.name})', (tester) async {
        await http.runWithClient(() async {
          await _phone(tester, const MerchantScreen(merchant: 'Swiggy'), brightness: brightness);
          expect(tester.takeException(), isNull);
        }, () => _server([]));
      });
    }
  });

  group('the merchant view in Analytics', () {
    /// Enough of the Analytics screen's endpoints to render it, with a
    /// merchant list long enough to bring out the search box.
    MockClient analytics(List<http.Request> requests) => MockClient((request) async {
          requests.add(request);
          final path = request.url.path;
          if (path.endsWith('/analytics/months')) {
            return _json({
              'bySalary': false,
              'salaryDay': null,
              'current': '2026-11',
              'months': [
                {'month': '2026-11', 'from': '2026-11-01', 'to': '2026-11-30', 'label': 'November 2026'},
              ],
            });
          }
          if (path.endsWith('/analytics/summary')) {
            return _json({
              'month': '2026-11',
              'from': '2026-11-01',
              'to': '2026-11-30',
              'label': 'November 2026',
              'totalSpendMinor': 2500000,
              'totalIncomeMinor': 8000000,
              'transactionCount': 30,
              'byCategory': [
                {'categoryId': 'food', 'name': 'Food', 'amountMinor': 1000000},
              ],
            });
          }
          if (path.endsWith('/analytics/merchants')) {
            final range = request.url.queryParameters['range'];
            return _json([
              {'merchant': 'Swiggy', 'amountMinor': range == 'all' ? 9000000 : 1000000, 'count': 11},
              for (var i = 0; i < 9; i += 1) {'merchant': 'Shop $i', 'amountMinor': 10000 * (i + 1), 'count': 1},
            ]);
          }
          if (path.endsWith('/analytics/merchant')) return _json(_detail);
          if (path.endsWith('/categories')) {
            return _json([
              {'id': 'food', 'name': 'Food', 'color': '#FF5733'},
            ]);
          }
          if (path.endsWith('/budget/monthly')) return _json(const <String, dynamic>{});
          return _json(const []);
        });

    /// Taps through to the Merchant view, which is a segment rather than
    /// the view the screen opens on.
    Future<void> openTab(WidgetTester tester) async {
      await tester.dragUntilVisible(
        find.text('Merchant'),
        find.byType(SingleChildScrollView).first,
        const Offset(0, -220),
      );
      await tester.tap(find.text('Merchant'));
      await tester.pumpAndSettle();
    }

    testWidgets('lists every merchant, with a stretch and a search', (tester) async {
      final requests = <http.Request>[];
      await http.runWithClient(() async {
        await _phone(tester, const Scaffold(body: AnalyticsScreen()), width: 1200, height: 4800);
        await openTab(tester);

        // The whole list, not a top fifteen.
        final asked = requests.lastWhere((r) => r.url.path.endsWith('/analytics/merchants'));
        expect(asked.url.queryParameters['limit'], '500');
        expect(asked.url.queryParameters['range'], 'month');

        expect(find.text('Swiggy'), findsOneWidget);
        expect(find.text('₹14,500 across 10 merchants · this month'), findsOneWidget);

        // Ten merchants is past the point where a list needs finding in.
        await tester.enterText(find.byKey(const ValueKey('merchant-search')), 'swig');
        await tester.pumpAndSettle();
        expect(find.text('Swiggy'), findsOneWidget);
        expect(find.text('Shop 3'), findsNothing);
      }, () => analytics(requests));
    });

    testWidgets('reaches back further without moving the rest of the month', (tester) async {
      final requests = <http.Request>[];
      await http.runWithClient(() async {
        await _phone(tester, const Scaffold(body: AnalyticsScreen()), width: 1200, height: 4800);
        await openTab(tester);
        await tester.tap(find.byKey(const ValueKey('merchant-range-all')));
        await tester.pumpAndSettle();
      }, () => analytics(requests));

      final ranges = requests
          .where((r) => r.url.path.endsWith('/analytics/merchants'))
          .map((r) => r.url.queryParameters['range'])
          .toList();
      expect(ranges.last, 'all');
      // The month's own figures were not re-fetched for it.
      expect(requests.where((r) => r.url.path.endsWith('/analytics/summary')).length, 1);
    });

    testWidgets('opens a merchant on its own', (tester) async {
      final requests = <http.Request>[];
      await http.runWithClient(() async {
        await _phone(tester, const Scaffold(body: AnalyticsScreen()), width: 1200, height: 4800);
        await openTab(tester);
        await tester.tap(find.text('Swiggy'));
        await tester.pumpAndSettle();
      }, () => analytics(requests));

      expect(find.byType(MerchantScreen), findsOneWidget);
      final asked = requests.firstWhere((r) => r.url.path.endsWith('/analytics/merchant'));
      expect(asked.url.queryParameters['name'], 'Swiggy');
    });
  });
}
