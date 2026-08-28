import 'dart:io' show Platform;
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../services/sms_service.dart';
import 'login_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  List<EmailConnectionStatus> _connections = [];
  bool _smsGranted = false;
  bool _syncing = false;

  @override
  void initState() {
    super.initState();
    _loadConnections();
    if (Platform.isAndroid) _checkSmsPermission();
  }

  Future<void> _checkSmsPermission() async {
    final granted = await SmsService.instance.requestPermissions();
    setState(() => _smsGranted = granted);
    if (granted) {
      SmsService.instance.startListening();
      SmsService.instance.runBackfillIfNeeded();
    }
  }

  Future<void> _loadConnections() async {
    final result = await ApiClient.instance.get('/ingestion/email/status') as List<dynamic>;
    setState(() => _connections = result.map((c) => EmailConnectionStatus.fromJson(c as Map<String, dynamic>)).toList());
  }

  Future<void> _connectGmail() async {
    final result = await ApiClient.instance.get('/ingestion/email/connect') as Map<String, dynamic>;
    final url = Uri.parse(result['url'] as String);
    await launchUrl(url, mode: LaunchMode.externalApplication);
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

  Future<void> _disconnect(String id) async {
    await ApiClient.instance.delete('/ingestion/email/$id');
    _loadConnections();
  }

  Future<void> _signOut() async {
    await AuthService.instance.signOut();
    if (mounted) {
      Navigator.of(context).pushAndRemoveUntil(MaterialPageRoute(builder: (_) => const LoginScreen()), (route) => false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (Platform.isAndroid) ...[
          const Text('SMS import', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('SMS permission'),
            subtitle: Text(_smsGranted ? 'Granted — auto-importing new SMS' : 'Not granted'),
            trailing: _smsGranted
                ? const Icon(Icons.check_circle, color: Colors.green)
                : ElevatedButton(onPressed: _checkSmsPermission, child: const Text('Grant')),
          ),
          const Divider(height: 32),
        ],
        const Text('Email import', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        if (_connections.isEmpty)
          ElevatedButton(onPressed: _connectGmail, child: const Text('Connect Gmail'))
        else ...[
          for (final connection in _connections)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(connection.email),
              subtitle: Text(
                connection.lastSyncedAt != null ? 'Last synced ${connection.lastSyncedAt}' : 'Not synced yet',
              ),
              trailing: IconButton(icon: const Icon(Icons.link_off), onPressed: () => _disconnect(connection.id)),
            ),
          ElevatedButton(
            onPressed: _syncing ? null : _syncNow,
            child: Text(_syncing ? 'Syncing…' : 'Sync now'),
          ),
        ],
        const Divider(height: 32),
        OutlinedButton(onPressed: _signOut, child: const Text('Sign out')),
      ],
    );
  }
}
