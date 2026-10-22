// Links into SpendLog (a group from Trippin, the web or a notification) and out to Trippin.
import 'package:flutter_test/flutter_test.dart';
import 'package:spendlog/screens/groups_screen.dart';
import 'package:spendlog/services/deep_links.dart';
import 'package:spendlog/services/push_service.dart';
import 'package:url_launcher/url_launcher.dart';

void main() {
  test('a group link in every form it arrives in', () {
    for (final link in [
      'spendlog://app/groups/g1',
      'https://spend-log.duckdns.org/groups/g1',
      'https://spend-log.duckdns.org:50002/groups?group=g1',
      'https://spend-log.duckdns.org:50002/trips?trip=g1',
    ]) {
      expect(groupIdFromLink(Uri.parse(link)), 'g1', reason: link);
    }
  });

  test('links SpendLog does not open', () {
    for (final link in [
      'spendlog://other/groups/g1',
      'spendlog://app/settings',
      'https://spend-log.duckdns.org/groups',
      'https://spend-log.duckdns.org/SpendLog.apk',
      'https://spend-log.duckdns.org/',
      'trippin://app/trip/t1',
    ]) {
      expect(groupIdFromLink(Uri.parse(link)), isNull, reason: link);
    }
  });

  test('a Trippin trip page maps to Trippin’s own link', () {
    expect(trippinAppLink('https://trip-pin.duckdns.org:50009/trips/t1').toString(), 'trippin://app/trip/t1');
    expect(trippinAppLink('https://trip-pin.duckdns.org/trips/new'), isNull);
    expect(trippinAppLink('https://trip-pin.duckdns.org/'), isNull);
  });

  test('"Planned in Trippin" tries Trippin first, then the web page', () async {
    final tried = <(String, LaunchMode)>[];
    Future<bool> notInstalled(Uri uri, LaunchMode mode) async {
      tried.add((uri.toString(), mode));
      if (uri.scheme == 'trippin') throw Exception('ACTIVITY_NOT_FOUND');
      return true;
    }

    expect(await openSuiteUrl('https://trip-pin.duckdns.org:50009/trips/t1', launcher: notInstalled), isTrue);
    expect(tried, [
      ('trippin://app/trip/t1', LaunchMode.externalNonBrowserApplication),
      ('https://trip-pin.duckdns.org:50009/trips/t1', LaunchMode.externalApplication),
    ]);

    tried.clear();
    Future<bool> installed(Uri uri, LaunchMode mode) async {
      tried.add((uri.toString(), mode));
      return true;
    }

    expect(await openSuiteUrl('https://trip-pin.duckdns.org/trips/t1', launcher: installed), isTrue);
    expect(tried.length, 1);
  });

  test('a group notification opens the group, or the list when it is about several', () {
    final one = PushService.screenFor({'type': 'GROUP', 'groupId': 'g1', 'link': 'spendlog://app/groups/g1'});
    expect(one, isA<GroupLinkScreen>());
    expect((one as GroupLinkScreen).groupId, 'g1');
    expect(PushService.screenFor({'type': 'GROUP'}), isA<GroupsScreen>());
  });
}
