import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/config.dart';
import 'package:spendlog/main.dart';
import 'package:spendlog/screens/start_screen.dart';
import 'package:spendlog/services/api_client.dart';
import 'package:spendlog/services/credential_store.dart';
import 'package:spendlog/services/install_info.dart';
import 'package:spendlog/services/sms_service.dart';

/// An install that an older build ran on before this one: the app was
/// updated in place, so what SharedPreferences holds, this install wrote.
final _updatedInPlace = InstallInfo(
  installedAt: DateTime(2026, 3, 1),
  updatedAt: DateTime(2026, 10, 22),
);

/// A fresh install, both times the same. Anything in SharedPreferences came
/// from a backup.
final _freshInstall = InstallInfo(
  installedAt: DateTime(2026, 10, 22, 9),
  updatedAt: DateTime(2026, 10, 22, 9),
);

/// What a build before the move left in SharedPreferences, as the plugin
/// stores it.
const _legacyCredentials = <String, Object>{
  tokenStorageKey: 'owner-token',
  CredentialStore.idTokenKey: 'id-token',
  CredentialStore.pushTokenKey: 'fcm-token',
};

/// Preferences that are not secrets, and keep being backed up.
const _settings = <String, Object>{
  'spendlog_theme_mode': 'dark',
  'spendlog_sms_last_sync': 1760000000000,
  'spendlog_sms_backfill_done': true,
  'spendlog_sms_permission_granted': true,
  'spendlog_reminder_plan': true,
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secure;

  setUp(() {
    // Held by reference, so each test can look at what was written.
    secure = <String, String>{};
    FlutterSecureStorage.setMockInitialValues(secure);
  });

  group('moving credentials out of SharedPreferences', () {
    test('an update in place carries every credential over and clears it from prefs', () async {
      InstallInfo.load = () async => _updatedInPlace;
      SharedPreferences.setMockInitialValues({..._legacyCredentials, ..._settings});

      expect(await ApiClient.getToken(), 'owner-token');
      expect(secure, {
        tokenStorageKey: 'owner-token',
        CredentialStore.idTokenKey: 'id-token',
        CredentialStore.pushTokenKey: 'fcm-token',
      });

      final prefs = await SharedPreferences.getInstance();
      for (final key in CredentialStore.legacyKeys) {
        expect(prefs.containsKey(key), isFalse, reason: key);
      }
      // The rest stays where it is, and keeps being backed up.
      expect(prefs.getString('spendlog_theme_mode'), 'dark');
      expect(prefs.getInt('spendlog_sms_last_sync'), 1760000000000);
    });

    test("a kid's session carries over as a kid's session", () async {
      InstallInfo.load = () async => _updatedInPlace;
      SharedPreferences.setMockInitialValues({
        CredentialStore.kidTokenKey: 'kid-token',
        CredentialStore.roleKey: 'kid',
      });

      expect(await currentRole(), AppRole.kid);
      expect(await ApiClient.getKidToken(), 'kid-token');
      expect(await ApiClient.getToken(), isNull);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getKeys(), isEmpty);
    });

    test('a value already in secure storage wins over the one in prefs', () async {
      InstallInfo.load = () async => _updatedInPlace;
      secure[tokenStorageKey] = 'newer-token';
      SharedPreferences.setMockInitialValues({tokenStorageKey: 'older-token'});

      expect(await ApiClient.getToken(), 'newer-token');
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.containsKey(tokenStorageKey), isFalse);
    });

    test('runs safely more than once, and from two isolates at a time', () async {
      InstallInfo.load = () async => _updatedInPlace;
      SharedPreferences.setMockInitialValues({..._legacyCredentials});

      // Two stores stand in for the app and a background isolate, each
      // with its own once-per-isolate migration, racing over one file.
      final app = CredentialStore();
      final background = CredentialStore();
      await Future.wait([app.ready(), background.ready()]);
      await CredentialStore().ready();

      expect(await app.ownerToken(), 'owner-token');
      expect(await background.ownerToken(), 'owner-token');
      expect(secure[CredentialStore.idTokenKey], 'id-token');
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getKeys(), isEmpty);
    });

    test('a token restored by a backup onto a fresh install is dropped, not carried over', () async {
      InstallInfo.load = () async => _freshInstall;
      SharedPreferences.setMockInitialValues({..._legacyCredentials, ..._settings});

      expect(await currentRole(), AppRole.signedOut);
      expect(secure, isEmpty);
      final prefs = await SharedPreferences.getInstance();
      for (final key in CredentialStore.legacyKeys) {
        expect(prefs.containsKey(key), isFalse, reason: key);
      }
      expect(prefs.getString('spendlog_theme_mode'), 'dark');
    });

    test('when the install cannot be told apart, a token in prefs is dropped', () async {
      InstallInfo.load = () async => const InstallInfo();
      SharedPreferences.setMockInitialValues({tokenStorageKey: 'owner-token'});

      expect(await ApiClient.getToken(), isNull);
      expect(secure, isEmpty);
    });
  });

  group('sessions in secure storage', () {
    test('signing in, reading and signing out never touch SharedPreferences', () async {
      SharedPreferences.setMockInitialValues({});

      await ApiClient.setToken('owner-token');
      expect(secure[tokenStorageKey], 'owner-token');
      expect(await ApiClient.getToken(), 'owner-token');
      // What the background SMS, push and reminder isolates read.
      expect(await CredentialStore.instance.ownerToken(), 'owner-token');

      await ApiClient.clearToken();
      expect(await ApiClient.getToken(), isNull);
      expect(secure.containsKey(tokenStorageKey), isFalse);

      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getKeys(), isEmpty);
    });

    test("a kid's session is told apart from an owner's", () async {
      SharedPreferences.setMockInitialValues({});

      await ApiClient.setKidSession('kid-token');
      expect(await ApiClient.isKidSession(), isTrue);
      expect(secure[CredentialStore.roleKey], 'kid');
      // The background isolates read the owner's token, and find none.
      expect(await CredentialStore.instance.ownerToken(), isNull);

      // A role left behind with no token is not a kid's session.
      await CredentialStore.instance.delete(CredentialStore.kidTokenKey);
      expect(await ApiClient.isKidSession(), isFalse);

      await ApiClient.setKidSession('kid-token');
      await ApiClient.setToken('owner-token');
      expect(await ApiClient.isKidSession(), isFalse);
      expect(secure.containsKey(CredentialStore.kidTokenKey), isFalse);
      expect(secure.containsKey(CredentialStore.roleKey), isFalse);
    });
  });

  group('restored onto a new install', () {
    testWidgets('preferences with no credentials open at sign-in', (tester) async {
      InstallInfo.load = () async => _freshInstall;
      SharedPreferences.setMockInitialValues({..._settings});

      await tester.pumpWidget(const SpendLogApp());
      await tester.pumpAndSettle();

      expect(find.text('Sign in with your account'), findsOneWidget);
    });

    test('a restored "granted" flag does not count; Android is asked', () async {
      SharedPreferences.setMockInitialValues({..._settings});
      final sms = SmsService.instance;
      final original = sms.smsPermissionGranted;
      addTearDown(() => sms.smsPermissionGranted = original);

      sms.smsPermissionGranted = () async => false;
      expect(await sms.hasPermission(), isFalse);

      sms.smsPermissionGranted = () async => true;
      expect(await sms.hasPermission(), isTrue);

      // A failed check is "not granted", never a crash.
      sms.smsPermissionGranted = () async => throw StateError('no plugin');
      expect(await sms.hasPermission(), isFalse);
    });

    test('a restored "backfill done" flag does not skip the scan on a new phone', () async {
      SharedPreferences.setMockInitialValues({..._settings});
      final prefs = await SharedPreferences.getInstance();

      expect(await SmsService.backfillDoneOnThisInstall(prefs, _freshInstall), isFalse);
      // The old flag is gone, and asking again still says to scan.
      expect(prefs.containsKey('spendlog_sms_backfill_done'), isFalse);
      expect(await SmsService.backfillDoneOnThisInstall(prefs, _freshInstall), isFalse);
    });

    test('an update in place keeps the old "backfill done" flag', () async {
      SharedPreferences.setMockInitialValues({..._settings});
      final prefs = await SharedPreferences.getInstance();

      expect(await SmsService.backfillDoneOnThisInstall(prefs, _updatedInPlace), isTrue);
      expect(prefs.containsKey('spendlog_sms_backfill_done'), isFalse);
      // Kept as this install's stamp now, so it carries on counting here...
      expect(await SmsService.backfillDoneOnThisInstall(prefs, _updatedInPlace), isTrue);
      // ...and nowhere else.
      expect(await SmsService.backfillDoneOnThisInstall(prefs, _freshInstall), isFalse);
    });
  });
}
