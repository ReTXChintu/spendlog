import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../config.dart';
import 'install_info.dart';

/// Every credential SpendLog keeps on the phone, in one place.
///
/// They live in flutter_secure_storage, not SharedPreferences. Android Auto
/// Backup copies SharedPreferences to the Google account and restores them
/// on a reinstall or a new phone, and with them a session token in plain
/// text: SpendLog opened already signed in. flutter_secure_storage encrypts
/// with an Android Keystore key, which is never backed up and is destroyed
/// on uninstall, and its own files are excluded from backup besides
/// (res/xml/backup_rules.xml), so nothing here survives a reinstall.
///
/// Background isolates - the SMS receiver, the push handler, the reminder
/// task - read through this too. The plugin is registered in their engines
/// like every other one.
class CredentialStore {
  CredentialStore([this._storage = const FlutterSecureStorage()]);

  /// Swapped in tests.
  static CredentialStore instance = CredentialStore();

  final FlutterSecureStorage _storage;

  /// The owner's session is [tokenStorageKey]. A kid's lives under its own
  /// key, so the background isolates, which read the owner's, find nothing
  /// on a kid's phone and send nothing.
  static const kidTokenKey = 'spendlog_kid_token';
  static const roleKey = 'spendlog_role';

  /// The last OIDC ID token, kept only as the hint for ending the session
  /// at the identity server on sign-out. It names the person, and it is no
  /// use on any install but the one that signed in.
  static const idTokenKey = 'spendlog_oidc_id_token';

  /// The FCM token this phone last gave the server. Not a way in, but it
  /// belongs to this install alone: restored onto a new phone, sign-out
  /// there would unregister the old phone instead.
  static const pushTokenKey = 'spendlog_push_token';

  /// Everything older builds kept in plain SharedPreferences, under the
  /// same names.
  static const legacyKeys = [tokenStorageKey, kidTokenKey, roleKey, idTokenKey, pushTokenKey];

  Future<void>? _migration;

  /// Moves credentials out of SharedPreferences, once per isolate. Every
  /// read waits for it, so nothing can see a token before it has moved;
  /// main() starts it early only so the first read does not wait as long.
  /// A failed run is tried again on the next read.
  Future<void> ready() => _migration ??= _migrateLegacy().catchError((Object _) {
        _migration = null;
      });

  /// The owner's session token, or null when signed out or signed in as a
  /// kid. What the background isolates send.
  Future<String?> ownerToken() => read(tokenStorageKey);

  /// Null when unset, and also when the store cannot be read: a broken
  /// store means signing in again, never a crash at start-up.
  Future<String?> read(String key) async {
    await ready();
    try {
      return await _storage.read(key: key);
    } catch (_) {
      return null;
    }
  }

  Future<void> write(String key, String value) async {
    await ready();
    await _storage.write(key: key, value: value);
  }

  Future<void> delete(String key) async {
    await ready();
    await _storage.delete(key: key);
  }

  /// Copies what an older build left in SharedPreferences into secure
  /// storage, then deletes it from SharedPreferences.
  ///
  /// Safe to run more than once and from two isolates at a time: a key is
  /// only copied when secure storage has nothing under it - a value already
  /// there is newer and wins - and it is removed from SharedPreferences
  /// either way.
  ///
  /// Copied only when an older build of this same install wrote it. On a
  /// fresh install, a token in SharedPreferences came from a backup taken
  /// before credentials moved out of it, and carrying it over would open
  /// the app signed in all over again; it is deleted and the person signs
  /// in.
  Future<void> _migrateLegacy() async {
    final prefs = await SharedPreferences.getInstance();
    // Another isolate may have moved them since this one loaded the file.
    await prefs.reload();

    final legacy = <String, String>{};
    for (final key in legacyKeys) {
      final value = prefs.get(key);
      if (value is String) legacy[key] = value;
    }
    if (legacy.isEmpty) return;

    final carryOver = (await InstallInfo.load()).updatedInPlace;
    for (final entry in legacy.entries) {
      if (carryOver && await _storage.read(key: entry.key) == null) {
        await _storage.write(key: entry.key, value: entry.value);
      }
      await prefs.remove(entry.key);
    }
  }
}
