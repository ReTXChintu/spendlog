import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';
import 'statement_compare_screen.dart';
import 'statement_detail_screen.dart';

/// Every statement the mailbox has offered, and what became of it.
///
/// The engine recorded a reason against each failure from the day it was
/// written, and nothing ever showed one — so "5 statements could not be
/// read" was the whole of what anybody knew. This is that list.
class StatementsScreen extends StatefulWidget {
  const StatementsScreen({super.key, this.onlyAccountId, this.title, this.dueMonth});

  /// Which account's statements to show. Null shows every account's, which
  /// is how the pile with no account is reached.
  final String? onlyAccountId;

  /// What to call the screen when it is about one account.
  final String? title;

  /// Opened from the "upload last month's statement" to-do for a bank that
  /// never texts money in: the month wanted, YYYY-MM. The screen says so,
  /// with the way to fetch it and the way to say there is none.
  final String? dueMonth;

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
          padding: const EdgeInsets.only(bottom: 16),
          children: [
            const DsDragHandle(),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: DsSheetHeader(
                title: statement.isBank
                    ? 'Which account is this statement for?'
                    : 'Which card is this statement for?',
              ),
            ),
            for (final account in ordered)
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                leading: DsIconTile(
                  account.accountType == 'BANK' ? DsIcons.bank : DsIcons.creditCard,
                  tone: DsTone.neutral,
                ),
                title: Text(account.label),
                subtitle: Text(account.accountType == 'BANK' ? 'Bank account' : 'Credit card'),
                trailing: DsIcon(DsIcons.chevronRight, size: 18, color: context.c.tx3),
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

  /// Reads the mailbox for the statement the to-do asked for.
  Future<void> _fetchDue() async {
    await _act('sync', () async {
      final result = await ApiClient.instance.post('/statements/sync') as Map<String, dynamic>?;
      final read = result?['read'] as int? ?? 0;
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(read == 0 ? 'No new statement in the mailbox yet.' : 'Read $read new statement${read == 1 ? '' : 's'}.'),
        ));
      }
    });
  }

  /// There is no statement for that month: stop asking for it.
  Future<void> _skipDue() async {
    final navigator = Navigator.of(context);
    await _act('skip', () async {
      await ApiClient.instance.post('/accounts/${widget.onlyAccountId}/statement-due/dismiss', {'month': widget.dueMonth});
      navigator.pop(true);
    });
  }

  Widget _dueBanner(String month) {
    final c = context.c;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: c.warnSoft, borderRadius: BorderRadius.circular(Ds.rXl)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const DsIconTile(DsIcons.mail, tone: DsTone.warn, onTinted: true),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  "${readableMonth(month)}'s statement",
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.warn),
                ),
                const SizedBox(height: 4),
                Text(
                  "This bank doesn't text you about money coming in. Its statement lists every credit, and SpendLog "
                  'adds the ones it never saw. It reads statements from your mailbox.',
                  style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    FilledButton(
                      onPressed: _busy != null ? null : _fetchDue,
                      style: FilledButton.styleFrom(minimumSize: const Size(64, 40)),
                      child: Text(_busy == 'sync' ? 'Reading…' : 'Read the mailbox'),
                    ),
                    TextButton(
                      onPressed: _busy != null ? null : _skipDue,
                      child: const Text('No statement this month'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final due = widget.dueMonth;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(widget.title ?? 'Statements')),
      body: due == null || widget.onlyAccountId == null
          ? _list()
          : Column(children: [_dueBanner(due), Expanded(child: _list())]),
    );
  }

  Widget _list() {
    return _loading
          ? const Padding(
              padding: kPagePad,
              child: DsSkeletonRows(count: 5, caption: 'Loading statements…'),
            )
          : _shown.isEmpty
              ? const StateBlock(
                  icon: DsIcons.list,
                  title: 'No statements yet',
                  body: 'Read them from Settings, under Connections. They come from the same mailbox '
                      'as the transaction alerts.',
                )
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: kPagePad,
                    children: [
                      if (_duplicates > 0) ...[_resetCard(), const SizedBox(height: kCardGap)],
                      for (final group in _shown) ...[
                        _accountTile(group),
                        const SizedBox(height: kCardGap),
                      ],
                    ],
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

    return DsCard(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const DsIconTile(DsIcons.alertTriangle, tone: DsTone.warn),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Statements were read more than once',
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
                const SizedBox(height: 4),
                Text(
                  '$_duplicates of $_totalStatements are copies. They put $_addedRows transactions in '
                  'the ledger, $_categorisedRows of which you have categorised by hand. Nothing read from '
                  'an SMS or an email is touched.',
                  style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx2),
                ),
                const SizedBox(height: 12),
                // Destructive: crit text on a crit-soft edge.
                OutlinedButton.icon(
                  onPressed: _busy == 'reset' ? null : _confirmReset,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: c.crit,
                    backgroundColor: Colors.transparent,
                    side: BorderSide(color: c.critSoft),
                  ),
                  icon: const DsIcon(DsIcons.trash, size: 18),
                  label: Text(_busy == 'reset' ? 'Removing…' : 'Start over'),
                ),
              ],
            ),
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

    return DsCard(
      padding: EdgeInsets.zero,
      clip: true,
      child: Theme(
        // A divider above an expanded card would read as a second card.
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: ExpansionTile(
          initiallyExpanded: group.stuck > 0,
          tilePadding: const EdgeInsets.fromLTRB(16, 4, 12, 4),
          childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          expandedCrossAxisAlignment: CrossAxisAlignment.start,
          leading: DsIconTile(
            group.months.any((m) => m.statements.any((s) => s.isBank)) ? DsIcons.bank : DsIcons.creditCard,
            tone: group.stuck > 0 ? DsTone.warn : DsTone.neutral,
          ),
          title: Row(
            children: [
              Expanded(
                child: Text(
                  group.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
              ),
              if (group.last4.isNotEmpty)
                Text('••${group.last4}', style: kNum.copyWith(fontSize: 13, color: c.tx3)),
            ],
          ),
          subtitle: Text(
            [
              '${group.count} statement${group.count == 1 ? '' : 's'}',
              if (group.stuck > 0) '${group.stuck} need attention',
              if (group.network != null) group.network!,
            ].join(' · '),
            style: TextStyle(
              fontSize: 13,
              height: 18 / 13,
              color: group.stuck > 0 ? c.warn : c.tx3,
              fontWeight: group.stuck > 0 ? FontWeight.w500 : FontWeight.w400,
            ),
          ),
          children: [
            for (final month in group.months) ...[
              DsLabel(month.label, padding: const EdgeInsets.fromLTRB(0, 8, 0, 8)),
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

  Future<void> _compare(_Statement statement) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => StatementCompareScreen(
          statementId: statement.id,
          title: statement.subject ?? statement.fileName ?? 'Statement',
        ),
      ),
    );
    // A row opened and changed from there moves this list's counts.
    await _load();
  }

  Widget _row(_Statement statement) {
    final c = context.c;
    final tone = switch (statement.status) {
      'PARSED' => DsTone.good,
      'LOCKED' => DsTone.warn,
      'UNIDENTIFIED' => DsTone.ac,
      _ => DsTone.crit,
    };
    // Secondary buttons at the spec's small size: 36 h, radius 10, 13/600.
    final small = OutlinedButton.styleFrom(
      minimumSize: const Size(0, 36),
      padding: const EdgeInsets.symmetric(horizontal: 14),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rMd)),
      textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 13, fontWeight: FontWeight.w600),
    );
    final name = '${statement.subject ?? statement.fileName ?? 'A statement'}'
        '${statement.isBank ? '  (bank)' : ''}';

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.sf2,
        border: Border.all(color: c.ln),
        borderRadius: BorderRadius.circular(Ds.rLg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  // A file name is a machine string; a mail subject is not.
                  style: statement.subject == null && statement.fileName != null
                      ? kMono.copyWith(fontSize: 13, height: 18 / 13, color: c.tx)
                      : TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
                ),
              ),
              const SizedBox(width: 8),
              DsBadge(statement.label, tone: tone),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            _subtitle(statement),
            style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3),
          ),
          const SizedBox(height: 12),
          // Wrapped rather than in a row: a read statement has three
          // buttons and the bin, which is more than a phone's width.
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (statement.isRead)
                OutlinedButton(
                  style: small,
                  onPressed: () => _open(statement),
                  child: const Text('Open'),
                ),
              // The statement beside the ledger, both ways - and for a
              // bank statement, its close against the app's figure.
              if (statement.isRead)
                OutlinedButton(
                  style: small,
                  onPressed: () => _compare(statement),
                  child: const Text('Compare with app'),
                ),
              if (statement.status == 'UNIDENTIFIED' && _cards.isNotEmpty)
                OutlinedButton(
                  style: small,
                  onPressed: _busy == statement.id ? null : () => _assign(statement),
                  child: const Text('Pick the account'),
                ),
              // Also once whatever a read added has been undone - which is how a
              // statement read wrongly gets read again.
              if (!statement.isRead || statement.added == 0)
                OutlinedButton(
                  style: small,
                  onPressed: _busy == statement.id
                      ? null
                      : () => _act(statement.id, () async {
                            await ApiClient.instance.post('/statements/${statement.id}/reread');
                          }),
                  child: const Text('Read again'),
                ),
              if (statement.isRead && statement.added > 0)
                TextButton(
                  onPressed: _busy == statement.id
                      ? null
                      : () => _act(statement.id, () async {
                            await ApiClient.instance.delete('/statements/${statement.id}/added');
                          }),
                  child: Text('Undo ${statement.added}'),
                ),
              // Forgetting one takes back what it added on the way out, or
              // the ledger keeps rows pointing at something that no longer
              // exists.
              IconButton(
                icon: const DsIcon(DsIcons.trash, size: 20),
                color: c.crit,
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
