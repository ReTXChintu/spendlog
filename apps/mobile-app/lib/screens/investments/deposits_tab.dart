import 'package:flutter/material.dart';
import '../../models/deposit_models.dart';
import '../../services/api_client.dart';
import '../../utils/format.dart';
import '../../widgets/ds/ds.dart';
import '../../widgets/state_block.dart';

/// RDs and FDs, beside the funds: what each holds, what goes in a month,
/// and the payments that went in. A total grows by every payment put into
/// it (from the payment's editor, "Into RD/FD") and can be corrected from
/// the passbook any time. No interest and no maturity date - just the
/// money.
class DepositsTab extends StatefulWidget {
  const DepositsTab({super.key});

  @override
  State<DepositsTab> createState() => DepositsTabState();
}

class DepositsTabState extends State<DepositsTab> {
  DepositList? _list;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final json = await ApiClient.instance.get('/deposits') as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _list = DepositList.fromJson(json);
          _failed = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  /// Add one, or change one; reloads when anything was saved.
  Future<void> edit([Deposit? deposit]) async {
    final saved = await showDepositEditor(context, deposit: deposit);
    if (saved == true) await load();
  }

  Future<void> _open(Deposit deposit) async {
    final changed = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: context.c.sf,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl))),
      builder: (_) => _DepositDetail(deposit: deposit, onEdit: () => edit(deposit)),
    );
    if (changed == true) await load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final list = _list;
    if (list == null) {
      return _failed
          ? StateBlock(
              icon: Icons.wifi_off,
              warn: true,
              title: "Couldn't load your deposits",
              body: 'The connection failed. Check your internet and try again.',
              actionLabel: 'Retry',
              onAction: load,
            )
          : const Center(child: DsSpinner());
    }
    if (list.isEmpty) {
      return StateBlock(
        icon: DsIcons.piggyBank,
        title: 'Track your RDs and FDs',
        body: 'Add each one with what it holds today, and for an RD what goes in each month. A payment put into '
            'it - from the payment\'s editor, "Into RD/FD" - adds to its total. One payment can go into several.',
        actionLabel: 'Add a deposit',
        onAction: () => edit(),
      );
    }

    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
        children: [
          DsCard(
            child: Wrap(
              spacing: 24,
              runSpacing: 10,
              children: [
                DsInlineStat(label: 'In RDs and FDs', value: formatMoney(list.totalMinor)),
                if (list.monthlyMinor > 0) DsInlineStat(label: 'Going in a month', value: formatMoney(list.monthlyMinor)),
              ],
            ),
          ),
          const SizedBox(height: 24),
          DsSectionHeader('Deposits', badge: DsCountBadge(list.deposits.length)),
          const SizedBox(height: 8),
          for (final (i, deposit) in list.deposits.indexed) ...[
            if (i > 0) const SizedBox(height: kCardGap),
            DepositCard(deposit: deposit, onTap: () => _open(deposit)),
          ],
          const SizedBox(height: 16),
          Text(
            'Each total is what you last said it held, plus every payment put into it since. Money into a deposit '
            'still counts against your monthly budget, like any fixed cost.',
            style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
          ),
        ],
      ),
    );
  }
}

/// One deposit: its name and kind, what it holds, and this month's money in.
class DepositCard extends StatelessWidget {
  const DepositCard({super.key, required this.deposit, this.onTap});

  final Deposit deposit;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final monthly = deposit.monthlyMinor;
    final foot = [
      if (!deposit.isActive) 'Closed',
      if (monthly != null && monthly > 0) '${formatMoney(monthly)} a month',
      if (deposit.addedThisMonthMinor > 0) '${formatMoney(deposit.addedThisMonthMinor)} in this month',
      if (deposit.isActive && monthly != null && monthly > 0 && deposit.addedThisMonthMinor == 0) 'nothing in yet this month',
    ].join(' · ');

    return DsCard(
      key: ValueKey('deposit-${deposit.id}'),
      onTap: onTap,
      child: Row(
        children: [
          DsIconTile(DsIcons.piggyBank, tone: deposit.isActive ? DsTone.good : DsTone.neutral),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  deposit.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
                Text(deposit.subtitle, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                if (foot.isNotEmpty)
                  Text(foot, style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx2)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            formatMoneyShort(deposit.totalMinor),
            style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
          ),
        ],
      ),
    );
  }
}

/// A deposit's payments, with a way to edit it.
class _DepositDetail extends StatefulWidget {
  const _DepositDetail({required this.deposit, required this.onEdit});

  final Deposit deposit;
  final Future<void> Function() onEdit;

  @override
  State<_DepositDetail> createState() => _DepositDetailState();
}

class _DepositDetailState extends State<_DepositDetail> {
  List<DepositPayment>? _payments;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final rows = await ApiClient.instance.get('/deposits/${widget.deposit.id}/payments') as List<dynamic>;
      if (mounted) {
        setState(() => _payments = rows.whereType<Map<String, dynamic>>().map(DepositPayment.fromJson).toList());
      }
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final deposit = widget.deposit;
    final payments = _payments;

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(deposit.name, style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx)),
                    Text(deposit.subtitle, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3)),
                  ],
                ),
              ),
              Text(formatMoney(deposit.totalMinor), style: kNum.copyWith(fontSize: 17, fontWeight: FontWeight.w600, color: c.tx)),
            ],
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: () async {
              Navigator.of(context).pop(false);
              await widget.onEdit();
            },
            icon: const DsIcon(DsIcons.pencil, size: 16),
            label: const Text('Edit, correct the total, or close it'),
          ),
          const SizedBox(height: 16),
          const DsLabel('Payments put in'),
          const SizedBox(height: 6),
          if (payments == null)
            _failed
                ? Text("Couldn't load them.", style: TextStyle(fontSize: 13, color: c.tx3))
                : const DsSkeletonRows(count: 3)
          else if (payments.isEmpty)
            Text(
              'None yet. Open a payment, pick "Into RD/FD" and choose this one.',
              style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
            )
          else
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final payment in payments)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(payment.merchant ?? 'Payment',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx)),
                                Text(
                                  [
                                    if (payment.occurredAt != null) formatShortDate(payment.occurredAt!),
                                    if (payment.paymentMinor != payment.amountMinor) 'of ${formatMoney(payment.paymentMinor)}',
                                  ].join(' · '),
                                  style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
                                ),
                              ],
                            ),
                          ),
                          Text('+${formatMoney(payment.amountMinor)}',
                              style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.good)),
                        ],
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Add a deposit, or change one. True when something was saved.
Future<bool?> showDepositEditor(BuildContext context, {Deposit? deposit}) => showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: context.c.sf,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl))),
      builder: (_) => _DepositEditor(deposit: deposit),
    );

class _DepositEditor extends StatefulWidget {
  const _DepositEditor({this.deposit});

  final Deposit? deposit;

  @override
  State<_DepositEditor> createState() => _DepositEditorState();
}

class _DepositEditorState extends State<_DepositEditor> {
  late final TextEditingController _name = TextEditingController(text: widget.deposit?.name ?? '');
  late final TextEditingController _institution = TextEditingController(text: widget.deposit?.institution ?? '');
  late final TextEditingController _total = TextEditingController(
    text: widget.deposit == null ? '' : (widget.deposit!.totalMinor / 100).toStringAsFixed(2),
  );
  late final TextEditingController _monthly = TextEditingController(
    text: widget.deposit?.monthlyMinor == null ? '' : (widget.deposit!.monthlyMinor! / 100).toStringAsFixed(2),
  );
  late String _kind = widget.deposit?.kind ?? 'RD';
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _institution.dispose();
    _total.dispose();
    _monthly.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final total = parseRupees(_total.text);
    if (name.isEmpty) return setState(() => _error = 'Give it a name, like "Post office RD".');
    if (total == null) return setState(() => _error = 'Enter what it holds today, ₹0 if it has just started.');
    final monthly = _kind == 'RD' && _monthly.text.trim().isNotEmpty ? parseRupees(_monthly.text) : null;

    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    final existing = widget.deposit;
    try {
      final body = <String, dynamic>{
        'name': name,
        'institution': _institution.text.trim().isEmpty ? null : _institution.text.trim(),
        'monthlyMinor': monthly,
      };
      if (existing == null) {
        await ApiClient.instance.post('/deposits', {...body, 'kind': _kind, 'totalMinor': total});
      } else {
        // Only a changed total moves where it counts from.
        await ApiClient.instance.patch('/deposits/${existing.id}', {
          ...body,
          if (total != existing.totalMinor) 'totalMinor': total,
        });
      }
      navigator.pop(true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = e is ApiException && !e.message.startsWith('{') ? e.message : "Couldn't save it. Try again.";
        });
      }
    }
  }

  Future<void> _setActive(bool active) async {
    final navigator = Navigator.of(context);
    await ApiClient.instance.patch('/deposits/${widget.deposit!.id}', {'isActive': active}).catchError((_) => null);
    navigator.pop(true);
  }

  Future<void> _delete() async {
    final navigator = Navigator.of(context);
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this deposit?'),
        content: const Text('Payments put into it stay, as the spending they were. Close it instead to keep its history.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Delete')),
        ],
      ),
    );
    if (sure != true) return;
    await ApiClient.instance.delete('/deposits/${widget.deposit!.id}').catchError((_) {});
    navigator.pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final existing = widget.deposit;

    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(existing == null ? 'Add a deposit' : 'Edit ${existing.name}',
                style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx)),
            const SizedBox(height: 16),
            if (existing == null) ...[
              DsSegmented<String>(
                segments: const [('RD', 'Recurring (RD)'), ('FD', 'Fixed (FD)')],
                selected: _kind,
                onChanged: (kind) => setState(() => _kind = kind),
              ),
              const SizedBox(height: 12),
            ],
            DsField(
              label: 'Name',
              child: TextField(
                key: const ValueKey('deposit-name'),
                controller: _name,
                textCapitalization: TextCapitalization.sentences,
                decoration: const InputDecoration(hintText: 'Post office RD'),
              ),
            ),
            const SizedBox(height: 12),
            DsField(
              label: 'Where it is held (optional)',
              child: TextField(
                controller: _institution,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(hintText: 'Bank, post office or agent'),
              ),
            ),
            const SizedBox(height: 12),
            DsField(
              label: existing == null ? 'What it holds today' : 'What it holds now',
              child: TextField(
                key: const ValueKey('deposit-total'),
                controller: _total,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(prefixText: '₹ ', hintText: '0.00'),
              ),
            ),
            if (existing != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(
                  'Change it to match the passbook. Payments put in from now on add to the new figure.',
                  style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                ),
              ),
            if (_kind == 'RD') ...[
              const SizedBox(height: 12),
              DsField(
                label: 'Goes in each month',
                child: TextField(
                  key: const ValueKey('deposit-monthly'),
                  controller: _monthly,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(prefixText: '₹ ', hintText: '0.00'),
                ),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: c.crit)),
            ],
            const SizedBox(height: 16),
            FilledButton(onPressed: _saving ? null : _save, child: Text(existing == null ? 'Add deposit' : 'Save')),
            if (existing != null) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  TextButton(
                    onPressed: _saving ? null : () => _setActive(!existing.isActive),
                    child: Text(existing.isActive ? 'Close it (matured or broken)' : 'Open it again'),
                  ),
                  const Spacer(),
                  TextButton(
                    onPressed: _saving ? null : _delete,
                    style: TextButton.styleFrom(foregroundColor: c.crit),
                    child: const Text('Delete'),
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
