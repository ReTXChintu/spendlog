import 'dart:async';
import 'dart:io' show Platform;
import 'dart:ui' show DartPluginRegistrant;
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import '../screens/groups_screen.dart';
import '../screens/passbook_screen.dart';
import '../screens/subscription_detail_screen.dart';
import '../screens/subscriptions_screen.dart';
import '../screens/transactions_screen.dart';
import 'api_client.dart';
import 'credential_store.dart';
import 'deep_links.dart' show GroupLinkScreen;
import 'perk_import_watcher.dart' show appNavigatorKey;
import 'sms_service.dart';

/// The FCM token this phone last gave the server, so sign-out can remove
/// the same one even if Firebase has since handed out a new one. Kept in
/// secure storage: it belongs to this install, and a restored copy would
/// make sign-out on a new phone unregister the old one.
const String _registeredTokenKey = CredentialStore.pushTokenKey;

/// A data-only push: a kid pulled to refresh, so read any new bank SMS on
/// this (the owner's) phone and upload them.
const String _smsSyncType = 'SMS_SYNC';

/// A visible push: the nightly check found an account off from the bank.
/// Tapping it opens that account's passbook.
const String _balanceDriftType = 'BALANCE_DRIFT';

/// A visible push about a subscription: a renewal coming up, a trial
/// ending, a renewal that never came. Tapping it opens that subscription.
const String _subscriptionType = 'SUBSCRIPTION';

/// A visible push the morning after pay day: the month that just closed.
/// Tapping it opens the ledger on that month.
const String _digestType = 'MONTHLY_DIGEST';

/// A group: someone joined it, Trippin put me in it, or a payment there
/// includes my share. Opens the group (or the list, for several).
const String _groupType = 'GROUP';

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
  // The session is read from secure storage, a plugin; this makes sure
  // every plugin's Dart side is registered in this isolate too.
  DartPluginRegistrant.ensureInitialized();
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
      // A tap on a notification: one that woke the app from nothing, and
      // any later one while it is in the background.
      FirebaseMessaging.instance.getInitialMessage().then((message) {
        if (message != null) _openFromTap(message);
      }).catchError((_) {});
      FirebaseMessaging.onMessageOpenedApp.listen(_openFromTap);
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Routes a tapped notification. Only the owner's phone gets these, and
  /// a kid's session must never be sent to an owner's screens, so the
  /// role is checked here as well as at registration.
  Future<void> _openFromTap(RemoteMessage message) async {
    final screen = screenFor(message.data);
    if (screen == null) return;
    if (!await _isOwner()) return;

    void open() => appNavigatorKey.currentState?.push(MaterialPageRoute(builder: (_) => screen));
    // On a cold start there is no navigator until the first frame.
    if (appNavigatorKey.currentState != null) {
      open();
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) => open());
    }
  }

  /// The screen a notification's data opens, or null for one that opens
  /// nothing. Kept apart from the navigator so it can be checked directly.
  static Widget? screenFor(Map<String, dynamic> data) {
    switch (data['type']) {
      case _balanceDriftType:
        final accountId = data['accountId'];
        if (accountId is! String || accountId.isEmpty) return null;
        final alertId = data['alertId'];
        return PassbookScreen(accountId: accountId, alertId: alertId is String && alertId.isNotEmpty ? alertId : null);
      case _subscriptionType:
        final id = data['subscriptionId'];
        return id is String && id.isNotEmpty ? SubscriptionDetailScreen(id: id) : const SubscriptionsScreen();
      case _groupType:
        final groupId = data['groupId'];
        return groupId is String && groupId.isNotEmpty ? GroupLinkScreen(groupId: groupId) : const GroupsScreen();
      case _digestType:
        final monthKey = data['monthKey'];
        if (monthKey is! String || monthKey.isEmpty) return null;
        return TransactionsScreen(initialMonthKey: monthKey);
      default:
        return null;
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
    await CredentialStore.instance.write(_registeredTokenKey, token);
  }

  /// Called before signing out, while the session still works, so a phone
  /// that is no longer signed in stops being woken.
  Future<void> unregister() async {
    final store = CredentialStore.instance;
    final token = await store.read(_registeredTokenKey);
    if (token == null) return;
    try {
      await ApiClient.instance.delete('/family/devices', {'token': token});
    } catch (_) {
      // The server forgets dead tokens on its own once a send to one fails.
    }
    await store.delete(_registeredTokenKey);
    try {
      if (await init()) await FirebaseMessaging.instance.deleteToken();
    } catch (_) {}
  }
}
