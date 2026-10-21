import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../widgets/state_block.dart';

/// Questions about your own money, answered by Gemini with your own key.
///
/// The conversation lives here and nowhere else: nothing is stored on the
/// server, and leaving the screen ends it. Each question sends the whole
/// conversation so far, because the model has no memory of its own - a
/// follow-up like "and last month?" only means something next to the
/// question before it.
class AskScreen extends StatefulWidget {
  /// Where to send somebody who has no key yet. The screen closes first.
  final VoidCallback? onOpenSettings;

  const AskScreen({super.key, this.onOpenSettings});

  @override
  State<AskScreen> createState() => _AskScreenState();
}

class _AskScreenState extends State<AskScreen> {
  /// How much of the conversation goes with each question. Enough for
  /// follow-ups to make sense; not so much that a long chat gets slow.
  static const _historyLimit = 20;

  /// The server turns away anything longer, so the field does too.
  static const _maxQuestion = 4000;

  static const _suggestions = [
    'How much did I spend on eating out this month?',
    "Give me insights on this month's spending",
    'What are my top 5 merchants this month?',
    'How am I doing against my budget?',
    'How much is left on my loans?',
  ];

  final _input = TextEditingController();
  final _scroll = ScrollController();

  AiSettings? _settings;
  bool _loadFailed = false;

  final List<AiMessage> _messages = [];
  bool _thinking = false;

  @override
  void initState() {
    super.initState();
    _loadSettings();
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadSettings() async {
    setState(() => _loadFailed = false);
    try {
      final json = await ApiClient.instance.get('/ai/settings') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() => _settings = AiSettings.fromJson(json));
    } catch (_) {
      if (mounted) setState(() => _loadFailed = true);
    }
  }

  void _openSettings() {
    Navigator.of(context).pop();
    widget.onOpenSettings?.call();
  }

  void _send([String? text]) {
    final question = (text ?? _input.text).trim();
    if (question.isEmpty || _thinking) return;

    setState(() => _messages.add(AiMessage(role: 'user', text: question)));
    _input.clear();
    _ask();
  }

  /// The conversation as the model should see it.
  ///
  /// A question whose answer failed goes too only if it is the one being
  /// asked now; left in otherwise, it would sit there unanswered and the
  /// model would try to answer it again alongside the next one.
  List<Map<String, dynamic>> _history() {
    final kept = <AiMessage>[];
    for (var i = 0; i < _messages.length; i++) {
      final message = _messages[i];
      if (message.failed) continue;
      final next = i + 1 < _messages.length ? _messages[i + 1] : null;
      if (message.isUser && next != null && next.failed) continue;
      kept.add(message);
    }

    var recent = kept.length > _historyLimit ? kept.sublist(kept.length - _historyLimit) : kept;
    // Opening on an answer, with its question trimmed away, reads to the
    // model as though it spoke first.
    while (recent.isNotEmpty && !recent.first.isUser) {
      recent = recent.sublist(1);
    }
    return recent.map((message) => message.toJson()).toList();
  }

  Future<void> _ask() async {
    setState(() => _thinking = true);
    _scrollToEnd();

    AiMessage reply;
    try {
      final json = await ApiClient.instance.post('/ai/ask', {'messages': _history()}) as Map<String, dynamic>;
      reply = AiMessage(
        role: 'model',
        text: (json['answer'] as String? ?? '').trim().isEmpty
            ? 'No answer came back. Try asking another way.'
            : (json['answer'] as String).trim(),
        lookups: (json['lookups'] as List<dynamic>? ?? []).map((l) => l.toString()).toList(),
      );
    } catch (error) {
      reply = AiMessage(
        role: 'model',
        failed: true,
        text: error is ApiException && error.statusCode != 401
            ? error.message
            : "Couldn't reach the server. Check the connection and try again.",
      );
      // A key removed from another device since this screen opened.
      if (error is ApiException && error.statusCode == 409) {
        _loadSettings();
      }
    }

    if (!mounted) return;
    setState(() {
      _messages.add(reply);
      _thinking = false;
    });
    _scrollToEnd();
  }

  /// Ask the last question again, after its answer failed.
  void _retry() {
    if (_thinking || _messages.isEmpty || !_messages.last.failed) return;
    setState(() => _messages.removeLast());
    _ask();
  }

  void _startOver() {
    if (_thinking) return;
    setState(() => _messages.clear());
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Ask AI'),
        shape: Border(bottom: BorderSide(color: c.ln)),
        actions: [
          if (_messages.isNotEmpty)
            IconButton(
              tooltip: 'Start over',
              onPressed: _thinking ? null : _startOver,
              icon: const DsIcon(DsIcons.refresh, size: 22),
            ),
          const SizedBox(width: 4),
        ],
      ),
      body: _body(context),
    );
  }

  Widget _body(BuildContext context) {
    if (_loadFailed) {
      return StateBlock(
        icon: Icons.wifi_off,
        title: "Couldn't reach the server",
        body: 'The assistant needs the server to look anything up.',
        actionLabel: 'Try again',
        onAction: _loadSettings,
      );
    }

    final settings = _settings;
    if (settings == null) return const Center(child: DsSpinner());

    if (!settings.hasKey) {
      return StateBlock(
        icon: DsIcons.lock,
        title: 'Add a Gemini key first',
        body: 'The assistant runs on Google Gemini with a key of your own. Get one free from Google '
            'AI Studio, then paste it under Settings → You → AI assistant.',
        actionLabel: widget.onOpenSettings != null ? 'Go to Settings' : null,
        onAction: _openSettings,
      );
    }

    return Column(
      children: [
        Expanded(child: _messages.isEmpty ? _intro(context) : _conversation(context)),
        _composer(context),
      ],
    );
  }

  /// What to ask, before anything has been.
  Widget _intro(BuildContext context) {
    final c = context.c;

    return ListView(
      padding: kPagePad,
      children: [
        DsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const DsIconTile(DsIcons.sparkles, tone: DsTone.ac),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      'Ask about your money',
                      style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Text(
                'Answers are worked out from your own transactions, budget and loans. Your question and '
                'the figures needed to answer it go to Google under your key; nothing here is saved once '
                'you leave this screen.',
                style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2),
              ),
            ],
          ),
        ),
        const SizedBox(height: 20),
        const DsLabel('Try one of these'),
        const SizedBox(height: 8),
        for (final suggestion in _suggestions)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: DsCard(
              onTap: () => _send(suggestion),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      suggestion,
                      style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
                    ),
                  ),
                  const SizedBox(width: 8),
                  DsIcon(DsIcons.arrowUpRight, size: 16, color: c.ac),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _conversation(BuildContext context) {
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
      itemCount: _messages.length + (_thinking ? 1 : 0),
      itemBuilder: (context, index) {
        if (index == _messages.length) return const _Thinking();

        final message = _messages[index];
        if (message.isUser) return _Question(text: message.text);

        final isLast = index == _messages.length - 1;
        return _Answer(
          message: message,
          onRetry: message.failed && isLast && !_thinking ? _retry : null,
        );
      },
    );
  }

  Widget _composer(BuildContext context) {
    final c = context.c;

    final canSend = !_thinking && _input.text.trim().isNotEmpty;

    return Container(
      decoration: BoxDecoration(
        color: c.sf,
        border: Border(top: BorderSide(color: c.ln)),
      ),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      child: SafeArea(
        top: false,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: TextField(
                controller: _input,
                minLines: 1,
                maxLines: 5,
                maxLength: _maxQuestion,
                textCapitalization: TextCapitalization.sentences,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _send(),
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                  hintText: 'Ask about your spending…',
                  counterText: '',
                  contentPadding: EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                ),
              ),
            ),
            const SizedBox(width: 8),
            IconButton.filled(
              tooltip: 'Send',
              onPressed: canSend ? () => _send() : null,
              style: IconButton.styleFrom(
                backgroundColor: c.ac,
                foregroundColor: c.acTx,
                disabledBackgroundColor: c.sunk,
                disabledForegroundColor: c.tx3,
                minimumSize: const Size(48, 48),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rLg)),
              ),
              icon: DsIcon(DsIcons.arrowUpRight, size: 20, color: canSend ? c.acTx : c.tx3),
            ),
          ],
        ),
      ),
    );
  }
}

/// A question, on the right like every chat anyone has used.
class _Question extends StatelessWidget {
  final String text;

  const _Question({required this.text});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Align(
        alignment: Alignment.centerRight,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * 0.82),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: c.acSoft,
              border: Border.all(color: c.acLine),
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(Ds.rXl),
                topRight: Radius.circular(Ds.rXl),
                bottomLeft: Radius.circular(Ds.rXl),
                bottomRight: Radius.circular(Ds.rSm),
              ),
            ),
            child: SelectableText(
              text,
              style: TextStyle(fontSize: 15, height: 22 / 15, color: c.tx, fontWeight: FontWeight.w500),
            ),
          ),
        ),
      ),
    );
  }
}

/// An answer, or the reason there isn't one. Full width: answers run to
/// lists and figures, and squeezing them into a bubble helps nobody.
class _Answer extends StatelessWidget {
  final AiMessage message;
  final VoidCallback? onRetry;

  const _Answer({required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final failed = message.failed;

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: failed
          ? DsAlertCard(
              title: 'No answer',
              body: message.text,
              action: onRetry == null
                  ? null
                  : OutlinedButton(
                      onPressed: onRetry,
                      style: OutlinedButton.styleFrom(minimumSize: const Size(64, 40)),
                      child: const Text('Try again'),
                    ),
            )
          : Container(
              width: double.infinity,
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: c.sf,
                border: Border.all(color: c.ln),
                borderRadius: BorderRadius.circular(Ds.rXl),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SelectionArea(child: SimpleMarkdown(text: message.text)),
                  if (message.lookups.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Padding(
                          padding: const EdgeInsets.only(top: 1),
                          child: DsIcon(DsIcons.sparkles, size: 14, color: c.tx3),
                        ),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            'Looked at: ${message.lookups.join(' · ')}',
                            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
    );
  }
}

class _Thinking extends StatelessWidget {
  const _Thinking();

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: c.sf,
          border: Border.all(color: c.ln),
          borderRadius: BorderRadius.circular(Ds.rXl),
        ),
        child: Row(
          children: [
            const DsSpinner(size: 20),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                'Thinking… looking through your figures can take up to half a minute.',
                style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Just enough Markdown for an answer: `**bold**`, and lines that start
/// with "- " or "* " as bullets. Headings lose their hashes and go bold.
/// Anything else is shown as the plain text it is.
///
/// Deliberately tiny rather than a package: the answers use little else,
/// and nothing a model writes can make this do more than style text.
class SimpleMarkdown extends StatelessWidget {
  final String text;

  const SimpleMarkdown({super.key, required this.text});

  static final _bullet = RegExp(r'^\s*[-*]\s+');
  static final _heading = RegExp(r'^\s*#{1,6}\s+');

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final base = TextStyle(fontSize: 15, height: 22 / 15, color: c.tx);
    final lines = text.replaceAll('\r\n', '\n').split('\n');

    final children = <Widget>[];
    for (final line in lines) {
      if (line.trim().isEmpty) {
        // A blank line between paragraphs, but never two in a row.
        if (children.isNotEmpty && children.last is! SizedBox) {
          children.add(const SizedBox(height: 8));
        }
        continue;
      }

      final bullet = _bullet.firstMatch(line);
      if (bullet != null) {
        children.add(
          Padding(
            padding: const EdgeInsets.only(bottom: 3),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(width: 16, child: Text('•', style: base.copyWith(color: c.tx3))),
                Expanded(
                  child: Text.rich(TextSpan(children: inlineSpans(line.substring(bullet.end), base))),
                ),
              ],
            ),
          ),
        );
        continue;
      }

      final heading = _heading.firstMatch(line);
      if (heading != null) {
        final style = base.copyWith(fontWeight: FontWeight.w600);
        children.add(Text.rich(TextSpan(children: inlineSpans(line.substring(heading.end), style))));
        continue;
      }

      children.add(Text.rich(TextSpan(children: inlineSpans(line, base))));
    }

    if (children.isNotEmpty && children.last is SizedBox) children.removeLast();

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: children);
  }

  /// `**bold**` spans within one line. An unmatched `**` is left showing,
  /// rather than turning the rest of the line bold.
  static List<TextSpan> inlineSpans(String line, TextStyle base) {
    final parts = line.split('**');
    if (parts.length.isEven) {
      final last = parts.removeLast();
      parts[parts.length - 1] = '${parts.last}**$last';
    }

    return [
      for (var i = 0; i < parts.length; i++)
        if (parts[i].isNotEmpty)
          TextSpan(
            text: parts[i],
            style: i.isOdd ? base.copyWith(fontWeight: FontWeight.w700) : base,
          ),
    ];
  }
}
