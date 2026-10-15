import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
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
    backgroundColor: context.c.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
    ),
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
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 18, 8, 0),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Find the cause', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink)),
                        if (reconcile != null)
                          Text(reconcile.account.label, style: TextStyle(fontSize: 12.5, color: c.muted)),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Close',
                    onPressed: () => Navigator.of(context).pop(_changed),
                    icon: Icon(Icons.close, color: c.muted),
                  ),
                ],
              ),
            ),
            Flexible(
              child: reconcile == null
                  ? Padding(
                      padding: const EdgeInsets.all(32),
                      child: Center(
                        child: _error == null
                            ? const CircularProgressIndicator()
                            : Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: c.ink70)),
                                  const SizedBox(height: 12),
                                  OutlinedButton(onPressed: _load, child: const Text('Try again')),
                                ],
                              ),
                      ),
                    )
                  : ListView(
                      shrinkWrap: true,
                      padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
                      children: [
                        _Gap(reconcile: reconcile, closedMinor: _closedMinor),
                        const SizedBox(height: 16),
                        if (reconcile.suspects.isEmpty)
                          _NothingFound(reconcile: reconcile)
                        else ...[
                          Text(
                            reconcile.suspects.length == 1 ? 'ONE THING TO LOOK AT' : 'LIKELIEST FIRST',
                            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: c.muted),
                          ),
                          const SizedBox(height: 8),
                          for (final suspect in reconcile.suspects)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 10),
                              child: _SuspectCard(
                                suspect: suspect,
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
                          const SizedBox(height: 18),
                          Divider(color: c.line),
                          const SizedBox(height: 6),
                          Align(
                            alignment: Alignment.centerLeft,
                            child: TextButton(
                              onPressed: _adjusting || _applying != null ? null : _recordDifference,
                              style: TextButton.styleFrom(foregroundColor: c.muted),
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
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(color: c.credit50, borderRadius: BorderRadius.circular(T.rMd)),
        child: Row(
          children: [
            Icon(Icons.check_circle, color: c.credit, size: 22),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Fixed it', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: c.credit)),
                  const SizedBox(height: 2),
                  Text(
                    'SpendLog now matches the bank at ${formatMoney(reconcile.expectedMinor)}.',
                    style: TextStyle(fontSize: 12.5, height: 1.4, color: c.ink70),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.paper,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
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
          const SizedBox(height: 10),
          if (difference == null)
            Text(
              'The bank has not put a figure on this account, so there is no gap to measure. These are the '
              'things that usually go wrong.',
              style: TextStyle(fontSize: 12.5, height: 1.45, color: c.muted),
            )
          else if (!driftIsOff(difference))
            Row(
              children: [
                Icon(Icons.check_circle_outline, size: 16, color: c.credit),
                const SizedBox(width: 6),
                Text('Within a rupee of the bank', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: c.credit)),
              ],
            )
          else
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                  decoration: BoxDecoration(color: c.debit50, borderRadius: BorderRadius.circular(100)),
                  child: Text(
                    '${formatMoney(difference.abs())} off',
                    style: kNum.copyWith(fontSize: 12.5, fontWeight: FontWeight.w800, color: c.debit),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    difference < 0
                        ? 'SpendLog shows more than the bank. A payment is probably missing, or money in is counted twice.'
                        : 'The bank shows more than SpendLog. Money in is probably missing, or a payment is counted twice.',
                    style: TextStyle(fontSize: 12, height: 1.4, color: c.muted),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

class _Figure extends StatelessWidget {
  const _Figure({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: c.muted)),
        const SizedBox(height: 3),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(value, style: kNum.copyWith(fontSize: 18, fontWeight: FontWeight.w800, color: c.ink)),
        ),
      ],
    );
  }
}

/// One likely cause: what it is, in words, and the one tap that would put
/// it right - or where to look when there is no such tap.
class _SuspectCard extends StatelessWidget {
  const _SuspectCard({required this.suspect, required this.busy, required this.enabled, required this.onApply});

  final Suspect suspect;
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
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(suspect.title, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w800, color: c.ink)),
              ),
              const SizedBox(width: 10),
              Text(
                formatMoney(suspect.amountMinor),
                style: kNum.copyWith(fontSize: 13.5, fontWeight: FontWeight.w800, color: c.ink),
              ),
            ],
          ),
          if (when != null)
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Text(when, style: TextStyle(fontSize: 11.5, color: c.mutedLight)),
            ),
          const SizedBox(height: 6),
          Text(suspect.explanation, style: TextStyle(fontSize: 12.8, height: 1.45, color: c.ink70)),
          const SizedBox(height: 10),
          if (fix != null)
            Align(
              alignment: Alignment.centerLeft,
              child: FilledButton.tonal(
                onPressed: enabled ? onApply : null,
                child: Text(busy ? 'Applying…' : fix.label),
              ),
            )
          else
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.phone_android_outlined, size: 14, color: c.muted),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(suspect.whatToCheck, style: TextStyle(fontSize: 11.8, height: 1.4, color: c.muted)),
                ),
              ],
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
    final c = context.c;
    final since = reconcile.firstDrift?.on;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: c.chipNeutral, borderRadius: BorderRadius.circular(T.rMd)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.search_off, size: 18, color: c.muted),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              reconcile.settled
                  ? 'Nothing to find: SpendLog is within a rupee of the bank.'
                  : since == null
                      ? 'Nothing obvious in the rows. Check the bank app against the passbook, and add by hand '
                          'anything SpendLog does not have.'
                      : 'Nothing obvious in the rows. Open the bank app at ${formatShortDate(since)} and the days '
                          'after it, and add by hand anything SpendLog does not have.',
              style: TextStyle(fontSize: 12.8, height: 1.45, color: c.ink70),
            ),
          ),
        ],
      ),
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
            style: TextStyle(fontSize: 13, height: 1.45, color: c.ink70),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _amount,
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
            inputFormatters: [_signedAmount],
            style: kNum.copyWith(fontSize: 18, fontWeight: FontWeight.w700, color: c.ink),
            decoration: InputDecoration(
              labelText: widget.isCash ? 'What your wallet holds' : 'What the bank shows',
              prefixText: '₹ ',
              border: const OutlineInputBorder(),
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
            style: TextStyle(fontSize: 12, height: 1.4, color: c.muted),
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
