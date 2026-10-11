import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/ipo_models.dart';
import 'package:spendlog/screens/ipos_screen.dart';
import 'package:spendlog/theme.dart';

Map<String, dynamic> _row({
  String slug = 'acme',
  String name = 'Acme Industries',
  String type = 'MAINBOARD',
  String status = 'OPEN',
  Object? gmp = const {'premiumMinor': 2700, 'percent': 9.1, 'updatedAtLabel': '2h ago'},
  Object? perLot = const {'costMinor': 1485000, 'atGmpMinor': 1620000, 'gainMinor': 135000, 'gainPercent': 9.1},
  double? subscriptionTimes = 12.4,
}) =>
    {
      'slug': slug,
      'name': name,
      'type': type,
      'status': status,
      'openDate': '2026-10-09',
      'closeDate': '2026-10-14',
      'allotmentDate': '2026-10-15',
      'listingDate': '2026-10-17',
      'priceBand': '₹285 – ₹297',
      'priceMaxMinor': 29700,
      'lotSize': 50,
      'minInvestmentMinor': 1485000,
      'gmp': gmp,
      'subscriptionTimes': subscriptionTimes,
      'webUrl': 'https://www.ipoguru.in/ipo/$slug',
      'perLot': perLot,
    };

Map<String, dynamic> _list({
  List<Map<String, dynamic>> open = const [],
  List<Map<String, dynamic>> upcoming = const [],
  List<Map<String, dynamic>> closed = const [],
  bool stale = false,
  String? error,
  String? fetchedAt,
}) =>
    {
      'available': true,
      'fetchedAt': fetchedAt ?? DateTime.now().toUtc().toIso8601String(),
      'stale': stale,
      'error': error,
      'source': {'name': 'IPO Guru', 'url': 'https://www.ipoguru.in'},
      'open': open,
      'upcoming': upcoming,
      'closed': closed,
    };

/// Every row the screen has to tell apart: a gain, a loss, no premium, no
/// GMP at all, and an SME issue in each of the other two sections.
final _mixed = _list(
  open: [
    _row(),
    _row(
      slug: 'drop',
      name: 'Drop Ltd',
      gmp: {'premiumMinor': -840, 'percent': -2.8, 'updatedAtLabel': '1h ago'},
      perLot: {'costMinor': 1500000, 'atGmpMinor': 1458000, 'gainMinor': -42000, 'gainPercent': -2.8},
    ),
  ],
  upcoming: [
    _row(
      slug: 'flat',
      name: 'Flat Co',
      status: 'UPCOMING',
      gmp: {'premiumMinor': 0, 'percent': 0, 'updatedAtLabel': null},
      perLot: {'costMinor': 1000000, 'atGmpMinor': 1000000, 'gainMinor': 0, 'gainPercent': 0},
      subscriptionTimes: null,
    ),
    _row(slug: 'tiny', name: 'Tiny Tools SME', type: 'SME', status: 'UPCOMING', gmp: null, perLot: null),
  ],
  closed: [
    _row(slug: 'wait', name: 'Waiting Works', type: 'SME', status: 'CLOSED'),
  ],
);

/// Answers GET /ipos with [body] and [status].
MockClient _server(Object body, {int status = 200}) =>
    MockClient((request) async => http.Response(jsonEncode(body), status, headers: {
          'content-type': 'application/json; charset=utf-8',
        }));

/// 360 logical pixels wide. Tall by default, so the whole list is built
/// without scrolling; the overflow test uses a phone's height and scrolls.
Future<void> _pump(WidgetTester tester, {Brightness brightness = Brightness.light, double height = 7200}) async {
  tester.view.physicalSize = Size(1080, height);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: const IposScreen()));
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('IpoList.fromJson', () {
    test('reads every field, in paise', () {
      final list = IpoList.fromJson(_mixed);
      expect(list.available, isTrue);
      expect(list.fetchedAt, isNotNull);
      expect(list.sourceName, 'IPO Guru');
      expect(list.open, hasLength(2));
      expect(list.upcoming, hasLength(2));
      expect(list.closed, hasLength(1));

      final acme = list.open.first;
      expect(acme.slug, 'acme');
      expect(acme.isSme, isFalse);
      expect(acme.status, 'OPEN');
      expect(acme.closeDate, '2026-10-14');
      expect(acme.priceMaxMinor, 29700);
      expect(acme.lotSize, 50);
      expect(acme.gmp!.premiumMinor, 2700);
      expect(acme.gmp!.percent, 9.1);
      expect(acme.gmp!.updatedAtLabel, '2h ago');
      expect(acme.subscriptionTimes, 12.4);
      expect(acme.perLot!.gainMinor, 135000);
      expect(acme.perLot!.costMinor, 1485000);

      expect(list.open[1].perLot!.gainMinor, -42000);
      expect(list.upcoming.first.gmp!.premiumMinor, 0);
      expect(list.upcoming[1].isSme, isTrue);
      expect(list.upcoming[1].gmp, isNull);
      expect(list.upcoming[1].perLot, isNull);
    });

    test('not configured is just available: false', () {
      final list = IpoList.fromJson({'available': false});
      expect(list.available, isFalse);
      expect(list.isEmpty, isTrue);
      expect(list.fetchedAt, isNull);
      expect(list.stale, isFalse);
    });

    test('missing and wrong-shaped fields fall back instead of throwing', () {
      final list = IpoList.fromJson({
        'available': true,
        'fetchedAt': 'not a date',
        'open': [
          {'name': 'Bare'},
          'not a row',
          {
            'name': 'Odd',
            'type': 'something',
            'status': 'LISTED',
            'lotSize': 50.0,
            'priceMaxMinor': '29700',
            'gmp': {'percent': 3},
            'perLot': {'costMinor': 100000},
            'subscriptionTimes': 3,
          },
        ],
        'upcoming': null,
      });

      expect(list.fetchedAt, isNull);
      expect(list.sourceName, 'IPO Guru');
      expect(list.upcoming, isEmpty);
      expect(list.closed, isEmpty);
      expect(list.open, hasLength(2));

      final bare = list.open.first;
      expect(bare.name, 'Bare');
      expect(bare.slug, 'Bare');
      expect(bare.type, 'MAINBOARD');
      expect(bare.status, 'OPEN'); // from the list it came in
      expect(bare.lotSize, isNull);
      expect(bare.gmp, isNull);
      expect(bare.perLot, isNull);
      expect(bare.webUrl, isNull);

      final odd = list.open[1];
      expect(odd.type, 'MAINBOARD');
      expect(odd.status, 'OPEN');
      expect(odd.lotSize, 50);
      expect(odd.priceMaxMinor, isNull);
      expect(odd.gmp, isNull); // a GMP without a premium is no GMP
      expect(odd.perLot, isNull); // nor a lot without a gain
      expect(odd.subscriptionTimes, 3.0);
    });
  });

  group('date line', () {
    Ipo ipo(Map<String, dynamic> overrides) => Ipo.fromJson({..._row(), ...overrides});

    test('says when it closes, opens or lists', () {
      expect(ipoDateLine(ipo({'status': 'OPEN', 'closeDate': '2030-10-14'})), 'Open till 14 Oct');
      expect(
        ipoDateLine(ipo({'status': 'UPCOMING', 'openDate': '2030-10-16', 'closeDate': '2030-10-18'})),
        'Opens 16 Oct – closes 18 Oct',
      );
      expect(ipoDateLine(ipo({'status': 'CLOSED', 'listingDate': '2030-10-21'})), 'Lists 21 Oct');
      expect(ipoDateLine(ipo({'status': 'UPCOMING', 'openDate': null, 'closeDate': null})), 'Dates not announced yet');
    });
  });

  group('IposScreen', () {
    testWidgets('loading, then the list in its sections with counts', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester);
        expect(find.byType(CircularProgressIndicator), findsOneWidget);
        await tester.pumpAndSettle();
      }, () => _server(_mixed));

      expect(find.text('OPEN NOW'), findsOneWidget);
      expect(find.text('UPCOMING'), findsOneWidget);
      expect(find.text('WAITING TO LIST'), findsOneWidget);
      expect(find.text('2'), findsNWidgets(2));
      expect(find.text('1'), findsOneWidget);
      expect(find.text('Acme Industries'), findsOneWidget);
      expect(find.text('1 lot · 50 shares · ₹14,850'), findsWidgets);
      expect(find.textContaining('Grey market premium (GMP) is unofficial'), findsOneWidget);
      expect(find.textContaining('Data: IPO Guru.'), findsOneWidget);
      expect(find.textContaining('Showing data from'), findsNothing);
    });

    testWidgets('gain, loss, zero and no-GMP lines', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester);
        await tester.pumpAndSettle();
      }, () => _server(_mixed));

      const c = SpendColors.light;
      Color? colourOf(String text) {
        final rich = tester.widget<RichText>(find.byWidgetPredicate(
          (w) => w is RichText && w.text.toPlainText().contains(text),
        ).first);
        Color? found;
        rich.text.visitChildren((span) {
          if (span is TextSpan && span.text == text) found = span.style?.color;
          return found == null;
        });
        return found;
      }

      // Acme, and Waiting Works further down.
      expect(find.text("At today's GMP +₹1,350 (+9.1%) per lot"), findsNWidgets(2));
      expect(colourOf('+₹1,350'), c.credit);

      expect(find.text("At today's GMP −₹420 (−2.8%) per lot"), findsOneWidget);
      expect(colourOf('−₹420'), c.debit);

      expect(find.text('GMP ₹0 · no premium today'), findsOneWidget);
      expect(find.text('No GMP yet'), findsOneWidget);

      expect(
        find.text('Price band ₹285 – ₹297 · GMP updated 2h ago · Subscribed 12.4×'),
        findsWidgets,
      );
      expect(find.textContaining('SME: small, thinly traded'), findsNWidgets(2));
    });

    testWidgets('the SME filter keeps only SME issues, and Mainboard the rest', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester);
        await tester.pumpAndSettle();
      }, () => _server(_mixed));

      // The chip comes first; the cards' SME tags follow it.
      await tester.tap(find.text('SME').first);
      await tester.pumpAndSettle();
      expect(find.text('Tiny Tools SME'), findsOneWidget);
      expect(find.text('Waiting Works'), findsOneWidget);
      expect(find.text('Acme Industries'), findsNothing);
      expect(find.text('Flat Co'), findsNothing);
      expect(find.text('OPEN NOW'), findsNothing);

      await tester.tap(find.text('Mainboard'));
      await tester.pumpAndSettle();
      expect(find.text('Acme Industries'), findsOneWidget);
      expect(find.text('Drop Ltd'), findsOneWidget);
      expect(find.text('Tiny Tools SME'), findsNothing);
      expect(find.text('WAITING TO LIST'), findsNothing);

      await tester.tap(find.text('All'));
      await tester.pumpAndSettle();
      expect(find.text('Tiny Tools SME'), findsOneWidget);
      expect(find.text('Acme Industries'), findsOneWidget);
    });

    testWidgets('a failed refresh with rows shows the stale banner', (tester) async {
      final sevenHoursAgo = DateTime.now().toUtc().subtract(const Duration(hours: 7, minutes: 5));
      await http.runWithClient(() async {
        await _pump(tester);
        await tester.pumpAndSettle();
      }, () => _server(_list(
            open: [_row()],
            stale: true,
            error: 'IPO Guru is busy',
            fetchedAt: sevenHoursAgo.toIso8601String(),
          )));

      expect(find.text("Showing data from 7h ago · couldn't refresh"), findsOneWidget);
      expect(find.text('Acme Industries'), findsOneWidget);
    });

    testWidgets('not configured says so, with nothing to retry', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester);
        await tester.pumpAndSettle();
      }, () => _server({'available': false}));

      expect(find.text("IPOs aren't set up on the server yet"), findsOneWidget);
      expect(find.text('Retry'), findsNothing);
    });

    testWidgets('nothing open or coming up is the empty state', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester);
        await tester.pumpAndSettle();
      }, () => _server(_list()));

      expect(find.text('No IPOs open or coming up right now'), findsOneWidget);
    });

    testWidgets('a server error shows the failed state, and Retry loads again', (tester) async {
      var calls = 0;
      await http.runWithClient(() async {
        await _pump(tester);
        await tester.pumpAndSettle();

        expect(find.text("Couldn't load IPOs"), findsOneWidget);
        expect(find.text('Upstream down'), findsOneWidget);

        await tester.tap(find.text('Retry'));
        await tester.pumpAndSettle();
      }, () => MockClient((request) async {
            calls++;
            return calls == 1
                ? http.Response(jsonEncode({'error': 'Upstream down'}), 502)
                : http.Response(jsonEncode(_mixed), 200, headers: {'content-type': 'application/json; charset=utf-8'});
          }));

      expect(calls, 2);
      expect(find.text('Acme Industries'), findsOneWidget);
    });

    for (final brightness in Brightness.values) {
      testWidgets('lays out without overflow at 360 px (${brightness.name})', (tester) async {
        final long = _list(
          open: [
            _row(name: 'Shri Venkateshwara Agro Infrastructure and Precision Engineering Limited'),
            ..._mixed['open'] as List<Map<String, dynamic>>,
          ],
          upcoming: _mixed['upcoming'] as List<Map<String, dynamic>>,
          closed: _mixed['closed'] as List<Map<String, dynamic>>,
          stale: true,
          error: 'IPO Guru is busy',
        );
        await http.runWithClient(() async {
          await _pump(tester, brightness: brightness, height: 2400);
          await tester.pumpAndSettle();
        }, () => _server(long));

        expect(tester.takeException(), isNull);

        // Scroll the whole list through, so every card gets laid out.
        await tester.scrollUntilVisible(
          find.textContaining('Data: IPO Guru.'),
          300,
          scrollable: find.byType(Scrollable).first,
        );
        expect(tester.takeException(), isNull);
        expect(find.textContaining('Data: IPO Guru.'), findsOneWidget);
      });
    }
  });
}
