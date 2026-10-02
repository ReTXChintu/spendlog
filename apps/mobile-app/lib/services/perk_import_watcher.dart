import 'dart:async';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../screens/perks_screen.dart';
import 'perk_reader.dart';
import 'reminder_service.dart';

/// The navigator a notification tap pushes onto. Lives here because the
/// coupons notification is the one that needs it.
final GlobalKey<NavigatorState> appNavigatorKey = GlobalKey<NavigatorState>();

/// Watches a screenshot import from anywhere in the app.
///
/// Reading is ~30 s a picture on the server, so nobody should have to sit
/// on the Perks screen for it. This keeps polling after that screen is
/// closed, and says "done" with a notification. If the app itself is closed
/// first, the WorkManager task in reminder_service.dart picks up the same
/// job id from SharedPreferences and says it instead - whichever removes
/// the id first is the one that notifies.
class PerkImportWatcher extends ChangeNotifier {
  PerkImportWatcher._();
  static final PerkImportWatcher instance = PerkImportWatcher._();

  static const Duration _every = Duration(seconds: 10);

  PerkImportJob? _job;
  Timer? _timer;
  bool _wired = false;

  /// The batch being read, or the one that just finished. Null once
  /// dismissed.
  PerkImportJob? get job => _job;

  /// On app start: route notification taps, and pick up a batch that was
  /// still going when the app was last closed.
  Future<void> resume() async {
    if (!_wired) {
      _wired = true;
      ReminderService.instance.onNotificationOpened = (payload) {
        if (payload != perksPayload) return;
        void open() =>
            appNavigatorKey.currentState?.push(MaterialPageRoute(builder: (_) => const PerksScreen()));
        // On a cold start there is no navigator until the first frame.
        if (appNavigatorKey.currentState != null) {
          open();
        } else {
          WidgetsBinding.instance.addPostFrameCallback((_) => open());
        }
      };
    }

    final prefs = await SharedPreferences.getInstance();
    final id = prefs.getString(perkImportWatchKey);
    if (id == null || _timer != null) return;
    try {
      _job = await PerkReader.instance.importById(id);
      notifyListeners();
      if (_job!.isRunning) {
        _start();
      } else {
        await _finished(_job!);
      }
    } catch (_) {
      // Signed out or offline; the background task still has the id.
    }
  }

  /// Start watching a batch the server has just accepted.
  Future<void> watch(PerkImportJob job) async {
    _job = job;
    notifyListeners();

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(perkImportWatchKey, job.id);
    // So a finish while the app is closed is still told about.
    await ReminderService.instance.ensureBackgroundTask().catchError((_) {});

    if (job.isRunning) {
      _start();
    } else {
      await _finished(job);
    }
  }

  /// Pick up the server's newest batch if it is still going and not
  /// already watched - say, one started on another phone.
  Future<void> adoptIfRunning(PerkImportJob job) async {
    if (_job?.id == job.id || !job.isRunning) return;
    await watch(job);
  }

  void dismiss() {
    if (_job?.isRunning ?? false) return;
    _job = null;
    notifyListeners();
  }

  void _start() {
    _timer?.cancel();
    _timer = Timer.periodic(_every, (_) => _tick());
  }

  Future<void> _tick() async {
    final current = _job;
    if (current == null) return _stop();
    try {
      final next = await PerkReader.instance.importById(current.id);
      _job = next;
      notifyListeners();
      if (!next.isRunning) await _finished(next);
    } catch (_) {
      // A missed poll is fine; the next one asks again.
    }
  }

  void _stop() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> _finished(PerkImportJob job) async {
    _stop();
    final prefs = await SharedPreferences.getInstance();
    await prefs.reload();
    // Already told about, by the background task or an earlier tick.
    if (prefs.getString(perkImportWatchKey) != job.id) return;
    await prefs.remove(perkImportWatchKey);
    await ReminderService.instance.showImportFinished(job).catchError((_) {});
  }
}
