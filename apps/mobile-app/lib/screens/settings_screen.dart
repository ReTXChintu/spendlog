import 'dart:io' show Platform;
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../services/sms_service.dart';
import '../services/update_service.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../version.dart';
import 'login_screen.dart';
import 'permission_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  List<EmailConnectionStatus> _connections = [];
  bool _smsGranted = false;
  bool _syncing = false;

  /// null until a check has run; empty means "already up to date".
  String? _latestVersion;
  bool _checkingUpdate = false;

  bool _smsSyncing = false;
  DateTime? _smsLastSynced;

  @override
  void initState() {
    super.initState();
    _loadConnections();
    if (Platform.isAndroid) _refreshSmsStatus();
  }

  Future<void> _refreshSmsStatus() async {
    final granted = await SmsService.instance.hasPermission();
    final lastSynced = await SmsService.instance.lastSyncedAt();
    if (mounted) {
      setState(() {
        _smsGranted = granted;
        _smsLastSynced = lastSynced;
      });
    }
  }

  /// Re-reads recent messages by hand. The automatic capture can miss one —
  /// the phone was off, the app was killed mid-delivery, the request failed
  /// offline — and nothing else would ever go back for it.
  Future<void> _syncSms() async {
    setState(() => _smsSyncing = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await SmsService.instance.syncNow();
      await _refreshSmsStatus();
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            result.foundNothingNew
                ? 'Checked ${result.scanned} messages — nothing new.'
                : 'Imported ${result.created} '
                    '${result.created == 1 ? 'transaction' : 'transactions'} '
                    'from ${result.scanned} messages.',
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text("Couldn't sync messages: $e")));
    } finally {
      if (mounted) setState(() => _smsSyncing = false);
    }
  }

  bool get _updateAvailable => _latestVersion != null && _latestVersion!.isNotEmpty;

  Future<void> _checkForUpdate() async {
    setState(() => _checkingUpdate = true);
    // Asks for the deployed version rather than "is there an update", so an
    // unreachable server can be reported as such instead of as "up to date".
    final latest = await UpdateService.instance.latestVersion();
    if (!mounted) return;

    final newer = latest != null && UpdateService.isNewer(latest, appVersion);
    setState(() {
      // '' distinguishes "checked, nothing newer" from "not checked yet".
      _latestVersion = newer ? latest : '';
      _checkingUpdate = false;
    });

    if (newer) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          latest == null
              ? "Couldn't reach the server to check."
              : 'You are on the latest version.',
        ),
      ),
    );
  }

  Future<void> _loadConnections() async {
    try {
      final result = await ApiClient.instance.get('/ingestion/email/status') as List<dynamic>;
      if (!mounted) return;
      setState(() => _connections =
          result.map((c) => EmailConnectionStatus.fromJson(c as Map<String, dynamic>)).toList());
    } catch (_) {
      // Leave the card in its "not connected" state.
    }
  }

  Future<void> _connectGmail() async {
    final result = await ApiClient.instance.get('/ingestion/email/connect') as Map<String, dynamic>;
    await launchUrl(Uri.parse(result['url'] as String), mode: LaunchMode.externalApplication);
  }

  Future<void> _syncNow() async {
    setState(() => _syncing = true);
    try {
      await ApiClient.instance.post('/ingestion/email/sync');
      await _loadConnections();
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  Future<void> _requestSms() async {
    final granted = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => const PermissionScreen()),
    );
    if (granted == true) _refreshSmsStatus();
  }

  Future<void> _signOut() async {
    await AuthService.instance.signOut();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const LoginScreen()),
      (route) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final connection = _connections.isEmpty ? null : _connections.first;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
      children: [
        _SettingsCard(
          icon: Icons.mail_outline,
          title: 'Email import',
          subtitle: 'Gmail, read-only',
          child: connection == null
              ? _CardBody(
                  pill: const _StatusPill(label: 'Not connected', on: false),
                  text: 'Email access was declined when you signed in. You can grant it here instead.',
                  actions: [
                    FilledButton(onPressed: _connectGmail, child: const Text('Connect Gmail')),
                  ],
                )
              : _CardBody(
                  pill: const _StatusPill(label: 'Connected', on: true),
                  text: '${connection.email}\n${connection.lastSyncedAt != null ? 'Last synced ${connection.lastSyncedAt}' : 'Not synced yet.'}',
                  actions: [
                    OutlinedButton(
                      onPressed: _syncing ? null : _syncNow,
                      child: Text(_syncing ? 'Syncing…' : 'Sync now'),
                    ),
                  ],
                ),
        ),
        const SizedBox(height: 14),
        if (Platform.isAndroid)
          _SettingsCard(
            icon: Icons.sms_outlined,
            title: 'SMS import',
            subtitle: 'Android only',
            child: _smsGranted
                ? _CardBody(
                    pill: const _StatusPill(label: 'Granted', on: true),
                    text: 'Reading bank and UPI messages as they arrive.\n'
                        '${_smsLastSynced != null ? 'Last manual sync ${formatDateTime(_smsLastSynced!)}' : 'No manual sync yet.'}',
                    actions: [
                      OutlinedButton(
                        onPressed: _smsSyncing ? null : _syncSms,
                        child: Text(_smsSyncing ? 'Syncing…' : 'Sync now'),
                      ),
                    ],
                  )
                : _CardBody(
                    pill: const _StatusPill(label: 'Not granted', on: false),
                    text: 'Without this, SpendLog can only see what your bank emails — most Indian banks only '
                        'text. Turn it on any time.',
                    actions: [
                      FilledButton(onPressed: _requestSms, child: const Text('Grant SMS access')),
                    ],
                  ),
          )
        else
          const _SettingsCard(
            icon: Icons.sms_outlined,
            title: 'SMS import',
            subtitle: 'Android only',
            child: _CardBody(
              pill: _StatusPill(label: 'Not available here', on: false),
              text: 'Reading text messages is something only Android allows. On this device SpendLog can '
                  'still import from Gmail.',
            ),
          ),
        const SizedBox(height: 14),
        _SettingsCard(
          icon: Icons.lock_outline,
          title: 'Account',
          subtitle: 'Signed in with Google',
          child: _CardBody(
            text: "Signing out doesn't remove any imported transactions.",
            actions: [
              OutlinedButton(
                onPressed: _signOut,
                style: OutlinedButton.styleFrom(foregroundColor: context.c.debit),
                child: const Text('Sign out'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        _SettingsCard(
          icon: Icons.info_outline,
          title: 'Version',
          subtitle: 'SpendLog $appVersion (build $appBuildNumber)',
          child: _CardBody(
            pill: _updateAvailable ? const _StatusPill(label: 'Update available', on: false) : null,
            text: _updateAvailable
                ? 'Version $_latestVersion is out. Installing it over this one keeps your data.'
                : 'The app, the website and the server are released together and share this version '
                    'number, so what you are running always matches the server.',
            actions: [
              if (_updateAvailable)
                FilledButton(
                  onPressed: UpdateService.instance.openDownload,
                  child: const Text('Download update'),
                )
              else
                OutlinedButton(
                  onPressed: _checkingUpdate ? null : _checkForUpdate,
                  child: Text(_checkingUpdate ? 'Checking…' : 'Check for updates'),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _SettingsCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final Widget child;

  const _SettingsCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: context.c.surface,
        border: Border.all(color: context.c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(color: context.c.brand50, borderRadius: BorderRadius.circular(9)),
                child: Icon(icon, size: 17, color: context.c.brand),
              ),
              const SizedBox(width: 10),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: context.c.ink)),
                  Text(subtitle, style: TextStyle(fontSize: 12, color: context.c.muted)),
                ],
              ),
            ],
          ),
          child,
        ],
      ),
    );
  }
}

class _CardBody extends StatelessWidget {
  final Widget? pill;
  final String text;
  final List<Widget>? actions;

  const _CardBody({this.pill, required this.text, this.actions});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 12),
        if (pill != null) ...[pill!, const SizedBox(height: 8)],
        Text(text, style: TextStyle(fontSize: 13, height: 1.5, color: context.c.ink70)),
        if (actions != null) ...[
          const SizedBox(height: 14),
          Row(children: [for (final action in actions!) Padding(padding: const EdgeInsets.only(right: 8), child: action)]),
        ],
      ],
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String label;
  final bool on;

  const _StatusPill({required this.label, required this.on});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: on ? context.c.credit50 : context.c.chipNeutral,
        borderRadius: BorderRadius.circular(100),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (on) ...[
            Icon(Icons.check, size: 12, color: context.c.credit),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w700,
              color: on ? context.c.credit : context.c.muted,
            ),
          ),
        ],
      ),
    );
  }
}
