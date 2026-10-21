import 'package:flutter/material.dart';
import '../../services/api_client.dart';
import '../../services/kid_service.dart';
import '../../services/theme_service.dart';
import '../../widgets/ds/ds.dart';
import '../../version.dart';

/// All a kid can change: their password, light or dark, and signing out.
class KidSettingsScreen extends StatelessWidget {
  const KidSettingsScreen({super.key, required this.onSignedOut});

  final VoidCallback onSignedOut;

  Future<void> _signOut(BuildContext context) async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text('You can sign in again with your email and password.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Sign out')),
        ],
      ),
    );
    if (sure != true) return;
    await KidService.instance.signOut();
    onSignedOut();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    Widget card(List<Widget> children) => DsCard(
          padding: EdgeInsets.zero,
          clip: true,
          child: Column(children: children),
        );

    return ListView(
      padding: kPagePad,
      children: [
        card([
          ListTile(
            contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            leading: const DsIconTile(DsIcons.lock, tone: DsTone.ac),
            title: const Text('Change password'),
            trailing: DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3),
            onTap: () => showDialog<void>(context: context, builder: (_) => const KidPasswordDialog()),
          ),
        ]),
        const SizedBox(height: kCardGap),
        card([
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: DsSectionHeader('Theme'),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
            child: AnimatedBuilder(
              animation: ThemeService.instance,
              builder: (context, _) => DsSegmented<ThemeMode>(
                height: 40,
                segments: const [
                  (ThemeMode.light, 'Light'),
                  (ThemeMode.dark, 'Dark'),
                  (ThemeMode.system, 'Phone'),
                ],
                selected: ThemeService.instance.mode,
                onChanged: ThemeService.instance.set,
              ),
            ),
          ),
        ]),
        const SizedBox(height: kCardGap),
        card([
          ListTile(
            contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            leading: const DsIconTile(Icons.logout, tone: DsTone.crit),
            title: Text('Sign out', style: TextStyle(color: c.crit, fontWeight: FontWeight.w600)),
            onTap: () => _signOut(context),
          ),
        ]),
        const SizedBox(height: 20),
        Center(child: Text('SpendLog $appVersion', style: TextStyle(fontSize: 12, color: c.tx3))),
      ],
    );
  }
}

/// What is wrong with a new password, or null when it will do.
String? kidPasswordProblem({required String current, required String next, required String confirm}) {
  if (current.isEmpty) return 'Enter your current password.';
  if (next.length < 6) return 'A new password needs at least 6 characters.';
  if (next != confirm) return "The two new passwords don't match.";
  return null;
}

class KidPasswordDialog extends StatefulWidget {
  const KidPasswordDialog({super.key});

  @override
  State<KidPasswordDialog> createState() => _KidPasswordDialogState();
}

class _KidPasswordDialogState extends State<KidPasswordDialog> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _saving = false;
  String? _error;

  /// Which of the three fields are showing what was typed.
  final _shown = <int>{};

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final problem = kidPasswordProblem(current: _current.text, next: _next.text, confirm: _confirm.text);
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await KidService.instance.changePassword(_current.text, _next.text);
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      Navigator.of(context).pop();
      messenger.showSnackBar(
        const SnackBar(content: Text('Password changed. Any other phone signed in as you is now signed out.')),
      );
    } catch (e) {
      if (mounted) setState(() => _error = e is ApiException ? e.message : 'Check your internet and try again.');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    // Every password field gets the eye; revealed, it switches to Plex Mono.
    Widget field(int i, TextEditingController controller, String label) {
      final shown = _shown.contains(i);
      return TextField(
        controller: controller,
        obscureText: !shown,
        autocorrect: false,
        enableSuggestions: false,
        style: shown ? kMono.copyWith(fontSize: 15, color: c.tx) : null,
        decoration: InputDecoration(
          labelText: label,
          suffixIcon: DsEyeButton(
            obscured: !shown,
            onPressed: () => setState(() => shown ? _shown.remove(i) : _shown.add(i)),
          ),
        ),
      );
    }

    return AlertDialog(
      title: const Row(
        children: [
          DsIconTile(DsIcons.lock, tone: DsTone.ac),
          SizedBox(width: 12),
          Expanded(child: Text('Change password')),
        ],
      ),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            field(0, _current, 'Current password'),
            const SizedBox(height: 12),
            field(1, _next, 'New password'),
            const SizedBox(height: 12),
            field(2, _confirm, 'New password again'),
            if (_error != null) ...[
              const SizedBox(height: 12),
              DsCallout(tone: DsTone.crit, title: _error!),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: _saving ? null : () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _saving ? null : _save, child: const Text('Change')),
      ],
    );
  }
}
