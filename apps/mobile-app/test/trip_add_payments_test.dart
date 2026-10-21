import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/trip_add_payments_screen.dart';
import 'package:spendlog/screens/trip_payments_screen.dart';
import 'package:spendlog/screens/trips_screen.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/ds/ds_icon.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';

/// A phone: 360 × 800 logical pixels.
void _phone(WidgetTester tester, {double height = 800}) {
  tester.view.physicalSize = Size(1080, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

Map<String, dynamic> _tripJson(String id, String name, {bool running = false, int totalMinor = 0}) => {
      'id': id,
      'name': name,
      'startedAt': running ? '2026-10-10T04:00:00.000Z' : '2026-08-01T04:00:00.000Z',
      'endedAt': running ? null : '2026-08-06T18:00:00.000Z',
      'joinCode': 'GOA123',
      'isActive': running,
      'totalMinor': totalMinor,
      'transactionCount': 2,
    };

final _goa = Trip.fromJson(_tripJson('goa1', 'Goa', running: true));

Map<String, dynamic> _candidate(String id, String merchant, int amountMinor,
        {bool travel = false, String? category, String day = '2026-09-20'}) =>
    {
      'id': id,
      'occurredAt': '${day}T10:00:00.000Z',
      'merchant': merchant,
      'amountMinor': amountMinor,
      'accountLabel': 'HDFC ••8342',
      'categoryName': category,
      'likelyTravel': travel,
    };

/// JSON with its charset said, so a "••" in an account label survives.
http.Response _json(Object body) =>
    http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json; charset=utf-8'});

/// Everything a request asked for, in order.
class _Calls {
  final requests = <http.Request>[];
  Iterable<http.Request> to(String method, String pathEnd) =>
      requests.where((r) => r.method == method && r.url.path.endsWith(pathEnd));
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('Add to a trip, from the edit sheet', () {
    Transaction ticket() => Transaction.fromJson({
          'id': 't9',
          'userId': 'me',
          'amountMinor': 840000,
          'type': 'DEBIT',
          'merchant': 'IRCTC',
          'source': 'SMS',
          'occurredAt': '2026-09-20T10:00:00.000Z',
        });

    /// The sheet's lookups answered with nothing, except the trips.
    MockClient server(_Calls calls) => MockClient((request) async {
          calls.requests.add(request);
          if (request.method == 'PATCH') return http.Response('{}', 200);
          if (request.url.path.endsWith('/trips')) {
            // The server's own order: newest start first, running or not.
            return _json([
              _tripJson('ker1', 'Kerala', totalMinor: 4200000),
              _tripJson('goa1', 'Goa', running: true, totalMinor: 1500000),
            ]);
          }
          final body = request.url.path.endsWith('/contacts') ? '{"contacts": []}' : '[]';
          return http.Response(body, 200);
        });

    Future<void> open(WidgetTester tester) async {
      // Wider than a phone, as the other sheet tests open it: the test
      // font's square glyphs overrun the sheet's button row at 360.
      tester.view.physicalSize = const Size(1440, 2400);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(Brightness.light),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showEditTransactionSheet(
                context,
                transaction: ticket(),
                categories: const [],
                accounts: const [],
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('More'));
      await tester.tap(find.text('More'));
      await tester.pumpAndSettle();
    }

    Future<void> save(WidgetTester tester) async {
      await tester.ensureVisible(find.text('Save'));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
    }

    testWidgets('picking a trip sends its id on save', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);

        await tester.ensureVisible(find.text('Add to a trip'));
        await tester.tap(find.text('Add to a trip'));
        await tester.pumpAndSettle();

        // The running trip first, whatever order the list came in.
        expect(
          tester.getTopLeft(find.text('Goa')).dy,
          lessThan(tester.getTopLeft(find.text('Kerala')).dy),
        );
        expect(find.text('Running'), findsOneWidget);
        await tester.tap(find.text('Goa'));
        await tester.pumpAndSettle();

        // Shown as on the trip, with the same switch that takes one off.
        expect(find.text('On Goa'), findsOneWidget);
        expect(find.text('Just mine on Goa'), findsOneWidget);
        expect(find.text('Add to a trip'), findsNothing);

        await save(tester);
      }, () => server(calls));

      final patch = jsonDecode(calls.to('PATCH', '/transactions/t9').single.body) as Map<String, dynamic>;
      expect(patch['tripId'], 'goa1');
      expect(patch.containsKey('tripShareWith'), isTrue);
      expect(patch['tripShareWith'], isNull);
    });

    testWidgets('"Just mine" goes along with the pick', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await tester.ensureVisible(find.text('Add to a trip'));
        await tester.tap(find.text('Add to a trip'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Goa'));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Just mine on Goa'));
        await tester.tap(find.text('Just mine on Goa'));
        await tester.pumpAndSettle();
        await save(tester);
      }, () => server(calls));

      final patch = jsonDecode(calls.to('PATCH', '/transactions/t9').single.body) as Map<String, dynamic>;
      expect(patch['tripId'], 'goa1');
      expect(patch['tripShareWith'], ['me']);
    });

    testWidgets('switching the pick off before saving leaves the trip alone', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await tester.ensureVisible(find.text('Add to a trip'));
        await tester.tap(find.text('Add to a trip'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Goa'));
        await tester.pumpAndSettle();

        await tester.tap(find.text('On Goa'));
        await tester.pumpAndSettle();
        expect(find.text('On Goa'), findsNothing);
        expect(find.text('Add to a trip'), findsOneWidget);

        await save(tester);
      }, () => server(calls));

      final patch = jsonDecode(calls.to('PATCH', '/transactions/t9').single.body) as Map<String, dynamic>;
      expect(patch.containsKey('tripId'), isFalse);
      expect(patch.containsKey('tripShareWith'), isFalse);
    });

    testWidgets('a payment already on a trip is not offered another', (tester) async {
      await http.runWithClient(() async {
        tester.view.physicalSize = const Size(1440, 2400);
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
        await tester.pumpWidget(MaterialApp(
          theme: buildTheme(Brightness.light),
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showEditTransactionSheet(
                  context,
                  transaction: Transaction.fromJson({
                    ...ticket().toJsonForTest(),
                    'tripId': 'goa1',
                    'trip': {'name': 'Goa'},
                  }),
                  categories: const [],
                  accounts: const [],
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        ));
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('More'));
        await tester.tap(find.text('More'));
        await tester.pumpAndSettle();

        expect(find.text('On Goa'), findsOneWidget);
        expect(find.text('Add to a trip'), findsNothing);
      }, () => server(_Calls()));
    });
  });

  group('adding earlier payments to a trip', () {
    final rows = [
      _candidate('c3', 'DMart', 150000, day: '2026-10-08'),
      _candidate('c1', 'IRCTC', 240000, travel: true, day: '2026-09-20'),
      _candidate('c2', 'Taj Exotica', 600000, category: 'Travel', travel: true, day: '2026-09-12'),
      _candidate('c4', 'Amazon', 99900, day: '2026-09-01'),
    ];

    /// Answers the candidates list, filtered by any search, and the add.
    MockClient server(_Calls calls, {List<Map<String, dynamic>>? list}) => MockClient((request) async {
          calls.requests.add(request);
          if (request.url.path.endsWith('/candidates')) {
            final q = request.url.queryParameters['q']?.toLowerCase();
            final matching =
                (list ?? rows).where((r) => q == null || (r['merchant'] as String).toLowerCase().contains(q)).toList();
            return _json(matching);
          }
          if (request.url.path.endsWith('/add')) {
            final ids = (jsonDecode(request.body)['transactionIds'] as List).length;
            return _json({'added': ids, 'skipped': 0});
          }
          return http.Response('[]', 200);
        });

    /// Opens the screen from a page that keeps what it pops with.
    Future<List<int?>> open(WidgetTester tester, {Brightness brightness = Brightness.light}) async {
      _phone(tester);
      final results = <int?>[];
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(brightness),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                results.add(await Navigator.of(context).push<int>(
                  MaterialPageRoute(builder: (_) => TripAddPaymentsScreen(trip: _goa)),
                ));
              },
              child: const Text('Go'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('Go'));
      await tester.pumpAndSettle();
      return results;
    }

    double top(WidgetTester tester, String text) => tester.getTopLeft(find.text(text)).dy;

    testWidgets('puts what looks like travel first, then the rest', (tester) async {
      await http.runWithClient(() async {
        await open(tester);

        expect(top(tester, 'Looks like travel'), lessThan(top(tester, 'IRCTC')));
        expect(top(tester, 'IRCTC'), lessThan(top(tester, 'Taj Exotica')));
        expect(top(tester, 'Taj Exotica'), lessThan(top(tester, 'Everything else')));
        expect(top(tester, 'Everything else'), lessThan(top(tester, 'DMart')));
        expect(top(tester, 'DMart'), lessThan(top(tester, 'Amazon')));
        expect(find.text('Pick the payments to add'), findsOneWidget);
      }, () => server(_Calls()));
    });

    testWidgets('totals what is ticked on the button, and adds exactly those', (tester) async {
      final calls = _Calls();
      late List<int?> results;
      await http.runWithClient(() async {
        results = await open(tester);

        await tester.tap(find.text('IRCTC'));
        await tester.pumpAndSettle();
        expect(find.text('Add 1 payment (₹2,400.00)'), findsOneWidget);

        await tester.tap(find.text('Taj Exotica'));
        await tester.tap(find.text('DMart'));
        await tester.pumpAndSettle();
        expect(find.text('Add 3 payments (₹9,900.00)'), findsOneWidget);

        // Unticking takes it back out of the total.
        await tester.tap(find.text('DMart'));
        await tester.pumpAndSettle();
        expect(find.text('Add 2 payments (₹8,400.00)'), findsOneWidget);

        await tester.tap(find.text('Add 2 payments (₹8,400.00)'));
        await tester.pumpAndSettle();
      }, () => server(calls));

      final add = calls.to('POST', '/trips/goa1/add').single;
      expect(jsonDecode(add.body), {
        'transactionIds': ['c1', 'c2'],
      });
      expect(results, [2], reason: 'pops with how many went on, for the snackbar');
    });

    testWidgets('searches, and keeps what was ticked before the search', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await tester.tap(find.text('DMart'));
        await tester.pumpAndSettle();

        await tester.enterText(find.byType(TextField), 'irc');
        await tester.pump(const Duration(milliseconds: 400));
        await tester.pumpAndSettle();

        expect(find.text('IRCTC'), findsOneWidget);
        expect(find.text('DMart'), findsNothing);
        expect(find.text('Amazon'), findsNothing);

        await tester.tap(find.text('IRCTC'));
        await tester.pumpAndSettle();
        expect(find.text('Add 2 payments (₹3,900.00)'), findsOneWidget);
      }, () => server(calls));

      expect(calls.to('GET', '/candidates').last.url.queryParameters['q'], 'irc');
    });

    testWidgets('goes back further, 60 then 180 then 365 days', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await tester.tap(find.text('Go back further'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Go back further'));
        await tester.pumpAndSettle();
        // A year is as far as it goes.
        expect(find.text('Go back further'), findsNothing);
      }, () => server(calls));

      expect(
        calls.to('GET', '/candidates').map((r) => r.url.queryParameters['days']).toList(),
        ['60', '180', '365'],
      );
    });

    testWidgets('says so when there is nothing to add', (tester) async {
      await http.runWithClient(() async {
        await open(tester);
        expect(find.text('Nothing to add'), findsOneWidget);
      }, () => server(_Calls(), list: const []));
    });

    test('the snackbar names the trip and the count', () {
      expect(addedToTripMessage(3, 'Goa'), 'Added 3 payments to Goa');
      expect(addedToTripMessage(1, 'Goa'), 'Added 1 payment to Goa');
    });
  });

  group('at 360 px', () {
    const longName = 'Spiti Valley, Chandratal and the long way back through Manali';

    MockClient server() => MockClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/candidates')) {
            return _json([
              _candidate('c1', 'MAKEMYTRIP INDIA PRIVATE LIMITED GURGAON HARYANA', 12345678,
                  travel: true, category: 'Travel & Transport'),
              _candidate('c2', 'Some very long merchant name for a grocery store nearby', 99999999),
            ]);
          }
          if (path.endsWith('/summary')) {
            return _json({
              'trip': _tripJson('goa1', longName, running: true),
              'totalMinor': 12345678,
              'transactionCount': 2,
              'dayCount': 3,
              'perDayMinor': 4115226,
              'byMember': [],
              'byCategory': [
                {'categoryId': 'x', 'name': 'Travel', 'amountMinor': 12345678},
              ],
            });
          }
          if (path.endsWith('/settlement')) {
            return http.Response('{"balances": [], "transfers": []}', 200);
          }
          if (path.endsWith('/transactions')) {
            return _json([
              {
                'id': 't1',
                'userId': {'id': 'me', 'name': 'Me'},
                'isMine': true,
                'amountMinor': 12345678,
                'type': 'DEBIT',
                'merchant': 'MAKEMYTRIP INDIA PRIVATE LIMITED GURGAON HARYANA',
                'source': 'SMS',
                'occurredAt': '2026-09-20T10:00:00.000Z',
              },
              {
                'id': 't2',
                'userId': {'id': 'asha', 'name': 'Asha Raghunathan Venkataraman'},
                'isMine': false,
                'amountMinor': 450000,
                'type': 'DEBIT',
                'merchant': 'Beach shack',
                'source': 'SMS',
                'occurredAt': '2026-10-11T10:00:00.000Z',
              },
            ]);
          }
          if (path.endsWith('/trips')) {
            return _json([
              _tripJson('goa1', longName, running: true, totalMinor: 1234567),
              _tripJson('ker1', 'Kerala', totalMinor: 99999999),
            ]);
          }
          return http.Response('[]', 200);
        });

    for (final brightness in Brightness.values) {
      testWidgets('the candidates fit, with some ticked (${brightness.name})', (tester) async {
        _phone(tester);
        await http.runWithClient(() async {
          await tester.pumpWidget(MaterialApp(
            theme: buildTheme(brightness),
            home: TripAddPaymentsScreen(trip: Trip.fromJson(_tripJson('goa1', longName, running: true))),
          ));
          await tester.pumpAndSettle();
          await tester.tap(find.textContaining('MAKEMYTRIP'));
          await tester.tap(find.textContaining('Some very long'));
          await tester.pumpAndSettle();
        }, server);

        expect(tester.takeException(), isNull);
        expect(find.textContaining('Add 2 payments'), findsOneWidget);
      });

      testWidgets('an open trip card and its actions fit (${brightness.name})', (tester) async {
        _phone(tester, height: 1600);
        await http.runWithClient(() async {
          await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: const TripsScreen()));
          await tester.pumpAndSettle();
          await tester.tap(find.text(longName).last);
          await tester.pumpAndSettle();
        }, server);

        expect(tester.takeException(), isNull);
        expect(find.text('Add earlier payments'), findsOneWidget);
        expect(find.text('Payments'), findsOneWidget);
      });

      testWidgets("the trip's payments fit (${brightness.name})", (tester) async {
        _phone(tester);
        await http.runWithClient(() async {
          await tester.pumpWidget(MaterialApp(
            theme: buildTheme(brightness),
            home: TripPaymentsScreen(trip: Trip.fromJson(_tripJson('goa1', longName, running: true))),
          ));
          await tester.pumpAndSettle();
        }, server);

        expect(tester.takeException(), isNull);
        expect(find.textContaining('Paid by Asha'), findsOneWidget);
        // Only the user's own row opens the edit sheet.
        expect(find.byWidgetPredicate((w) => w is DsIcon && w.glyph == DsIcons.chevronRight), findsOneWidget);
      });
    }
  });
}

extension on Transaction {
  /// Just enough of the row to build a variant of it.
  Map<String, dynamic> toJsonForTest() => {
        'id': id,
        'userId': userId,
        'amountMinor': amountMinor,
        'type': type,
        'merchant': merchant,
        'source': source,
        'occurredAt': occurredAt.toIso8601String(),
      };
}
