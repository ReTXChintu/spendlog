import 'package:flutter_test/flutter_test.dart';
import 'package:spendlog/screens/passbook_screen.dart';
import 'package:spendlog/screens/subscriptions_screen.dart';
import 'package:spendlog/services/push_service.dart';
import 'package:spendlog/services/reminder_service.dart';

void main() {
  group('a push shown while the app is open', () {
    test('its tap carries the push data back to the same screen', () {
      final data = {'type': 'BALANCE_DRIFT', 'accountId': 'acc1', 'alertId': 'al1'};
      final back = pushDataFrom(pushPayload(data));

      expect(back, data);
      expect(PushService.screenFor(back!), isA<PassbookScreen>());
    });

    test('a push with no id still opens its list', () {
      final back = pushDataFrom(pushPayload({'type': 'SUBSCRIPTION'}));
      expect(PushService.screenFor(back!), isA<SubscriptionsScreen>());
    });

    test('other payloads are not taken for one', () {
      expect(pushDataFrom(perksPayload), isNull);
      expect(pushDataFrom('${pushPayloadPrefix}not json'), isNull);
      expect(pushDataFrom('$pushPayloadPrefix[1, 2]'), isNull);
    });

    test('each push gets its own id, clear of the reminders', () {
      final a = PushService.foregroundNotificationId('0:1700000000000001%abc');
      final b = PushService.foregroundNotificationId('0:1700000000000002%abc');

      expect(a, isNot(b));
      expect(a, PushService.foregroundNotificationId('0:1700000000000001%abc'));
      for (final id in [a, b, PushService.foregroundNotificationId(null)]) {
        expect(id, inInclusiveRange(1000, 1000999));
      }
    });
  });
}
