import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/accounts_screen.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/card_available_panel.dart';
import 'package:spendlog/widgets/home/wallet.dart';

// A credit card's limit left, as accounts.routes.ts (the overview's cycle
// block) and cards.status.ts send it. Paise throughout.

const _card = '64a000000000000000000011';

/// 10 Oct 2026, 6 pm IST: the clock the panel reads ages from.
final _now = DateTime.utc(2026, 10, 10, 12, 30);

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

MockClient _server(Map<String, Object> routes, {List<http.Request>? log}) => MockClient((request) async {
      log?.add(request);
      for (final entry in routes.entries) {
        if (request.url.path.endsWith(entry.key)) return _json(entry.value);
      }
      return _json([]);
    });

Finder _richTextContaining(String text) =>
    find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().contains(text));

Future<void> _pump(WidgetTester tester, Widget body, {Brightness brightness = Brightness.light}) async {
  // 360 logical pixels: the narrowest phone the app is laid out for.
  tester.view.physicalSize = const Size(1080, 4800);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: buildTheme(brightness),
    home: Scaffold(body: SingleChildScrollView(padding: const EdgeInsets.all(16), child: body)),
  ));
}

CardAvailablePanel _panel(CardAvailability availability, {VoidCallback? onChanged, List<String> sharedWith = const []}) =>
    CardAvailablePanel(
      accountId: _card,
      availability: availability,
      onChanged: onChanged ?? () {},
      sharedWith: sharedWith,
      now: () => _now,
    );

const _yours = CardAvailability(
  availableMinor: 3950000,
  source: 'you',
  anchorMinor: 4000000,
  chargedSinceMinor: 150000,
  paidSinceMinor: 100000,
  creditLimitMinor: 10000000,
);

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('the model', () {
    test('reads the stated figure, and an older server as computed', () {
      final stated = CardAvailability.fromJson({
        'availableMinor': 2930000,
        'availableSource': 'sms',
        'availableAsOf': '2026-10-06T06:30:00.000Z',
        'availableLimitAnchorMinor': 3000000,
        'chargedSinceAnchorMinor': 70000,
        'paidSinceAnchorMinor': 0,
        'creditLimitMinor': 10000000,
      });
      expect(stated.isStated, isTrue);
      expect(stated.source, 'sms');
      expect(stated.asOf, DateTime.utc(2026, 10, 6, 6, 30));
      expect(stated.anchorMinor, 3000000);

      final older = CardAvailability.fromJson({'availableMinor': 5000000, 'creditLimitMinor': 10000000});
      expect(older.source, 'computed');
      expect(older.isStated, isFalse);

      final face = CardFace.fromJson({'accountId': _card, 'name': 'HDFC'});
      expect(face.availableSource, 'computed');
    });
  });

  group('the panel', () {
    for (final brightness in Brightness.values) {
      testWidgets('with nothing stated, asks for the figure ($brightness)', (tester) async {
        await _pump(tester, _panel(const CardAvailability(availableMinor: 9700000, creditLimitMinor: 10000000)),
            brightness: brightness);
        expect(find.text('Available limit'), findsOneWidget);
        expect(find.textContaining('Add what your bank app shows as available'), findsOneWidget);
        expect(find.text('Add available limit'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('a figure you set: what is left, and how it got there', (tester) async {
      await _pump(
        tester,
        _panel(CardAvailability(
          availableMinor: _yours.availableMinor,
          source: 'you',
          asOf: DateTime.utc(2026, 10, 5, 6, 30),
          anchorMinor: _yours.anchorMinor,
          chargedSinceMinor: _yours.chargedSinceMinor,
          paidSinceMinor: _yours.paidSinceMinor,
          creditLimitMinor: _yours.creditLimitMinor,
        )),
      );
      expect(find.text('Available now'), findsOneWidget);
      expect(find.text('₹39,500.00'), findsOneWidget);
      expect(_richTextContaining('You set ₹40,000.00 on 5 Oct · −₹1,500.00 spent · +₹1,000.00 paid since'),
          findsOneWidget);
      expect(find.text('Update'), findsOneWidget);
      expect(find.text('Stop'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets("the bank's SMS: how long ago, and nothing to stop", (tester) async {
      await _pump(
        tester,
        _panel(
          CardAvailability(
            availableMinor: 2930000,
            source: 'sms',
            asOf: _now.subtract(const Duration(hours: 2)),
            anchorMinor: 3000000,
            chargedSinceMinor: 70000,
            paidSinceMinor: 0,
          ),
          sharedWith: ['HDFC Add-on ••8882'],
        ),
      );
      expect(find.text('₹29,300.00'), findsOneWidget);
      expect(_richTextContaining("From your bank's SMS · 2 h ago · −₹700.00 spent since"), findsOneWidget);
      expect(find.text('Update'), findsOneWidget);
      expect(find.text('Stop'), findsNothing);
      expect(find.textContaining('Shared with HDFC Add-on ••8882'), findsOneWidget);
    });

    testWidgets('refunds since are said as money back, not a negative spend', (tester) async {
      await _pump(
        tester,
        _panel(CardAvailability(
          availableMinor: 4050000,
          source: 'you',
          asOf: _now.subtract(const Duration(hours: 1)),
          anchorMinor: 4000000,
          chargedSinceMinor: -50000,
          paidSinceMinor: 0,
        )),
      );
      expect(_richTextContaining('You set ₹40,000.00 today · +₹500.00 refunded since'), findsOneWidget);
    });

    testWidgets('Stop asks first, then clears the figure', (tester) async {
      final log = <http.Request>[];
      var changed = 0;
      await http.runWithClient(() async {
        await _pump(
          tester,
          _panel(
            CardAvailability(
              availableMinor: _yours.availableMinor,
              source: 'you',
              asOf: DateTime.utc(2026, 10, 5),
              anchorMinor: _yours.anchorMinor,
            ),
            onChanged: () => changed += 1,
          ),
        );
        await tester.tap(find.text('Stop'));
        await tester.pumpAndSettle();
        expect(find.text('Stop using this figure?'), findsOneWidget);
        await tester.tap(find.widgetWithText(FilledButton, 'Stop'));
        await tester.pumpAndSettle();
      }, () => _server({'/accounts/$_card': {}}, log: log));

      final patches = log.where((r) => r.method == 'PATCH').toList();
      expect(patches, hasLength(1));
      expect(jsonDecode(patches.single.body), {'availableLimitMinor': null});
      expect(changed, 1);
    });
  });

  group('the dialog', () {
    testWidgets('asks for the credit limit too when the card has none, and checks the two agree', (tester) async {
      final log = <http.Request>[];
      var changed = 0;
      await http.runWithClient(() async {
        await _pump(tester, _panel(const CardAvailability(), onChanged: () => changed += 1));
        await tester.tap(find.text('Add available limit'));
        await tester.pumpAndSettle();

        expect(find.byKey(const ValueKey('credit-limit')), findsOneWidget);

        // Nothing typed.
        await tester.tap(find.text('Save'));
        await tester.pump();
        expect(find.text('Type the available limit as a number.'), findsOneWidget);

        // More left than the whole limit.
        await tester.enterText(find.byKey(const ValueKey('available-amount')), '50,000');
        await tester.enterText(find.byKey(const ValueKey('credit-limit')), '40000');
        await tester.tap(find.text('Save'));
        await tester.pump();
        expect(find.text("That's more than the card's ₹40,000.00 limit."), findsOneWidget);
        expect(log.where((r) => r.method == 'PATCH'), isEmpty);

        await tester.enterText(find.byKey(const ValueKey('credit-limit')), '100000');
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();
      }, () => _server({'/accounts/$_card': {}}, log: log));

      final patches = log.where((r) => r.method == 'PATCH').toList();
      expect(patches, hasLength(1));
      expect(patches.single.url.path, endsWith('/accounts/$_card'));
      // "Right now" sends no moment: the server takes it as now.
      expect(jsonDecode(patches.single.body), {'availableLimitMinor': 5000000, 'creditLimitMinor': 10000000});
      expect(changed, 1);
    });

    testWidgets('with a limit already set, checks against it and asks for nothing else', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, _panel(_yours));
        await tester.tap(find.text('Update'));
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('credit-limit')), findsNothing);

        await tester.enterText(find.byKey(const ValueKey('available-amount')), '150000');
        await tester.tap(find.text('Save'));
        await tester.pump();
        expect(find.text("That's more than the card's ₹1,00,000.00 limit."), findsOneWidget);

        await tester.enterText(find.byKey(const ValueKey('available-amount')), '62500.50');
        await tester.tap(find.text('Save'));
        await tester.pumpAndSettle();
      }, () => _server({'/accounts/$_card': {}}, log: log));

      expect(jsonDecode(log.singleWhere((r) => r.method == 'PATCH').body), {'availableLimitMinor': 6250050});
    });
  });

  group('the accounts page', () {
    Map<String, Object> overview(Map<String, Object?> cycle) => {
          '/accounts/overview': [
            {
              'id': _card,
              'bankName': 'HDFC Bank',
              'last4': '1377',
              'accountType': 'CARD',
              'creditLimitMinor': 5000000,
              'availableLimitMinor': 3000000,
              'availableLimitAt': '2026-10-05T06:30:00.000Z',
              'hasCardDetails': false,
              'cycle': cycle,
              'month': {'spentMinor': 0},
            },
          ],
          '/statements/filed': <Object>[],
        };

    testWidgets('shows the figure for a card with no statement day', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const SizedBox(height: 4000, child: AccountsScreen()));
        await tester.pumpAndSettle();

        expect(find.text('Available now'), findsOneWidget);
        expect(find.text('₹27,500.00'), findsOneWidget);
        expect(find.textContaining('Set a statement day'), findsOneWidget);
        expect(tester.takeException(), isNull);
      }, () => _server(overview({
            'cycleKnown': false,
            'creditLimitMinor': 5000000,
            'outstandingMinor': 2250000,
            'usedMinor': 2250000,
            'availableMinor': 2750000,
            'availableSource': 'you',
            'availableAsOf': '2026-10-05T06:30:00.000Z',
            'availableLimitAnchorMinor': 3000000,
            'chargedSinceAnchorMinor': 250000,
            'paidSinceAnchorMinor': 0,
            'state': 'ok',
          })));
    });

    testWidgets("the meter says where what's available comes from", (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const SizedBox(height: 4000, child: AccountsScreen()));
        await tester.pumpAndSettle();

        expect(find.text('Owed on this card'), findsOneWidget);
        expect(find.textContaining("₹29,300.00 available from your bank's SMS"), findsOneWidget);
      }, () => _server(overview({
            'cycleKnown': true,
            'creditLimitMinor': 5000000,
            'unbilledMinor': 70000,
            'billedUnpaidMinor': 0,
            'outstandingMinor': 2070000,
            'usedMinor': 2070000,
            'availableMinor': 2930000,
            'availableSource': 'sms',
            'availableAsOf': '2026-10-06T06:30:00.000Z',
            'availableLimitAnchorMinor': 3000000,
            'chargedSinceAnchorMinor': 70000,
            'paidSinceAnchorMinor': 0,
            'state': 'ok',
          })));
    });
  });

  group('the card face', () {
    test('a stated figure is said with no billing date, and with no limit', () {
      final noCycle = CardFace.fromJson({
        'accountId': _card,
        'name': 'HDFC',
        'cycleKnown': false,
        'creditLimitMinor': 5000000,
        'usedMinor': 2250000,
        'availableMinor': 2750000,
        'availableSource': 'you',
      });
      expect(cardLimitLine(noCycle), '₹22,500 of ₹50,000 used · ₹27,500 available');

      final noLimit = CardFace.fromJson({
        'accountId': _card,
        'name': 'HDFC',
        'usedMinor': 500000,
        'availableMinor': 1900000,
        'availableSource': 'sms',
      });
      expect(cardLimitLine(noLimit), '₹19,000 available');

      // Nothing stated: as before.
      expect(
        cardLimitLine(CardFace.fromJson({'accountId': _card, 'name': 'HDFC', 'cycleKnown': false})),
        'Cycle unknown',
      );
    });
  });
}
