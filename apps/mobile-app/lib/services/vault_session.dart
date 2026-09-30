import 'dart:async';
import 'package:flutter/widgets.dart';
import 'api_client.dart';

/// One account's stored details, in the clear.
class VaultDetails {
  final String accountId;

  /// A card number, or a bank account number.
  final String number;
  final String? expiry;

  /// The name on a card, or a bank account's holder.
  final String? nameOnCard;
  final String? ifsc;
  final String? note;
  final String? last4;

  const VaultDetails({
    required this.accountId,
    required this.number,
    this.expiry,
    this.nameOnCard,
    this.ifsc,
    this.note,
    this.last4,
  });

  factory VaultDetails.fromJson(Map<String, dynamic> json) => VaultDetails(
        accountId: json['accountId'] as String,
        number: json['number'] as String? ?? '',
        expiry: json['expiry'] as String?,
        nameOnCard: json['nameOnCard'] as String?,
        ifsc: json['ifsc'] as String?,
        note: json['note'] as String?,
        last4: json['last4'] as String?,
      );
}

/// The vault, unlocked once for every account at the same time.
///
/// One PIN already guarded every card, but asking for it again on each one
/// meant three prompts to read three numbers. The server hands everything
/// over for one PIN, and this holds it - the details and the PIN itself,
/// so a save or a delete does not ask again - in memory only, for a few
/// minutes. It then forgets both, and it forgets them sooner the moment
/// the app goes to the background: a phone set down with the vault open
/// should not stay open.
class VaultSession extends ChangeNotifier with WidgetsBindingObserver {
  VaultSession({
    this.ttl = const Duration(minutes: 5),
    DateTime Function()? clock,
    Future<List<dynamic>> Function(String pin)? revealAll,
    Future<Map<String, dynamic>> Function(String accountId, String pin)? revealOne,
  })  : _clock = clock ?? DateTime.now,
        _revealAll = revealAll ?? _fetchAll,
        _revealOne = revealOne ?? _fetchOne;

  static final VaultSession instance = VaultSession();

  final Duration ttl;
  final DateTime Function() _clock;
  final Future<List<dynamic>> Function(String pin) _revealAll;
  final Future<Map<String, dynamic>> Function(String accountId, String pin) _revealOne;

  Map<String, VaultDetails> _details = {};
  String? _pin;
  DateTime? _expiresAt;
  Timer? _ticker;
  bool _observing = false;

  static Future<List<dynamic>> _fetchAll(String pin) async =>
      await ApiClient.instance.post('/vault/reveal', {'pin': pin}) as List<dynamic>;

  static Future<Map<String, dynamic>> _fetchOne(String accountId, String pin) async =>
      await ApiClient.instance.post('/vault/cards/$accountId/reveal', {'pin': pin})
          as Map<String, dynamic>;

  bool get isUnlocked {
    final until = _expiresAt;
    if (_pin == null || until == null) return false;
    if (!_clock().isBefore(until)) {
      // Checked on read as well as by the ticker, so nothing can see the
      // details a moment after they should have gone.
      scheduleMicrotask(lock);
      return false;
    }
    return true;
  }

  /// The PIN typed to unlock, for a change that needs it again. Null
  /// whenever the session is locked.
  String? get pin => isUnlocked ? _pin : null;

  Duration get timeLeft {
    if (!isUnlocked) return Duration.zero;
    return _expiresAt!.difference(_clock());
  }

  /// "4 more minutes", rounded up, so it never says 0 while still open.
  int get minutesLeft => (timeLeft.inSeconds / 60).ceil();

  VaultDetails? detailsFor(String accountId) => isUnlocked ? _details[accountId] : null;

  /// Asks the server for everything behind [pin]. Throws the ApiException
  /// as it comes - a wrong PIN says how many tries are left, and a lockout
  /// says until when - and stays locked when it does.
  Future<void> unlock(String pin) async {
    final rows = await _revealAll(pin);
    _details = {
      for (final row in rows)
        if (row is Map<String, dynamic>) (row['accountId'] as String): VaultDetails.fromJson(row),
    };
    _pin = pin;
    _expiresAt = _clock().add(ttl);
    _startTicking();
    notifyListeners();
  }

  /// Fetches one account again after its details were saved, so what is
  /// shown is what the server now holds. Nothing happens while locked.
  Future<void> refresh(String accountId) async {
    final pin = this.pin;
    if (pin == null) return;
    try {
      _details[accountId] = VaultDetails.fromJson(await _revealOne(accountId, pin));
    } on ApiException catch (error) {
      if (error.statusCode == 404) {
        _details.remove(accountId);
      } else if (error.statusCode == 403 || error.statusCode == 429) {
        // The PIN held here no longer works - changed elsewhere, or
        // locked out. Keeping the session open on it would only fail again.
        lock();
        return;
      } else {
        rethrow;
      }
    }
    notifyListeners();
  }

  /// Drops one account's details, after they were deleted.
  void forget(String accountId) {
    if (_details.remove(accountId) != null) notifyListeners();
  }

  void lock() {
    final wasOpen = _pin != null;
    _details = {};
    _pin = null;
    _expiresAt = null;
    _ticker?.cancel();
    _ticker = null;
    if (wasOpen) notifyListeners();
  }

  void _startTicking() {
    if (!_observing) {
      WidgetsBinding.instance.addObserver(this);
      _observing = true;
    }
    _ticker?.cancel();
    // Often enough that "4 more minutes" is never a minute stale, and that
    // an expired session goes within seconds of its time.
    _ticker = Timer.periodic(const Duration(seconds: 10), (_) {
      if (isUnlocked) {
        notifyListeners();
      } else {
        lock();
      }
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) lock();
  }

  @override
  void dispose() {
    _ticker?.cancel();
    if (_observing) WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}
