import 'package:package_info_plus/package_info_plus.dart';

/// When this copy of the app was installed, and when it was last updated.
///
/// Android Auto Backup restores SharedPreferences onto a fresh install, so
/// what is found there may have been written by another install entirely -
/// an older phone, or this one before an uninstall. A fresh install has
/// both times the same; an update in place keeps the first and moves the
/// second. That is the only way to tell "this install wrote it" from "a
/// backup put it here".
class InstallInfo {
  const InstallInfo({this.installedAt, this.updatedAt});

  /// Android's firstInstallTime. Kept across updates, new on every install.
  final DateTime? installedAt;

  /// Android's lastUpdateTime.
  final DateTime? updatedAt;

  /// Whether an older build of this same install ran before this one. False
  /// when it cannot be told, which is the safe answer: anything carried over
  /// on the strength of it is dropped instead.
  ///
  /// A fresh install records both times together, so any real gap means an
  /// update. The minute of slack is only for clocks read a moment apart.
  bool get updatedInPlace {
    final installed = installedAt;
    final updated = updatedAt;
    if (installed == null || updated == null) return false;
    return updated.difference(installed) > const Duration(minutes: 1);
  }

  /// Names this install, for a SharedPreferences flag that must not count
  /// on another one after a restore. Null when it cannot be told.
  String? get stamp => installedAt?.millisecondsSinceEpoch.toString();

  /// Swapped in tests.
  static Future<InstallInfo> Function() load = _fromPlatform;

  static Future<InstallInfo> _fromPlatform() async {
    try {
      final info = await PackageInfo.fromPlatform();
      return InstallInfo(installedAt: info.installTime, updatedAt: info.updateTime);
    } catch (_) {
      return const InstallInfo();
    }
  }
}
