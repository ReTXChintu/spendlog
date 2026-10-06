import 'dart:async';
import 'dart:io' show Platform;
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api_client.dart';
import 'sms_service.dart';

/// The FCM token this phone last gave the server, so sign-out can remove
/// the same one even if Firebase has since handed out a new one.
const String _registeredTokenKey = 'spendlog_push_token';

/// The only push the server sends: a kid pulled to refresh, so read any
/// new bank SMS on this (the owner's) phone and upload them.
const String _smsSyncType = 'SMS_SYNC';

/// Whether this phone is signed in as the owner. A kid's phone must never
/// register for pushes or read SMS, and a signed-out one has no one to
/// upload for.
Future<bool> _isOwner() async {
  if (await ApiClient.isKidSession()) return false;
  return await ApiClient.getToken() != null;
}

/// Reads and uploads new SMS, quietly. Nothing is shown: the kid is the one
/// waiting for the result, on their own phone.
Future<void> _syncSms() async {
  if (!await _isOwner()) return;
  if (!await SmsService.instance.hasPermission()) return;
  try {
    await SmsService.instance.syncNow();
  } catch (_) {
    // Best-effort: the next manual or pushed sync covers the same window.
  }
}

/// Runs in its own isolate when a push arrives while the app is in the
/// background or closed, so it sets up only what the SMS sync needs.
@pragma('vm:entry-point')
Future<void> pushBackgroundHandler(RemoteMessage message) async {
  if (message.data['type'] != _smsSyncType) return;
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await Firebase.initializeApp();
  } catch (_) {
    // Not needed for the sync itself; carry on.
  }
  await _syncSms();
}

/// Lets a kid's refresh wake this phone to upload new SMS.
///
/// Everything here is optional: until google-services.json is added to the
/// build, Firebase cannot start, and the app simply runs without push.
class PushService {
  PushService._();
  static final PushService instance = PushService._();

  Future<bool>? _ready;
  bool _syncing = false;

  /// Called once at launch. Safe to call again; it only starts once.
  Future<bool> init() => _ready ??= _start();

  Future<bool> _start() async {
    if (!Platform.isAndroid) return false;
    try {
      await Firebase.initializeApp();
    } catch (_) {
      return false; // no Firebase config in this build
    }
    try {
      FirebaseMessaging.onBackgroundMessage(pushBackgroundHandler);
      FirebaseMessaging.onMessage.listen((message) {
        if (message.data['type'] == _smsSyncType) _syncInForeground();
      });
      FirebaseMessaging.instance.onTokenRefresh.listen((token) {
        _register(token).catchError((_) {});
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  /// A refresh can arrive while a sync is already running; one is enough.
  Future<void> _syncInForeground() async {
    if (_syncing) return;
    _syncing = true;
    try {
      await _syncSms();
    } finally {
      _syncing = false;
    }
  }

  /// Tells the server where to reach this phone. Called whenever the
  /// owner's home screen opens, which covers both app start and sign-in.
  Future<void> registerIfOwner() async {
    if (!await init()) return;
    try {
      final token = await FirebaseMessaging.instance.getToken();
      if (token != null) await _register(token);
    } catch (_) {
      // No Play Services, offline, or the server is down: try next launch.
    }
  }

  Future<void> _register(String token) async {
    if (!await _isOwner()) return;
    await ApiClient.instance.post('/family/devices', {'token': token});
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_registeredTokenKey, token);
  }

  /// Called before signing out, while the session still works, so a phone
  /// that is no longer signed in stops being woken.
  Future<void> unregister() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_registeredTokenKey);
    if (token == null) return;
    try {
      await ApiClient.instance.delete('/family/devices', {'token': token});
    } catch (_) {
      // The server forgets dead tokens on its own once a send to one fails.
    }
    await prefs.remove(_registeredTokenKey);
    try {
      if (await init()) await FirebaseMessaging.instance.deleteToken();
    } catch (_) {}
  }
}
