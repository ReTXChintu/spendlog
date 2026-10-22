import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/models.dart';
import '../screens/group_detail_screen.dart';
import 'api_client.dart';
import 'perk_import_watcher.dart' show appNavigatorKey;

/// Links into SpendLog, and out of it into Trippin.
///
/// In: a group opens from its web page (an App Link, verified against
/// https://spend-log.duckdns.org/.well-known/assetlinks.json), from
/// `spendlog://app/groups/ID` (what Trippin opens, which works whether or not
/// the App Link is verified), and from a notification carrying either.
///
/// Out: "Planned in Trippin" opens the trip in Trippin when it's installed
/// (`trippin://app/trip/ID`), else its web page.

/// The group a link points at, or null for a link SpendLog doesn't open.
///
/// ```text
/// spendlog://app/groups/ID · …/groups/ID · …/groups?group=ID · …/trips?trip=ID (older links)
/// ```
String? groupIdFromLink(Uri uri) {
  final segments = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  if (uri.scheme == 'spendlog') {
    if (uri.host != 'app' || segments.length < 2 || segments.first != 'groups') return null;
    return segments[1];
  }
  if (uri.scheme != 'https' && uri.scheme != 'http') return null;
  if (segments.isEmpty) return null;
  String? id;
  if (segments.first == 'groups') id = segments.length > 1 ? segments[1] : uri.queryParameters['group'];
  if (segments.first == 'trips' && segments.length == 1) id = uri.queryParameters['trip'] ?? uri.queryParameters['group'];
  return id == null || id.isEmpty ? null : id;
}

/// Trippin's own link for one of its trip pages (…/trips/ID), or null.
Uri? trippinAppLink(String url) {
  final uri = Uri.tryParse(url);
  if (uri == null || !(uri.scheme == 'https' || uri.scheme == 'http')) return null;
  final segments = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  if (segments.length < 2 || segments.first != 'trips' || segments[1] == 'new') return null;
  return Uri(scheme: 'trippin', host: 'app', pathSegments: ['trip', segments[1]]);
}

typedef UrlLauncher = Future<bool> Function(Uri uri, LaunchMode mode);

Future<bool> _launch(Uri uri, LaunchMode mode) => launchUrl(uri, mode: mode);

/// Opens a Trippin trip in Trippin when it's installed, else in the browser.
/// False when nothing could open it.
Future<bool> openSuiteUrl(String url, {UrlLauncher launcher = _launch}) async {
  final app = trippinAppLink(url);
  if (app != null) {
    try {
      if (await launcher(app, LaunchMode.externalNonBrowserApplication)) return true;
    } catch (_) {
      // Trippin isn't installed: the web page instead.
    }
  }
  final web = Uri.tryParse(url);
  if (web == null) return false;
  try {
    return await launcher(web, LaunchMode.externalApplication);
  } catch (_) {
    return false;
  }
}

/// Opens incoming links once someone who may see them is signed in.
class DeepLinks {
  DeepLinks._();
  static final DeepLinks instance = DeepLinks._();

  StreamSubscription<Uri>? _sub;
  String? _pendingGroup;

  /// Listens for links: the one that launched the app, and any while it runs.
  void start() {
    if (_sub != null) return;
    try {
      _sub = AppLinks().uriLinkStream.listen(open, onError: (_) {});
    } catch (_) {
      // No platform support (tests, desktop): nothing to listen to.
    }
  }

  /// Opens what [uri] points at, now or once signed in.
  Future<void> open(Uri uri) async {
    final group = groupIdFromLink(uri);
    if (group == null) return;
    _pendingGroup = group;
    await flush();
  }

  /// Opens a link kept from before sign-in. The home screen calls this once it's up.
  Future<void> flush() async {
    final group = _pendingGroup;
    if (group == null) return;
    // A kid's session never opens an owner's groups; signed out, it waits.
    if (await ApiClient.isKidSession() || await ApiClient.getToken() == null) return;
    final navigator = appNavigatorKey.currentState;
    if (navigator == null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => flush());
      return;
    }
    _pendingGroup = null;
    navigator.push(MaterialPageRoute(builder: (_) => GroupLinkScreen(groupId: group)));
  }
}

/// Loads a group by id, then shows it.
class GroupLinkScreen extends StatefulWidget {
  const GroupLinkScreen({super.key, required this.groupId});
  final String groupId;

  @override
  State<GroupLinkScreen> createState() => _GroupLinkScreenState();
}

class _GroupLinkScreenState extends State<GroupLinkScreen> {
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _failed = false);
    try {
      final data = await ApiClient.instance.get('/groups/${Uri.encodeComponent(widget.groupId)}');
      final detail = GroupDetail.fromJson(data as Map<String, dynamic>);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => GroupDetailScreen(group: detail.group)));
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Group')),
      body: Center(
        child: _failed
            ? Padding(
                padding: const EdgeInsets.all(24),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  const Text('This group couldn’t be opened. It may not be shared with you.', textAlign: TextAlign.center),
                  const SizedBox(height: 12),
                  FilledButton(onPressed: _load, child: const Text('Try again')),
                ]),
              )
            : const CircularProgressIndicator(),
      ),
    );
  }
}
