import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/metal_models.dart';
import 'package:spendlog/screens/investments/investments_screen.dart';
import 'package:spendlog/screens/investments/metals_tab.dart';
import 'package:spendlog/services/push_service.dart';
import 'package:spendlog/theme.dart';

import 'investments_test.dart' show metalsJson;

MockClient _server(List<http.Request> requests, {Map<String, dynamic> rates = metalsJson}) => MockClient((request) async {
      requests.add(request);
      if (request.url.path.endsWith('/metals/settings')) {
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        return http.Response(jsonEncode({...rates, 'push': body['push']}), 200);
      }
      return http.Response(jsonEncode(rates), 200);
    });

Future<void> _phone(WidgetTester tester, Widget home, {Brightness brightness = Brightness.light}) async {
  tester.view.physicalSize = const Size(1080, 3600);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: home));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('reads the rates, their signal and history', () {
    final rates = MetalRates.fromJson(metalsJson);
    expect(rates.available, isTrue);
    expect((rates.gold24Minor, rates.gold22Minor, rates.gold18Minor), (1408910, 1290560, 1056680));
    expect(rates.goldSignal.isGoodDay, isTrue);
    expect(rates.goldHistory.length, 3);
    expect(rates.silverPerKgMinor, 18380000);
    expect(rates.sessionLabel, 'Morning rates');
    expect(averageLine(rates.goldSignal), '1.5% below its 30-day average');
    expect(averageLine(rates.silverSignal), '8.1% above its 30-day average');
    expect(MetalRates.fromJson(const {}).available, isFalse);
  });

  testWidgets('the Gold tab shows every purity, the signal, and turns the notification on', (tester) async {
    final requests = <http.Request>[];
    final server = _server(requests);
    await http.runWithClient(() async {
      await _phone(tester, const Scaffold(body: MetalsTab()));
      expect(find.text('A good day to buy gold'), findsOneWidget);
      expect(find.text('₹14,089.10'), findsOneWidget);
      expect(find.text('₹12,905.60'), findsOneWidget);
      expect(find.text('₹10,566.80'), findsOneWidget);
      expect(find.text('Silver is above its usual'), findsOneWidget);
      await tester.scrollUntilVisible(find.byKey(const ValueKey('metal-push')), 300, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.byKey(const ValueKey('metal-push')));
      await tester.pumpAndSettle();
    }, () => server);

    final patch = requests.where((r) => r.method == 'PATCH').single;
    expect(jsonDecode(patch.body), {'push': true});
    expect(tester.widget<SwitchListTile>(find.byKey(const ValueKey('metal-push'))).value, isTrue);
  });

  testWidgets('says when there are no rates yet', (tester) async {
    await http.runWithClient(() async {
      await _phone(tester, const Scaffold(body: MetalsTab()));
    }, () => _server([], rates: const {'available': false}));
    expect(find.text('No rates yet'), findsOneWidget);
  });

  testWidgets('the Home tile marks a good day for gold', (tester) async {
    await _phone(tester, Scaffold(body: MetalsTile(rates: MetalRates.fromJson(metalsJson))));
    expect(find.text('Good day for gold'), findsOneWidget);
    expect(find.text('Gold is 1.5% below its 30-day average'), findsOneWidget);
  });

  for (final brightness in Brightness.values) {
    testWidgets('the Gold tab and Home tile fit a 360 px phone (${brightness.name})', (tester) async {
      await http.runWithClient(() async {
        await _phone(
          tester,
          Scaffold(
            body: Column(children: [
              MetalsTile(rates: MetalRates.fromJson(metalsJson)),
              const Expanded(child: MetalsTab()),
            ]),
          ),
          brightness: brightness,
        );
        expect(tester.takeException(), isNull);
      }, () => _server([]));
    });
  }

  test("the day's rates notification opens the Gold tab", () {
    final screen = PushService.screenFor({'type': 'METAL_RATES'});
    expect(screen, isA<InvestmentsScreen>());
    expect((screen! as InvestmentsScreen).initialTab, 2);
  });
}
