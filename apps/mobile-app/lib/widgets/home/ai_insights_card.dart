import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../../screens/ask_screen.dart' show SimpleMarkdown;
import '../../services/api_client.dart';
import '../../theme.dart';
import '../../utils/format.dart';

/// When an AI answer was written, said the way a person would.
String madeWhen(DateTime? at) {
  if (at == null) return '';
  final day = istWallClock(at).toIso8601String().substring(0, 10);
  return day == istToday() ? 'today, ${formatTime(at)}' : '${formatShortDate(at)}, ${formatTime(at)}';
}

/// The frame shared by the two AI cards on Analytics.
class AiCardFrame extends StatelessWidget {
  const AiCardFrame({super.key, required this.title, required this.icon, required this.child, this.trailing});

  final String title;
  final IconData icon;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 17, color: c.brand),
              const SizedBox(width: 8),
              Expanded(
                child: Text(title, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800, color: c.ink)),
              ),
              if (trailing != null) trailing!,
            ],
          ),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }
}

/// What to show when there is no Gemini key: one line and the way to fix it.
class AiNeedsKey extends StatelessWidget {
  const AiNeedsKey({super.key, required this.what, this.onOpenSettings});

  final String what;
  final VoidCallback? onOpenSettings;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Add your Gemini key in Settings and SpendLog can $what.',
          style: TextStyle(fontSize: 12.8, height: 1.45, color: c.muted),
        ),
        if (onOpenSettings != null) ...[
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: onOpenSettings,
            icon: const Icon(Icons.key_outlined, size: 16),
            label: const Text('Open Settings'),
          ),
        ],
      ],
    );
  }
}

/// A calm wait inside one card, so the rest of the screen stays usable.
class AiWaiting extends StatelessWidget {
  const AiWaiting({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: c.brand)),
          const SizedBox(width: 12),
          Expanded(
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 300),
              child: Text(
                text,
                key: ValueKey(text),
                style: TextStyle(fontSize: 12.8, height: 1.45, color: c.muted),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The day's AI read of the spending.
///
/// The server writes at most one a day by itself; the first open of the day
/// waits for it (up to half a minute), so the wait is shown here and only
/// here.
class AiInsightsCard extends StatefulWidget {
  const AiInsightsCard({super.key, this.onOpenSettings});

  final VoidCallback? onOpenSettings;

  @override
  State<AiInsightsCard> createState() => _AiInsightsCardState();
}

class _AiInsightsCardState extends State<AiInsightsCard> {
  AiInsight? _insight;
  bool _loading = true;
  bool _refreshing = false;
  bool _noKey = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool fresh = false}) async {
    setState(() {
      if (fresh) {
        _refreshing = true;
      } else {
        _loading = true;
      }
      _error = null;
    });
    try {
      final json = (fresh
          ? await ApiClient.instance.post('/ai/insights/refresh')
          : await ApiClient.instance.get('/ai/insights')) as Map<String, dynamic>;
      if (!mounted) return;
      final insight = json['insight'];
      setState(() {
        _noKey = json['hasKey'] == false;
        _insight = insight is Map<String, dynamic> ? AiInsight.fromJson(insight) : null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        if (error is ApiException && error.statusCode == 409) {
          _noKey = true;
        } else {
          _error = error is ApiException ? error.message : "Couldn't reach the server just now.";
        }
      });
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
          _refreshing = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final insight = _insight;

    Widget body;
    if (_loading) {
      body = const AiWaiting(
        text: "Reading this month's spending. The first look of the day takes about 20 seconds.",
      );
    } else if (_noKey && insight == null) {
      body = AiNeedsKey(what: 'write a short read of your spending each day', onOpenSettings: widget.onOpenSettings);
    } else if (_error != null && insight == null) {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(_error!, style: TextStyle(fontSize: 12.8, color: c.muted)),
          TextButton(onPressed: _load, child: const Text('Try again')),
        ],
      );
    } else if (insight == null) {
      body = Text(
        'Nothing written yet. Ask for one below.',
        style: TextStyle(fontSize: 12.8, color: c.muted),
      );
    } else {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SimpleMarkdown(text: insight.text),
          const SizedBox(height: 8),
          Text(
            ['Made ${madeWhen(insight.updatedAt)}', if (insight.model != null) insight.model!].join(' · '),
            style: TextStyle(fontSize: 11, color: c.mutedLight),
          ),
          if (_error != null)
            Text(_error!, style: TextStyle(fontSize: 11.5, color: c.debit)),
        ],
      );
    }

    return AiCardFrame(
      title: 'AI insights',
      icon: Icons.auto_awesome_outlined,
      trailing: _loading || (_noKey && insight == null)
          ? null
          : TextButton.icon(
              onPressed: _refreshing ? null : () => _load(fresh: true),
              icon: _refreshing
                  ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.refresh, size: 16),
              label: Text(_refreshing ? 'Writing…' : 'New insight'),
            ),
      child: _refreshing
          ? const AiWaiting(text: 'Writing a fresh read of your spending. This takes about 20 seconds.')
          : body,
    );
  }
}
