import 'dart:async';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:spendlog/services/credential_store.dart';
import 'package:spendlog/services/install_info.dart';

/// Runs around every test file. Credentials live in flutter_secure_storage,
/// a plugin with no platform under `flutter test`, so each test starts with
/// an empty in-memory one - and a fresh CredentialStore, whose once-per-
/// isolate move out of SharedPreferences would otherwise only ever run for
/// the first test.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues({});
    CredentialStore.instance = CredentialStore();
    InstallInfo.load = () async => const InstallInfo();
  });
  await testMain();
}
