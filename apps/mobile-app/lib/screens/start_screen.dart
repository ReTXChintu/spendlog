import 'package:flutter/widgets.dart';
import '../services/api_client.dart';
import 'home_shell.dart';
import 'kid/kid_home_shell.dart';
import 'login_screen.dart';

/// Who this phone is signed in as.
enum AppRole { signedOut, owner, kid }

/// Read from storage at start-up, before anything owner-only runs.
Future<AppRole> currentRole() async {
  if (await ApiClient.isKidSession()) return AppRole.kid;
  return await ApiClient.getToken() != null ? AppRole.owner : AppRole.signedOut;
}

/// The first screen for a role. A kid never reaches HomeShell, which is
/// where the owner's SMS listener starts.
Widget startScreenFor(AppRole role) {
  switch (role) {
    case AppRole.kid:
      return const KidHomeShell();
    case AppRole.owner:
      return const HomeShell();
    case AppRole.signedOut:
      return const LoginScreen();
  }
}

/// Reminders, WorkManager, coupon-import polling and the like are the
/// owner's alone: a kid's phone must never schedule or ask for them.
bool runsOwnerStartup(AppRole role) => role != AppRole.kid;
