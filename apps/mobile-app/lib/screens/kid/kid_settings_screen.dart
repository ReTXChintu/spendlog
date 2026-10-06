import 'package:flutter/material.dart';
import '../../services/api_client.dart';
import '../../services/kid_service.dart';
import '../../services/theme_service.dart';
import '../../theme.dart';
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

    Widget card(List<Widget> children) => Container(
          decoration: BoxDecoration(
            color: c.surface,
            borderRadius: BorderRadius.circular(T.rMd),
            border: Border.all(color: c.line),
          ),
          child: Column(children: children),
        );

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
      children: [
        card([
          ListTile(
            leading: Icon(Icons.lock_outline, color: c.brand),
            title: const Text('Change password'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => showDialog<void>(context: context, builder: (_) => const KidPasswordDialog()),
          ),
        ]),
        const SizedBox(height: 12),
        card([
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('Theme', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: c.ink)),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
            child: AnimatedBuilder(
              animation: ThemeService.instance,
              builder: (context, _) => SizedBox(
                width: double.infinity,
                child: SegmentedButton<ThemeMode>(
                  segments: const [
                    ButtonSegment(value: ThemeMode.light, label: Text('Light'), icon: Icon(Icons.light_mode_outlined)),
                    ButtonSegment(value: ThemeMode.dark, label: Text('Dark'), icon: Icon(Icons.dark_mode_outlined)),
                    ButtonSegment(
                      value: ThemeMode.system,
                      label: Text('Phone'),
                      icon: Icon(Icons.brightness_auto_outlined),
                    ),
                  ],
                  selected: {ThemeService.instance.mode},
                  onSelectionChanged: (value) => ThemeService.instance.set(value.first),
                ),
              ),
            ),
          ),
        ]),
        const SizedBox(height: 12),
        card([
          ListTile(
            leading: Icon(Icons.logout, color: c.debit),
            title: Text('Sign out', style: TextStyle(color: c.debit, fontWeight: FontWeight.w600)),
            onTap: () => _signOut(context),
          ),
        ]),
        const SizedBox(height: 18),
        Center(child: Text('SpendLog $appVersion', style: TextStyle(fontSize: 11.5, color: c.mutedLight))),
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

    InputDecoration field(String label) => InputDecoration(labelText: label, border: const OutlineInputBorder());

    return AlertDialog(
      title: const Text('Change password'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: _current, obscureText: true, decoration: field('Current password')),
            const SizedBox(height: 10),
            TextField(controller: _next, obscureText: true, decoration: field('New password')),
            const SizedBox(height: 10),
            TextField(controller: _confirm, obscureText: true, decoration: field('New password again')),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: TextStyle(fontSize: 12.5, color: c.debit)),
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
