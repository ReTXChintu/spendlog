import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';
import '../config.dart';
import '../version.dart';

/// Tells the user when the APK they're running is behind what's deployed.
///
/// The app is sideloaded from the web app rather than installed from a
/// store, so nothing updates it on its own — without this check someone
/// can stay on an old build indefinitely and never know why the server
/// behaves differently.
class UpdateService {
  UpdateService._();
  static final UpdateService instance = UpdateService._();

  /// The version the server is running, or null if it couldn't be reached.
  /// Deliberately unauthenticated: the check runs before sign-in too.
  Future<String?> latestVersion() async {
    try {
      final res = await http
          .get(Uri.parse('$apiBaseUrl/version'))
          .timeout(const Duration(seconds: 6));
      if (res.statusCode != 200) return null;
      return (jsonDecode(res.body) as Map<String, dynamic>)['version'] as String?;
    } catch (_) {
      // Offline, or an older server without the endpoint. Never a reason
      // to interrupt someone opening the app.
      return null;
    }
  }

  /// Whether [latest] is newer than the build we're running.
  ///
  /// Compares the numeric parts rather than the strings, so 0.10.0 counts
  /// as newer than 0.9.0.
  static bool isNewer(String latest, String current) {
    final a = _parts(latest);
    final b = _parts(current);
    for (var i = 0; i < 3; i++) {
      if (a[i] != b[i]) return a[i] > b[i];
    }
    return false;
  }

  static List<int> _parts(String version) {
    final numbers = version.split('+').first.split('.').map((p) => int.tryParse(p) ?? 0).toList();
    while (numbers.length < 3) {
      numbers.add(0);
    }
    return numbers;
  }

  /// The newer version if there is one, otherwise null.
  Future<String?> checkForUpdate() async {
    final latest = await latestVersion();
    if (latest == null) return null;
    return isNewer(latest, appVersion) ? latest : null;
  }

  /// Hands the APK to the browser, which is what installs it.
  Future<void> openDownload() =>
      launchUrl(Uri.parse(apkDownloadUrl), mode: LaunchMode.externalApplication);
}
