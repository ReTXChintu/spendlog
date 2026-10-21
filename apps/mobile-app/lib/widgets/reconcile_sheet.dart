import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import 'ds/ds.dart';
import '../utils/format.dart';

/// Why an account is off from the bank, and the one tap that puts each
/// likely cause right.
///
/// Diagnosis first: the suspects the server found near where the figures
/// parted, likeliest at the top, each with its explanation and - where
/// there is one change that would settle it - a button that sends exactly
/// that. Writing the gap in as an "Unexplained difference" is the last
/// resort, so it sits at the bottom, quiet, behind a confirmation.
///
/// Returns true when anything was changed, so the passbook behind it
/// knows to reload.
Future<bool?> showReconcileSheet(BuildContext context, {required String accountId}) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => ReconcileSheet(accountId: accountId),
  );
}

class ReconcileSheet extends StatefulWidget {
  const ReconcileSheet({super.key, required this.accountId});

  final String accountId;

  @override
  State<ReconcileSheet> createState() => _ReconcileSheetState();
}

class _ReconcileSheetState extends State<ReconcileSheet> {
  Reconcile? _reconcile;
  String? _error;

  /// The fix being sent, by its path, so only that button shows busy.
  String? _applying;
  bool _adjusting = false;

  /// Whether anything has been written, for the caller.
  bool _changed = false;

  /// The gap before the last fix, so "Fixed it" can say what it closed.
  int? _closedMinor;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final json = await ApiClient.instance.get('/accounts/${widget.accountId}/reconcile') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _reconcile = Reconcile.fromJson(json);
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e is ApiException ? e.message : "Couldn't look at this account just now.");
    }
  }

  /// Sends the suspect's own request, exactly as given, then looks again.
  Future<void> _apply(Suspect suspect) async {
    final fix = suspect.fix;
    if (fix == null || _applying != null) return;
    final before = _reconcile?.differenceMinor;
    setState(() => _applying = fix.path);
    try {
      if (fix.method == 'POST') {
        await ApiClient.instance.post(fix.path, fix.body);
      } else {
        await ApiClient.instance.patch(fix.path, fix.body);
      }
      _changed = true;
      _closedMinor = before;
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e is ApiException ? e.message : "Couldn't apply that.")),
      );
    } finally {
      if (mounted) setState(() => _applying = null);
    }
  }

  /// The last resort: a row for whatever is left, after a confirmation
  /// that says what it does.
  Future<void> _recordDifference() async {
    final reconcile = _reconcile;
    if (reconcile == null || _adjusting) return;
    final balanceMinor = await showDialog<int>(
      context: context,
      builder: (_) => _AdjustDialog(
        expectedMinor: reconcile.expectedMinor,
        initialBankMinor: reconcile.lastStated?.minor,
        isCash: reconcile.account.isCash,
      ),
    );
    if (balanceMinor == null || !mounted) return;

    setState(() => _adjusting = true);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await ApiClient.instance
          .post('/accounts/${widget.accountId}/reconcile/adjust', {'balanceMinor': balanceMinor}) as Map<String, dynamic>?;
      final gap = result?['gapMinor'];
      final gapMinor = gap is num ? gap.round() : null;
      messenger.showSnackBar(SnackBar(
        content: Text(gapMinor == null
            ? 'Recorded the difference. It is in your to-dos until you explain it.'
            : 'Recorded ${formatMoney(gapMinor.abs())} ${gapMinor < 0 ? 'out' : 'in'}. '
                'It is in your to-dos until you explain it.'),
      ));
      navigator.pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _adjusting = false);
      messenger.showSnackBar(
        SnackBar(content: Text(e is ApiException ? e.message : "Couldn't record that.")),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final reconcile = _reconcile;

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).pop(_changed);
      },
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.9),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const DsDragHandle(),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 4, 0),
              child: DsSheetHeader(
                title: 'Find the cause',
                subtitle: reconcile?.account.label,
                onClose: () => Navigator.of(context).pop(_changed),
              ),
            ),
            Flexible(
              child: reconcile == null
                  ? Padding(
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
                      child: _error == null
                          ? const DsSkeletonRows(count: 3, caption: 'Looking for what went wrong…')
                          : DsAlertCard(
                              title: _error!,
                              icon: Icons.wifi_off,
                              action: OutlinedButton(
                                onPressed: _load,
                                style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
                                child: const Text('Try again'),
                              ),
                            ),
                    )
                  : ListView(
                      shrinkWrap: true,
                      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                      children: [
                        _Gap(reconcile: reconcile, closedMinor: _closedMinor),
                        const SizedBox(height: 16),
                        if (reconcile.suspects.isEmpty)
                          _NothingFound(reconcile: reconcile)
                        else ...[
                          DsLabel(
                            reconcile.suspects.length == 1
                                ? 'One thing to look at'
                                : 'Ranked by how well each one explains the gap',
                          ),
                          const SizedBox(height: 8),
                          for (final (index, suspect) in reconcile.suspects.indexed)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: _SuspectCard(
                                suspect: suspect,
                                rank: index + 1,
                                likeliest: index == 0 && reconcile.suspects.length > 1,
                                busy: _applying == suspect.fix?.path,
                                enabled: _applying == null && !_adjusting,
                                onApply: () => _apply(suspect),
                              ),
                            ),
                        ],
                        // Only after everything above, and quiet on purpose:
                        // writing the gap in hides the mistake rather than
                        // fixing it.
                        if (!reconcile.settled) ...[
                          const SizedBox(height: 8),
                          Divider(color: c.ln),
                          const SizedBox(height: 4),
                          Align(
                            alignment: Alignment.centerLeft,
                            child: TextButton(
                              onPressed: _adjusting || _applying != null ? null : _recordDifference,
                              style: TextButton.styleFrom(foregroundColor: c.tx2, padding: EdgeInsets.zero),
                              child: Text(_adjusting ? 'Recording…' : 'None of these? Record the difference'),
                            ),
                          ),
                        ],
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Expected against the bank, and the gap between them - or "Fixed it"
/// once a fix has brought the two together.
class _Gap extends StatelessWidget {
  const _Gap({required this.reconcile, this.closedMinor});

  final Reconcile reconcile;
  final int? closedMinor;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final stated = reconcile.lastStated;
    final difference = reconcile.differenceMinor;

    if (reconcile.settled && closedMinor != null) {
      return Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: c.goodSoft, borderRadius: BorderRadius.circular(Ds.rXl)),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const DsIconTile(DsIcons.check, tone: DsTone.good, onTinted: true, size: 36),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Fixed it',
                    style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.good),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'SpendLog now matches the bank at ${formatMoney(reconcile.expectedMinor)}.',
                    style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2, fontFeatures: Ds.tabular),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(child: _Figure(label: 'SpendLog expects', value: formatMoney(reconcile.expectedMinor))),
            const SizedBox(width: 12),
            Expanded(
              child: stated == null
                  ? const _Figure(label: 'Bank said', value: '—')
                  : _Figure(label: 'Bank said · ${formatShortDate(stated.at)}', value: formatMoney(stated.minor)),
            ),
          ],
        ),
        const SizedBox(height: 12),
        if (difference == null)
          Text(
            'The bank has not put a figure on this account, so there is no gap to measure. These are the '
            'things that usually go wrong.',
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
          )
        else if (!driftIsOff(difference))
          const DsCallout(tone: DsTone.good, title: 'Within a rupee of the bank')
        else
          // A mismatch is a problem: the critical tint.
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(color: c.critSoft, borderRadius: BorderRadius.circular(Ds.rXl)),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const DsLabel('Difference'),
                const SizedBox(height: 2),
                Text(
                  '${formatMoney(difference.abs())} off',
                  style: kNum.copyWith(fontSize: 22, height: 28 / 22, fontWeight: FontWeight.w600, color: c.crit),
                ),
                const SizedBox(height: 4),
                Text(
                  difference < 0
                      ? 'SpendLog shows more than the bank. A payment is probably missing, or money in is counted twice.'
                      : 'The bank shows more than SpendLog. Money in is probably missing, or a payment is counted twice.',
                  style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// A figure in an inner tile: label, then a 2-decimal balance.
class _Figure extends StatelessWidget {
  const _Figure({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.sf2,
        border: Border.all(color: c.ln),
        borderRadius: BorderRadius.circular(Ds.rXl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.tx2),
          ),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
            ),
          ),
        ],
      ),
    );
  }
}

/// One likely cause: its rank, what it is, in words, and the one tap that
/// would put it right - or where to look when there is no such tap. The
/// likeliest is ringed in the accent and its fix is the primary button.
class _SuspectCard extends StatelessWidget {
  const _SuspectCard({
    required this.suspect,
    required this.rank,
    required this.likeliest,
    required this.busy,
    required this.enabled,
    required this.onApply,
  });

  final Suspect suspect;
  final int rank;
  final bool likeliest;
  final bool busy;
  final bool enabled;
  final VoidCallback onApply;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final fix = suspect.fix;
    final when = suspect.on == null
        ? null
        : suspect.until != null && formatShortDate(suspect.until!) != formatShortDate(suspect.on!)
            ? '${formatShortDate(suspect.on!)} – ${formatShortDate(suspect.until!)}'
            : formatShortDate(suspect.on!);

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: c.sf,
        border: Border.all(color: likeliest ? c.ac : c.ln, width: likeliest ? 2 : 1),
        borderRadius: BorderRadius.circular(Ds.rXl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: likeliest ? c.ac : c.sunk,
                  borderRadius: BorderRadius.circular(Ds.rSm),
                ),
                child: Text(
                  '$rank',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: likeliest ? c.acTx : c.tx2,
                    fontFeatures: Ds.tabular,
                  ),
                ),
              ),
              if (likeliest) ...[
                const SizedBox(width: 8),
                const DsBadge('Most likely', tone: DsTone.ac),
              ],
            ],
          ),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  suspect.title,
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
              ),
              const SizedBox(width: 10),
              Text(
                formatMoney(suspect.amountMinor),
                style: kNum.copyWith(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
              ),
            ],
          ),
          if (when != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(when, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3)),
            ),
          const SizedBox(height: 6),
          Text(suspect.explanation, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2)),
          const SizedBox(height: 12),
          if (fix != null)
            likeliest
                ? SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: enabled ? onApply : null,
                      child: Text(busy ? 'Applying…' : fix.label),
                    ),
                  )
                : Align(
                    alignment: Alignment.centerLeft,
                    child: OutlinedButton(
                      onPressed: enabled ? onApply : null,
                      style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
                      child: Text(busy ? 'Applying…' : fix.label),
                    ),
                  )
          else
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(color: c.sunk, borderRadius: BorderRadius.circular(Ds.rLg)),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 1),
                    child: Icon(Icons.phone_android_outlined, size: 16, color: c.tx2),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(suspect.whatToCheck, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2)),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _NothingFound extends StatelessWidget {
  const _NothingFound({required this.reconcile});

  final Reconcile reconcile;

  @override
  Widget build(BuildContext context) {
    final since = reconcile.firstDrift?.on;
    return DsCallout(
      tone: reconcile.settled ? DsTone.good : DsTone.neutral,
      icon: reconcile.settled ? DsIcons.check : DsIcons.search,
      title: reconcile.settled
          ? 'Nothing to find: SpendLog is within a rupee of the bank.'
          : since == null
              ? 'Nothing obvious in the rows. Check the bank app against the passbook, and add by hand '
                  'anything SpendLog does not have.'
              : 'Nothing obvious in the rows. Open the bank app at ${formatShortDate(since)} and the days '
                  'after it, and add by hand anything SpendLog does not have.',
    );
  }
}

/// Digits, one minus sign at the front, and a decimal point: a balance can
/// be overdrawn, so unlike every other amount it can be negative.
final _signedAmount = FilteringTextInputFormatter.allow(RegExp(r'^-?[\d,]*\.?\d{0,2}'));

/// The confirmation before the gap is written in: what the bank shows,
/// editable, and plainly what recording it does.
class _AdjustDialog extends StatefulWidget {
  const _AdjustDialog({required this.expectedMinor, this.initialBankMinor, this.isCash = false});

  final int expectedMinor;
  final int? initialBankMinor;
  final bool isCash;

  @override
  State<_AdjustDialog> createState() => _AdjustDialogState();
}

class _AdjustDialogState extends State<_AdjustDialog> {
  late final TextEditingController _amount = TextEditingController(
    text: widget.initialBankMinor == null ? '' : (widget.initialBankMinor! / 100).toStringAsFixed(2),
  );

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  int? get _bankMinor => parseRupees(_amount.text, allowNegative: true);

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final bank = _bankMinor;
    final gap = bank == null ? null : bank - widget.expectedMinor;

    return AlertDialog(
      title: const Text('Record the difference?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'This adds an "Unexplained difference" to the account so its balance matches ${widget.isCash ? 'your wallet' : 'the bank'}. '
            'It counts as ${gap == null || gap < 0 ? 'spending' : 'money in'} like any other row, and stays in your '
            'to-dos until you say what it was.',
            style: TextStyle(fontSize: 15, height: 22 / 15, color: c.tx2),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _amount,
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
            inputFormatters: [_signedAmount],
            style: kNum.copyWith(fontSize: 17, fontWeight: FontWeight.w600, color: c.tx),
            decoration: InputDecoration(
              labelText: widget.isCash ? 'What your wallet holds' : 'What the bank shows',
              prefixText: '₹ ',
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 8),
          Text(
            gap == null
                ? 'SpendLog expects ${formatMoney(widget.expectedMinor)}.'
                : gap == 0
                    ? 'That is what SpendLog expects already - nothing to record.'
                    : 'SpendLog expects ${formatMoney(widget.expectedMinor)}, so ${formatMoney(gap.abs())} '
                        '${gap < 0 ? 'out' : 'in'} will be written in.',
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          onPressed: bank == null || gap == 0 ? null : () => Navigator.of(context).pop(bank),
          child: const Text('Record it'),
        ),
      ],
    );
  }
}
