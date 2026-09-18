import 'dart:io';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';

/// One statement, opened.
///
/// Everything the app made of a statement used to be a count on a list row
/// — "38 transactions, 12 added" — with no way to see which twelve, or to
/// disagree with any of them. Two panes for the two questions actually
/// asked of a statement, and a button for the third: what is on it, what
/// the reader saw, and the page itself.
class StatementDetailScreen extends StatefulWidget {
  const StatementDetailScreen({super.key, required this.statementId, required this.title});

  final String statementId;
  final String title;

  @override
  State<StatementDetailScreen> createState() => _StatementDetailScreenState();
}

class _Line {
  final String id;
  final DateTime date;
  final String description;
  final int amountMinor;
  final String type;
  final String kind;
  final String resolution;
  final String? matchedTo;

  _Line({
    required this.id,
    required this.date,
    required this.description,
    required this.amountMinor,
    required this.type,
    required this.kind,
    required this.resolution,
    this.matchedTo,
  });

  bool get isCredit => type == 'CREDIT';

  String get label => switch (resolution) {
        'MATCHED' => 'Already known',
        'ADDED' => 'Added',
        'UNCERTAIN' => 'Not sure',
        _ => 'Not counted',
      };

  factory _Line.fromJson(Map<String, dynamic> json) {
    final transaction = json['transaction'] as Map<String, dynamic>?;
    return _Line(
      id: json['id'] as String,
      date: DateTime.parse(json['date'] as String),
      description: (json['description'] as String?) ?? '',
      amountMinor: json['amountMinor'] as int? ?? 0,
      type: json['type'] as String? ?? 'DEBIT',
      kind: json['kind'] as String? ?? 'SPEND',
      resolution: json['resolution'] as String? ?? 'SKIPPED',
      matchedTo: transaction?['merchant'] as String?,
    );
  }
}

class _Detail {
  final String? issuer;
  final DateTime? periodStart;
  final DateTime? periodEnd;
  final DateTime? dueDate;
  final int? totalDueMinor;
  final int? waivedMinor;
  final String? waivedNote;
  final bool hasFile;
  final List<String> rows;
  final List<_Line> lines;

  _Detail({
    this.issuer,
    this.periodStart,
    this.periodEnd,
    this.dueDate,
    this.totalDueMinor,
    this.waivedMinor,
    this.waivedNote,
    required this.hasFile,
    required this.rows,
    required this.lines,
  });

  factory _Detail.fromJson(Map<String, dynamic> json) => _Detail(
        issuer: json['issuer'] as String?,
        periodStart: DateTime.tryParse((json['periodStart'] as String?) ?? ''),
        periodEnd: DateTime.tryParse((json['periodEnd'] as String?) ?? ''),
        dueDate: DateTime.tryParse((json['dueDate'] as String?) ?? ''),
        totalDueMinor: json['totalDueMinor'] as int?,
        waivedMinor: json['waivedMinor'] as int?,
        waivedNote: json['waivedNote'] as String?,
        hasFile: json['hasFile'] as bool? ?? false,
        rows: ((json['rows'] as List?) ?? const []).map((row) => row.toString()).toList(),
        lines: ((json['lines'] as List?) ?? const [])
            .map((line) => _Line.fromJson(line as Map<String, dynamic>))
            .toList(),
      );
}

class _StatementDetailScreenState extends State<StatementDetailScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 2, vsync: this);
  _Detail? _detail;
  bool _loading = true;
  bool _openingFile = false;
  String? _busyLine;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final json = await ApiClient.instance.get('/statements/${widget.statementId}');
      if (!mounted) return;
      setState(() => _detail = _Detail.fromJson(json as Map<String, dynamic>));
    } catch (_) {
      // Left as it was; the empty state says so.
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Overrule one line by hand.
  ///
  /// The matcher goes on amount, type, card and date, and never on the
  /// merchant's name — which is right, because a name in SpendLog may have
  /// been edited into something the bank never printed. That makes it
  /// confident and occasionally wrong, and this is where it is told so.
  Future<void> _resolve(_Line line, String action) async {
    setState(() => _busyLine = line.id);
    try {
      await ApiClient.instance.patch(
        '/statements/${widget.statementId}/lines/${line.id}',
        {'action': action},
      );
      await _load();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error')));
      }
    } finally {
      if (mounted) setState(() => _busyLine = null);
    }
  }

  /// The statement itself, handed to whatever opens a PDF on this phone.
  ///
  /// Written to the cache rather than anywhere permanent: this is a bank
  /// statement, and the copy that matters is the encrypted one on the
  /// server.
  Future<void> _openFile() async {
    setState(() => _openingFile = true);
    try {
      final bytes = await ApiClient.instance.bytes('/statements/${widget.statementId}/file');
      final directory = await getTemporaryDirectory();
      final file = File('${directory.path}/statement-${widget.statementId}.pdf');
      await file.writeAsBytes(bytes, flush: true);

      final result = await OpenFilex.open(file.path, type: 'application/pdf');
      if (result.type != ResultType.done && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('No app on this phone opens a PDF.')),
        );
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error')));
      }
    } finally {
      if (mounted) setState(() => _openingFile = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final detail = _detail;

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        bottom: TabBar(
          controller: _tabs,
          tabs: [
            Tab(text: 'Transactions${detail == null ? '' : ' (${detail.lines.length})'}'),
            const Tab(text: 'What was read'),
          ],
        ),
        actions: [
          if (detail?.hasFile ?? false)
            IconButton(
              tooltip: 'Open the PDF',
              onPressed: _openingFile ? null : _openFile,
              icon: _openingFile
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.picture_as_pdf_outlined),
            ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : detail == null
              ? const StateBlock(
                  icon: Icons.error_outline,
                  title: 'Could not open it',
                  body: 'The statement could not be loaded.',
                )
              : Column(
                  children: [
                    if (_summary(detail).isNotEmpty)
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                        color: c.paper,
                        child: Text(
                          _summary(detail),
                          style: TextStyle(fontSize: 12, color: c.muted, height: 1.45),
                        ),
                      ),
                    if (detail.totalDueMinor != null)
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
                        child: _WaiveBanner(
                          statementId: widget.statementId,
                          detail: detail,
                          onChanged: _load,
                        ),
                      ),
                    Expanded(
                      child: TabBarView(
                        controller: _tabs,
                        children: [_linesPane(detail), _textPane(detail)],
                      ),
                    ),
                  ],
                ),
    );
  }

  String _summary(_Detail detail) => [
        if (detail.issuer != null) detail.issuer!,
        if (detail.periodStart != null && detail.periodEnd != null)
          '${_day(detail.periodStart!)} – ${_day(detail.periodEnd!)}',
        if (detail.totalDueMinor != null) '${formatMoney(detail.totalDueMinor!)} due',
        if (detail.dueDate != null) 'by ${_day(detail.dueDate!)}',
      ].join(' · ');

  Widget _linesPane(_Detail detail) {
    if (detail.lines.isEmpty) {
      return const StateBlock(
        icon: Icons.receipt_long_outlined,
        title: 'Nothing on it',
        body: 'No transactions were read off this statement.',
      );
    }

    final c = context.c;

    return ListView.separated(
      padding: const EdgeInsets.symmetric(vertical: 6),
      itemCount: detail.lines.length,
      separatorBuilder: (_, __) => Divider(height: 1, color: c.line),
      itemBuilder: (_, index) {
        final line = detail.lines[index];
        final busy = _busyLine == line.id;

        return Opacity(
          opacity: line.resolution == 'SKIPPED' ? 0.6 : 1,
          child: ListTile(
            dense: true,
            title: Text(
              line.description.isEmpty ? '—' : line.description,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 13.3, fontWeight: FontWeight.w600),
            ),
            subtitle: Text(
              [
                _day(line.date),
                line.label,
                if (line.matchedTo != null) line.matchedTo!,
                if (line.kind != 'SPEND') line.kind.toLowerCase(),
              ].join(' · '),
              style: TextStyle(fontSize: 11.5, color: c.muted),
            ),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '${line.isCredit ? '+' : ''}${formatMoney(line.amountMinor)}',
                  style: kNum.copyWith(
                    fontSize: 13,
                    color: line.isCredit ? c.credit : c.ink,
                  ),
                ),
                PopupMenuButton<String>(
                  enabled: !busy,
                  icon: const Icon(Icons.more_vert, size: 18),
                  onSelected: (action) => _resolve(line, action),
                  itemBuilder: (_) => [
                    // A line SpendLog thinks it already has, that it does
                    // not. The usual cause is a merchant renamed by hand.
                    if (line.resolution == 'MATCHED' || line.resolution == 'SKIPPED')
                      const PopupMenuItem(value: 'add', child: Text("SpendLog doesn't have this — add it")),
                    if (line.resolution != 'SKIPPED')
                      const PopupMenuItem(value: 'ignore', child: Text('Leave it out')),
                    if (line.resolution != 'MATCHED')
                      const PopupMenuItem(value: 'reset', child: Text('Work it out again')),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _textPane(_Detail detail) {
    if (detail.rows.isEmpty) {
      return const StateBlock(
        icon: Icons.notes_outlined,
        title: 'Not kept',
        body: 'This statement was read before SpendLog kept the text. Read it again to store it.',
      );
    }

    final c = context.c;

    return ListView.builder(
      padding: const EdgeInsets.all(14),
      itemCount: detail.rows.length,
      itemBuilder: (_, index) => Padding(
        padding: const EdgeInsets.only(bottom: 3),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 30,
              child: Text(
                '$index',
                textAlign: TextAlign.right,
                style: TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: c.mutedLight),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                detail.rows[index],
                style: TextStyle(fontSize: 11, fontFamily: 'monospace', height: 1.5, color: c.ink70),
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _day(DateTime date) => DateFormat('d MMM yy').format(date);
}

/// The bill, less what a payment actually covered, is a real and permanent
/// gap whenever part of it was cashback or points rather than money -
/// SpendLog only ever sees money that moved, and has no way to notice the
/// difference on its own. This is where it is told.
class _WaiveBanner extends StatefulWidget {
  const _WaiveBanner({required this.statementId, required this.detail, required this.onChanged});

  final String statementId;
  final _Detail detail;
  final Future<void> Function() onChanged;

  @override
  State<_WaiveBanner> createState() => _WaiveBannerState();
}

class _WaiveBannerState extends State<_WaiveBanner> {
  bool _editing = false;
  late final _amount = TextEditingController(
    text: widget.detail.waivedMinor != null ? (widget.detail.waivedMinor! / 100).toString() : '',
  );
  late final _note = TextEditingController(text: widget.detail.waivedNote ?? '');
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _save(int? waivedMinor) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ApiClient.instance.patch('/statements/${widget.statementId}/waive', {
        'waivedMinor': waivedMinor,
        'note': _note.text.trim().isEmpty ? null : _note.text.trim(),
      });
      if (!mounted) return;
      setState(() => _editing = false);
      await widget.onChanged();
    } catch (error) {
      if (mounted) {
        setState(() => _error = error is ApiException ? error.message : "That didn't work.");
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final waived = widget.detail.waivedMinor;

    if (!_editing && waived == null) {
      return Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          onPressed: () => setState(() => _editing = true),
          icon: const Icon(Icons.percent, size: 16),
          label: const Text('Part of this was cashback or points, not money'),
          style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 4)),
        ),
      );
    }

    if (!_editing) {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(
          color: c.credit.withValues(alpha: .08),
          borderRadius: BorderRadius.circular(T.rSm),
        ),
        child: Row(
          children: [
            Icon(Icons.check_circle_outline, size: 16, color: c.credit),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                '${formatMoney(waived!)} covered'
                '${widget.detail.waivedNote != null ? ' — ${widget.detail.waivedNote}' : ''}, '
                'not still owed',
                style: TextStyle(fontSize: 12.5, color: c.ink70),
              ),
            ),
            TextButton(
              onPressed: () => setState(() => _editing = true),
              child: const Text('Change'),
            ),
          ],
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(11),
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(border: Border.all(color: c.line), borderRadius: BorderRadius.circular(T.rMd)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'The amount covered by cashback, reward points, or a fee the bank waived - the part of '
            'the bill that a payment was never going to cover, because it was never money.',
            style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Covered', prefixText: '₹ '),
          ),
          const SizedBox(height: 8),
          TextField(
            controller: _note,
            decoration: const InputDecoration(labelText: 'Note', hintText: 'Cashback used at checkout'),
          ),
          if (_error != null) ...[
            const SizedBox(height: 6),
            Text(_error!, style: TextStyle(fontSize: 12, color: c.debit)),
          ],
          const SizedBox(height: 10),
          Row(
            children: [
              FilledButton(
                onPressed: _saving
                    ? null
                    : () {
                        final rupees = double.tryParse(_amount.text.trim());
                        if (rupees != null && rupees >= 0) _save((rupees * 100).round());
                      },
                child: const Text('Save'),
              ),
              const SizedBox(width: 8),
              if (widget.detail.waivedMinor != null)
                TextButton(
                  onPressed: _saving ? null : () => _save(null),
                  child: Text('Remove', style: TextStyle(color: c.debit)),
                ),
              const Spacer(),
              TextButton(
                onPressed: _saving ? null : () => setState(() => _editing = false),
                child: const Text('Cancel'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
