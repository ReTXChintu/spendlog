import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';
import 'statement_detail_screen.dart';

/// Every statement the mailbox has offered, and what became of it.
///
/// The engine recorded a reason against each failure from the day it was
/// written, and nothing ever showed one — so "5 statements could not be
/// read" was the whole of what anybody knew. This is that list.
class StatementsScreen extends StatefulWidget {
  const StatementsScreen({super.key, this.onlyAccountId, this.title});

  /// Which account's statements to show. Null shows every account's, which
  /// is how the pile with no account is reached.
  final String? onlyAccountId;

  /// What to call the screen when it is about one account.
  final String? title;

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
  /// The statement's own date, or the day its mail arrived for one that
  /// could not be read far enough to have a date of its own.
  final DateTime? dated;
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
    this.dated,
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
      dated: DateTime.tryParse(
        (json['statementDate'] ?? json['receivedAt']) as String? ?? '',
      ),
      lineCount: json['lineCount'] as int? ?? 0,
      added: counts['added'] as int? ?? 0,
      known: (counts['matched'] as int? ?? 0) + (counts['uncertain'] as int? ?? 0),
      statementSpendMinor: json['statementSpendMinor'] as int? ?? 0,
      knownSpendMinor: json['knownSpendMinor'] as int? ?? 0,
    );
  }
}

/// The line under a statement's name: what date it is filed under, then
/// either what was read off it or why nothing could be.
String _subtitle(_Statement statement) {
  final parts = <String>[];

  // Dated first, because that is the order the list is in.
  if (statement.dated != null) parts.add(DateFormat('d MMM yyyy').format(statement.dated!));

  if (!statement.isRead) {
    parts.add(statement.problem ?? 'No reason was recorded.');
    return parts.join(' · ');
  }

  parts.add('${statement.issuer}');
  parts.add('${statement.lineCount} lines');
  parts.add('${statement.added} added, ${statement.known} already known');

  final head = parts.join(' · ');
  if (statement.statementSpendMinor <= 0) return head;

  return '$head\nStatement says ${formatMoneyShort(statement.statementSpendMinor)}, '
      'SpendLog had ${formatMoneyShort(statement.knownSpendMinor)}.';
}

/// One month's worth of one card's statements.
class _MonthGroup {
  final String month;
  final List<_Statement> statements;

  _MonthGroup({required this.month, required this.statements});

  factory _MonthGroup.fromJson(Map<String, dynamic> json) => _MonthGroup(
        month: json['month'] as String? ?? '',
        statements: ((json['statements'] as List?) ?? const [])
            .map((s) => _Statement.fromJson(s as Map<String, dynamic>))
            .toList(),
      );

  /// "September 2026", from a YYYY-MM key.
  String get label {
    final parts = month.split('-');
    if (parts.length != 2) return month;

    final year = int.tryParse(parts[0]);
    final index = int.tryParse(parts[1]);
    if (year == null || index == null) return month;

    return DateFormat('MMMM yyyy').format(DateTime(year, index));
  }
}

/// One card, and every statement filed under it.
class _AccountGroup {
  final String accountId;
  final String name;
  final String last4;
  final String? network;
  final List<_MonthGroup> months;

  _AccountGroup({
    required this.accountId,
    required this.name,
    required this.last4,
    this.network,
    required this.months,
  });

  factory _AccountGroup.fromJson(Map<String, dynamic> json) => _AccountGroup(
        accountId: json['accountId'] as String? ?? '',
        name: json['name'] as String? ?? 'A card',
        last4: json['last4'] as String? ?? '',
        network: json['network'] as String?,
        months: ((json['months'] as List?) ?? const [])
            .map((m) => _MonthGroup.fromJson(m as Map<String, dynamic>))
            .toList(),
      );

  Iterable<_Statement> get all => months.expand((month) => month.statements);
  int get count => all.length;
  int get stuck => all.where((statement) => !statement.isRead).length;
}

class _StatementsScreenState extends State<StatementsScreen> {
  List<_AccountGroup> _groups = [];
  List<Account> _cards = [];
  bool _loading = true;
  String? _busy;

  /// The groups this screen is about: one account's, or all of them.
  List<_AccountGroup> get _shown => widget.onlyAccountId == null
      ? _groups
      : _groups.where((group) => group.accountId == widget.onlyAccountId).toList();

  int _duplicates = 0;
  int _totalStatements = 0;
  int _addedRows = 0;
  int _categorisedRows = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/statements/filed'),
        ApiClient.instance.get('/accounts'),
        ApiClient.instance.get('/statements/reset'),
      ]);
      if (!mounted) return;
      setState(() {
        _groups = (results[0] as List<dynamic>)
            .map((g) => _AccountGroup.fromJson(g as Map<String, dynamic>))
            .toList();
        _cards = (results[1] as List<dynamic>)
            .map((a) => Account.fromJson(a as Map<String, dynamic>))
            .where((account) =>
                account.accountType == 'CARD' || account.accountType == 'BANK')
            .toList();

        final plan = results[2] as Map<String, dynamic>;
        _duplicates = plan['duplicateGroups'] as int? ?? 0;
        _totalStatements = plan['statements'] as int? ?? 0;
        _addedRows = plan['addedTransactions'] as int? ?? 0;
        _categorisedRows = plan['categorisedAmongThem'] as int? ?? 0;

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
  /// SpendLog, so saying which account it is by hand fixes most of these.
  ///
  /// The kind a statement of this kind usually belongs to is listed first,
  /// and the rest are still listed: occasionally the statement is wrong
  /// about which it is.
  Future<void> _assign(_Statement statement) async {
    final wanted = statement.isBank ? 'BANK' : 'CARD';
    final ordered = [
      ..._cards.where((account) => account.accountType == wanted),
      ..._cards.where((account) => account.accountType != wanted),
    ];

    final chosen = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Text(
                statement.isBank
                    ? 'Which account is this statement for?'
                    : 'Which card is this statement for?',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
            for (final account in ordered)
              ListTile(
                title: Text(account.label),
                subtitle: Text(account.accountType == 'BANK' ? 'Bank account' : 'Credit card'),
                onTap: () => Navigator.of(context).pop(account.id),
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
        title: Text(widget.title ?? 'Statements'),
        shape: Border(bottom: BorderSide(color: c.line)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _shown.isEmpty
              ? const StateBlock(
                  icon: Icons.receipt_long_outlined,
                  title: 'No statements yet',
                  body: 'Read them from Settings, under Connections. They come from the same mailbox '
                      'as the transaction alerts.',
                )
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
                    children: [
                      if (_duplicates > 0) ...[_resetCard(), const SizedBox(height: 14)],
                      for (final group in _shown) ...[
                        _accountTile(group),
                        const SizedBox(height: 10),
                      ],
                    ],
                  ),
                ),
    );
  }

  /// Statements that were read more than once, and the offer to start over.
  ///
  /// Shown only while there is a mess. For a while every sync read every
  /// statement again - a statement was identified by Gmail's attachment id
  /// and Gmail mints one of those per fetch - so each run added every
  /// transaction on every statement afresh.
  ///
  /// The counts come first and the button second. This deletes several
  /// hundred rows, and that is not a thing to discover afterwards.
  Widget _resetCard() {
    final c = context.c;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.warn),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.error_outline, size: 17, color: c.warn),
              const SizedBox(width: 9),
              const Expanded(
                child: Text(
                  'Statements were read more than once',
                  style: TextStyle(fontSize: 13.3, fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '$_duplicates of $_totalStatements are copies. They put $_addedRows transactions in '
            'the ledger, $_categorisedRows of which you have categorised by hand. Nothing read from '
            'an SMS or an email is touched.',
            style: TextStyle(fontSize: 12, height: 1.45, color: c.muted),
          ),
          const SizedBox(height: 10),
          OutlinedButton(
            onPressed: _busy == 'reset' ? null : _confirmReset,
            style: OutlinedButton.styleFrom(foregroundColor: c.debit),
            child: Text(_busy == 'reset' ? 'Removing…' : 'Start over'),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmReset() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Start over?'),
        content: Text(
          'This removes every statement and the $_addedRows transactions they added, including '
          '$_categorisedRows you have categorised. Rows from SMS and email stay. '
          'Read the statements again afterwards, under Settings.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    if (sure != true) return;

    await _act('reset', () async {
      await ApiClient.instance.post('/statements/reset', {'confirm': 'start over'});
    });
  }

  /// One card, its months inside it.
  ///
  /// A card with something wrong on it starts open, because that is the
  /// only reason anybody comes to this screen unprompted.
  Widget _accountTile(_AccountGroup group) {
    final c = context.c;

    return Container(
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      clipBehavior: Clip.antiAlias,
      child: Theme(
        // A divider above an expanded card would read as a second card.
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          initiallyExpanded: group.stuck > 0,
          tilePadding: const EdgeInsets.symmetric(horizontal: 13),
          childrenPadding: const EdgeInsets.fromLTRB(13, 0, 13, 12),
          expandedCrossAxisAlignment: CrossAxisAlignment.start,
          title: Row(
            children: [
              Expanded(
                child: Text(
                  group.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
                ),
              ),
              if (group.last4.isNotEmpty)
                Text('•••• ${group.last4}', style: kNum.copyWith(fontSize: 11.5, color: c.muted)),
            ],
          ),
          subtitle: Text(
            [
              '${group.count} statement${group.count == 1 ? '' : 's'}',
              if (group.stuck > 0) '${group.stuck} need attention',
              if (group.network != null) group.network!,
            ].join(' · '),
            style: TextStyle(
              fontSize: 11.5,
              color: group.stuck > 0 ? c.warn : c.muted,
              fontWeight: group.stuck > 0 ? FontWeight.w700 : FontWeight.w400,
            ),
          ),
          children: [
            for (final month in group.months) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(0, 10, 0, 7),
                child: Text(
                  month.label.toUpperCase(),
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.5,
                    color: c.muted,
                  ),
                ),
              ),
              for (final statement in month.statements)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: _row(statement),
                ),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _open(_Statement statement) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => StatementDetailScreen(
          statementId: statement.id,
          title: statement.subject ?? statement.fileName ?? 'Statement',
        ),
      ),
    );
    await _load();
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
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: c.paper,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rSm),
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
            _subtitle(statement),
            style: TextStyle(fontSize: 12.3, height: 1.45, color: c.muted),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              if (statement.isRead)
                OutlinedButton(
                  onPressed: () => _open(statement),
                  child: const Text('Open'),
                ),
              if (statement.status == 'UNIDENTIFIED' && _cards.isNotEmpty)
                OutlinedButton(
                  onPressed: _busy == statement.id ? null : () => _assign(statement),
                  child: const Text('Pick the account'),
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
