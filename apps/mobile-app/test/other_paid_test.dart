import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/dashboard_screen.dart';
import 'package:spendlog/screens/other_paid_screen.dart';
import 'package:spendlog/services/other_paid_check.dart';
import 'package:spendlog/services/push_service.dart';
import 'package:spendlog/theme.dart';

Group _group(String id, String name) => Group.fromJson({'id': id, 'name': name, 'startDate': '2026-09-01', 'members': []});

/// Home's request answered with the least a dashboard needs, and every
/// request kept.
MockClient _server(List<http.Request> requests) => MockClient((request) async {
      requests.add(request);
      final path = request.url.path;
      if (path.endsWith('/dashboard')) return http.Response('{}', 200);
      if (path.endsWith('/contacts')) return http.Response('{"contacts": []}', 200);
      if (path.endsWith('/groups/active')) {
        return http.Response(
          jsonEncode([
            {'id': 'g1', 'name': 'Indore', 'startDate': '2026-10-01', 'members': []},
            {'id': 'g2', 'name': 'Flatmates', 'startDate': '2026-09-01', 'members': []},
          ]),
          200,
        );
      }
      return http.Response('{}', 200);
    });

Future<void> _phone(WidgetTester tester, Widget home) async {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: home));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('asks about the group called Flatmates, else the only one, else none', () {
    expect(OtherPaidCheck.defaultGroup([_group('a', 'Indore'), _group('b', 'flatmates ')])?.id, 'b');
    expect(OtherPaidCheck.defaultGroup([_group('a', 'Indore')])?.id, 'a');
    expect(OtherPaidCheck.defaultGroup([_group('a', 'Indore'), _group('b', 'Goa')]), isNull);
    expect(OtherPaidCheck.defaultGroup(const []), isNull);
  });

  test("today is India's day, so a payment at 11 pm still counts as today", () {
    expect(OtherPaidCheck.todayKey(DateTime.utc(2026, 10, 28, 17, 0)), '2026-10-28');
    expect(OtherPaidCheck.todayKey(DateTime.utc(2026, 10, 28, 19, 0)), '2026-10-29');
  });

  test('is on at 9 pm by default, and answered for the day once said', () async {
    final settings = await OtherPaidCheck.instance.settings();
    expect(settings.enabled, isTrue);
    expect((settings.hour, settings.minute), (21, 0));
    expect(settings.hasGroup, isFalse);

    final evening = DateTime.utc(2026, 10, 28, 15, 0);
    expect(await OtherPaidCheck.instance.answeredToday(evening), isFalse);
    await OtherPaidCheck.instance.markAnswered(evening);
    expect(await OtherPaidCheck.instance.answeredToday(evening), isTrue);
    expect(await OtherPaidCheck.instance.answeredToday(evening.add(const Duration(days: 1))), isFalse);
  });

  testWidgets('Home asks about Flatmates until today is answered', (tester) async {
    final requests = <http.Request>[];
    await http.runWithClient(() async {
      await _phone(tester, const Scaffold(body: DashboardScreen()));
      expect(find.text('Did anyone in Flatmates pay for something today?'), findsOneWidget);
      await tester.tap(find.text('Nothing today'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('other-paid-card')), findsNothing);
    }, () => _server(requests));

    expect(await OtherPaidCheck.instance.answeredToday(), isTrue);
    expect((await OtherPaidCheck.instance.settings()).groupName, 'Flatmates');
  });

  testWidgets('switched off, Home does not ask', (tester) async {
    SharedPreferences.setMockInitialValues({'spendlog_other_paid_enabled': false});
    await http.runWithClient(() async {
      await _phone(tester, const Scaffold(body: DashboardScreen()));
    }, () => _server([]));
    expect(find.byKey(const ValueKey('other-paid-card')), findsNothing);
  });

  test("the evening notification opens the form", () {
    expect(PushService.screenFor({'type': 'OTHER_PAID'}), isA<OtherPaidScreen>());
  });
}
