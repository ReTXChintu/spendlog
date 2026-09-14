import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';

/// Every statement the mailbox has offered, and what became of it.
///
/// The engine recorded a reason against each failure from the day it was
/// written, and nothing ever showed one — so "5 statements could not be
/// read" was the whole of what anybody knew. This is that list.
class StatementsScreen extends StatefulWidget {
  const StatementsScreen({super.key});

  @override
  State<StatementsScreen> createState() => _StatementsScreenState();
}

class _Statement {
  final String id;
  final String status;
  final String kind;
  final String? problem;
  final String? subject;
  final String? fileName;
  final String? issuer;
  final int lineCount;
  final int added;
  final int known;
  final int statementSpendMinor;
  final int knownSpendMinor;

  _Statement({
    required this.id,
    required this.status,
    this.kind = 'CARD',
    this.problem,
    this.subject,
    this.fileName,
    this.issuer,
    required this.lineCount,
    required this.added,
    required this.known,
    required this.statementSpendMinor,
    required this.knownSpendMinor,
  });

  bool get isRead => status == 'PARSED';
  bool get isBank => kind == 'BANK';

  String get label => switch (status) {
        'PARSED' => 'Read',
        'LOCKED' => 'Locked',
        'UNIDENTIFIED' => 'Unknown card',
        _ => 'Could not open',
      };

  factory _Statement.fromJson(Map<String, dynamic> json) {
    final counts = json['counts'] as Map<String, dynamic>? ?? {};
    return _Statement(
      id: json['id'] as String,
      status: json['status'] as String,
      kind: json['kind'] as String? ?? 'CARD',
      problem: json['problem'] as String?,
      subject: json['subject'] as String?,
      fileName: json['fileName'] as String?,
      issuer: json['issuer'] as String?,
      lineCount: json['lineCount'] as int? ?? 0,
      added: counts['added'] as int? ?? 0,
      known: (counts['matched'] as int? ?? 0) + (counts['uncertain'] as int? ?? 0),
      statementSpendMinor: json['statementSpendMinor'] as int? ?? 0,
      knownSpendMinor: json['knownSpendMinor'] as int? ?? 0,
    );
  }
}

class _StatementsScreenState extends State<StatementsScreen> {
  List<_Statement> _statements = [];
  List<Account> _cards = [];
  bool _loading = true;
  String? _busy;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/statements'),
        ApiClient.instance.get('/accounts'),
      ]);
      if (!mounted) return;
      setState(() {
        _statements = (results[0] as List<dynamic>)
            .map((s) => _Statement.fromJson(s as Map<String, dynamic>))
            .toList();
        _cards = (results[1] as List<dynamic>)
            .map((a) => Account.fromJson(a as Map<String, dynamic>))
            .where((account) => account.accountType == 'CARD')
            .toList();
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _act(String id, Future<void> Function() run) async {
    setState(() => _busy = id);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await run();
      await _load();
    } catch (error) {
      messenger.showSnackBar(
        SnackBar(content: Text(error is ApiException ? error.message : "That didn't work.")),
      );
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  /// The card number printed inside is not always the one an SMS taught
  /// SpendLog, so saying which card it is by hand fixes most of these.
  Future<void> _assign(_Statement statement) async {
    final chosen = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('Which card is this statement for?',
                  style: TextStyle(fontWeight: FontWeight.w700)),
            ),
            for (final card in _cards)
              ListTile(
                title: Text(card.label),
                onTap: () => Navigator.of(context).pop(card.id),
              ),
          ],
        ),
      ),
    );

    if (chosen == null) return;
    await _act(statement.id, () async {
      await ApiClient.instance.patch('/statements/${statement.id}', {'accountId': chosen});
    });
  }

  Future<void> _forget(_Statement statement) async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Forget this statement?'),
        content: const Text(
          'Anything it added to the ledger comes back out with it. Anything it only matched is '
          'left where it is.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Forget')),
        ],
      ),
    );

    if (sure != true) return;
    await _act(statement.id, () async {
      await ApiClient.instance.delete('/statements/${statement.id}');
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: const Text('Statements'),
        shape: Border(bottom: BorderSide(color: c.line)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _statements.isEmpty
              ? const StateBlock(
                  icon: Icons.receipt_long_outlined,
                  title: 'No statements yet',
                  body: 'Read them from Settings, under Connections. They come from the same mailbox '
                      'as the transaction alerts.',
                )
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
                    itemCount: _statements.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 10),
                    itemBuilder: (context, index) => _row(_statements[index]),
                  ),
                ),
    );
  }

  Widget _row(_Statement statement) {
    final c = context.c;
    final (pillBg, pillFg) = switch (statement.status) {
      'PARSED' => (c.credit50, c.credit),
      'LOCKED' => (c.warnBg, c.warn),
      'UNIDENTIFIED' => (c.brand50, c.brandDark),
      _ => (c.debit50, c.debit),
    };

    return Container(
      padding: const EdgeInsets.all(13),
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
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(color: pillBg, borderRadius: BorderRadius.circular(100)),
                child: Text(
                  statement.label.toUpperCase(),
                  style: TextStyle(
                    fontSize: 8.5,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.4,
                    color: pillFg,
                  ),
                ),
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Text(
                  '${statement.subject ?? statement.fileName ?? 'A statement'}'
                  '${statement.isBank ? '  (bank)' : ''}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13.3, fontWeight: FontWeight.w600, color: c.ink),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            statement.isRead
                ? '${statement.issuer} · ${statement.lineCount} lines · ${statement.added} added, '
                    '${statement.known} already known'
                    '${statement.statementSpendMinor > 0 ? '\n'
                        'Statement says ${formatMoneyShort(statement.statementSpendMinor)}, '
                        'SpendLog had ${formatMoneyShort(statement.knownSpendMinor)}.' : ''}'
                : (statement.problem ?? 'No reason was recorded.'),
            style: TextStyle(fontSize: 12.3, height: 1.45, color: c.muted),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              if (statement.status == 'UNIDENTIFIED' && _cards.isNotEmpty)
                OutlinedButton(
                  onPressed: _busy == statement.id ? null : () => _assign(statement),
                  child: const Text('Pick the card'),
                ),
              if (!statement.isRead) ...[
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: _busy == statement.id
                      ? null
                      : () => _act(statement.id, () async {
                            await ApiClient.instance.post('/statements/${statement.id}/reread');
                          }),
                  child: const Text('Read again'),
                ),
              ],
              if (statement.isRead && statement.added > 0)
                TextButton(
                  onPressed: _busy == statement.id
                      ? null
                      : () => _act(statement.id, () async {
                            await ApiClient.instance.delete('/statements/${statement.id}/added');
                          }),
                  child: Text('Undo ${statement.added}'),
                ),
              const Spacer(),
              // Forgetting one takes back what it added on the way out, or
              // the ledger keeps rows pointing at something that no longer
              // exists.
              IconButton(
                icon: const Icon(Icons.delete_outline, size: 19),
                color: c.debit,
                tooltip: 'Forget this statement',
                onPressed: _busy == statement.id ? null : () => _forget(statement),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
