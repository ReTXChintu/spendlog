import 'package:flutter/material.dart';
import '../models/models.dart';
import '../models/subscription_models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import '../widgets/ds/ds.dart';
import '../widgets/state_block.dart';
import '../widgets/subscription_sheet.dart';
import 'subscriptions_screen.dart';

/// One subscription: what it costs and when it next renews, what needs
/// doing about it, who shares it, and every renewal so far - matched to
/// its payment, missed, or skipped - each with the ways to put it right.
class SubscriptionDetailScreen extends StatefulWidget {
  const SubscriptionDetailScreen({super.key, this.initial, this.id}) : assert(initial != null || id != null);

  final Subscription? initial;
  final String? id;

  @override
  State<SubscriptionDetailScreen> createState() => _SubscriptionDetailScreenState();
}

class _SubscriptionDetailScreenState extends State<SubscriptionDetailScreen> {
  Subscription? _sub;
  bool _failed = false;
  bool _busy = false;
  List<Contact> _contacts = const [];

  String get _id => widget.initial?.id ?? widget.id!;

  @override
  void initState() {
    super.initState();
    _sub = widget.initial;
    _load();
  }

  Future<void> _load() async {
    setState(() => _failed = false);
    try {
      final json = await ApiClient.instance.get('/subscriptions/$_id') as Map<String, dynamic>;
      if (!mounted) return;
      final sub = Subscription.fromJson(json);
      setState(() => _sub = sub);
      if (sub.isShared && _contacts.isEmpty) await _loadContacts();
    } catch (_) {
      if (mounted && _sub == null) setState(() => _failed = true);
    }
  }

  Future<void> _loadContacts() async {
    try {
      final json = await ApiClient.instance.get('/contacts') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() => _contacts = (json['contacts'] as List<dynamic>).map((c) => Contact.fromJson(c as Map<String, dynamic>)).toList());
    } catch (_) {}
  }

  Future<void> _act(Future<void> Function() action, {String? done}) async {
    setState(() => _busy = true);
    try {
      await action();
      await _load();
      if (done != null && mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't reach the server.")));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _edit() async {
    final saved = await showSubscriptionSheet(context, existing: _sub);
    if (saved == true) _load();
  }

  Future<void> _pauseOrResume() => _act(
        () => ApiClient.instance.post('/subscriptions/$_id/${_sub!.isLive ? 'pause' : 'resume'}'),
        done: _sub!.isLive ? 'Paused - the schedule stands still.' : 'Running again.',
      );

  Future<void> _cancel() async {
    final sure = await _confirm('Cancel ${_sub!.name}?', 'It stays here with its history, marked cancelled. Nothing is cancelled with the service itself - do that with them.', 'Mark cancelled');
    if (sure == true) await _act(() => ApiClient.instance.post('/subscriptions/$_id/cancel'));
  }

  Future<void> _delete() async {
    final sure = await _confirm('Delete ${_sub!.name}?', 'The payments it was matched to stay as payments. Only the subscription goes.', 'Delete');
    if (sure != true) return;
    setState(() => _busy = true);
    try {
      await ApiClient.instance.delete('/subscriptions/$_id');
      if (mounted) Navigator.of(context).pop(true);
    } catch (_) {
      if (mounted) {
        setState(() => _busy = false);
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't delete it just now.")));
      }
    }
  }

  Future<bool?> _confirm(String title, String body, String action) => showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: Text(action)),
          ],
        ),
      );

  Future<void> _markPaid(String dueOn) =>
      _act(() => ApiClient.instance.post('/subscriptions/$_id/renewals/$dueOn/paid', {}), done: 'Marked paid.');
  Future<void> _skip(String dueOn) => _act(() => ApiClient.instance.post('/subscriptions/$_id/renewals/$dueOn/skip'), done: 'Skipped.');
  Future<void> _unsay(String dueOn) => _act(() => ApiClient.instance.delete('/subscriptions/$_id/renewals/$dueOn'));
  Future<void> _updatePrice(int amountMinor) =>
      _act(() => ApiClient.instance.patch('/subscriptions/$_id', {'amountMinor': amountMinor}), done: 'Price updated.');

  Future<void> _link(String dueOn) async {
    final picked = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: context.c.sf,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl))),
      builder: (_) => _LinkPaymentSheet(subscriptionId: _id, dueOn: dueOn, name: _sub!.name),
    );
    if (picked != null) {
      await _act(() => ApiClient.instance.post('/subscriptions/$_id/renewals/$dueOn/paid', {'transactionId': picked}), done: 'Linked.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final sub = _sub;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Text(sub?.name ?? 'Subscription'),
        actions: [
          if (sub != null) IconButton(tooltip: 'Edit', onPressed: _busy ? null : _edit, icon: const DsIcon(DsIcons.pencil)),
          if (sub != null)
            PopupMenuButton<String>(
              tooltip: 'More',
              icon: const DsIcon(DsIcons.moreVertical),
              onSelected: (value) => switch (value) {
                'pause' => _pauseOrResume(),
                'cancel' => _cancel(),
                'delete' => _delete(),
                _ => null,
              },
              itemBuilder: (_) => [
                if (sub.status != 'cancelled') PopupMenuItem(value: 'pause', child: Text(sub.isLive ? 'Pause' : 'Resume')),
                PopupMenuItem(
                  value: 'cancel',
                  enabled: sub.status != 'cancelled',
                  child: Text(sub.status == 'cancelled' ? 'Cancelled' : 'Mark cancelled'),
                ),
                const PopupMenuItem(value: 'delete', child: Text('Delete')),
              ],
            ),
          const SizedBox(width: 4),
        ],
      ),
      body: _body(),
    );
  }

  Widget _body() {
    final c = context.c;
    final sub = _sub;
    if (sub == null) {
      if (_failed) {
        return StateBlock(icon: Icons.wifi_off, warn: true, title: "Couldn't load it", body: 'Check your connection and try again.', actionLabel: 'Retry', onAction: _load);
      }
      return const Center(child: DsSpinner());
    }
    final history = [...sub.renewals]..sort((a, b) => b.dueOn.compareTo(a.dueOn));
    String nameOf(String contactId) => _contacts.where((x) => x.id == contactId).firstOrNull?.name ?? 'Someone';

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: kPagePad,
        children: [
          _Hero(sub: sub),
          if (sub.alerts.isNotEmpty) ...[
            const SizedBox(height: kCardGap),
            for (final (i, alert) in sub.alerts.indexed) ...[
              if (i > 0) const SizedBox(height: 8),
              _AlertCard(
                sub: sub,
                alert: alert,
                busy: _busy,
                onMarkPaid: _markPaid,
                onLink: _link,
                onSkip: _skip,
                onUpdatePrice: _updatePrice,
              ),
            ],
          ],
          const SizedBox(height: kCardGap),
          DsCard(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            child: Column(
              children: [
                DsLinkRow(label: 'How often', icon: DsIcons.repeat, value: sub.frequencyLabel),
                DsLinkRow(label: 'Paid with', icon: DsIcons.creditCard, value: sub.paidWithLabel ?? 'Not said'),
                DsLinkRow(label: 'Category', icon: DsIcons.tag, value: sub.categoryName ?? 'None'),
                DsLinkRow(label: 'Started', icon: DsIcons.calendar, value: sub.startedOn.isEmpty ? '—' : dayWords(sub.startedOn)),
                if (sub.trialEndsOn != null) DsLinkRow(label: 'Trial ends', icon: DsIcons.bell, value: dayWords(sub.trialEndsOn!)),
                DsLinkRow(
                  label: 'Reminder',
                  icon: DsIcons.bell,
                  value: sub.remindDaysBefore == 0 ? 'Off' : '${sub.remindDaysBefore} ${sub.remindDaysBefore == 1 ? 'day' : 'days'} before',
                  divider: sub.notes != null,
                ),
                if (sub.notes != null) DsLinkRow(label: 'Notes', icon: DsIcons.message, value: sub.notes, divider: false),
              ],
            ),
          ),
          if (sub.isShared) ...[
            const SizedBox(height: kCardGap),
            DsCard(
              padding: EdgeInsets.zero,
              clip: true,
              child: Column(
                children: [
                  DsSectionHeader('Shared with', meta: 'Your share ${money(sub.myShareMinor)}', padding: const EdgeInsets.fromLTRB(16, 14, 16, 4)),
                  for (final (i, share) in sub.sharedWith.indexed) ...[
                    if (i > 0) const Divider(indent: 16, height: 1),
                    ListTile(
                      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                      leading: DsAvatar(nameOf(share.contactId), size: 36),
                      title: Text(nameOf(share.contactId), style: TextStyle(fontSize: 14, color: c.tx)),
                      trailing: Text(formatMoney(share.amountMinor), style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx)),
                    ),
                  ],
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
                    child: Text('Their parts go on each charge as money owed back, so People keeps the score.', style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                  ),
                ],
              ),
            ),
          ],
          if (sub.priceHistory.length > 1) ...[
            const SizedBox(height: kCardGap),
            DsCard(
              padding: EdgeInsets.zero,
              clip: true,
              child: Column(
                children: [
                  const DsSectionHeader('Price changes', padding: EdgeInsets.fromLTRB(16, 14, 16, 4)),
                  for (final (i, price) in sub.priceHistory.reversed.indexed) ...[
                    if (i > 0) const Divider(indent: 16, height: 1),
                    ListTile(
                      dense: true,
                      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                      title: Text(formatMoney(price.amountMinor), style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx)),
                      trailing: Text(i == 0 ? 'from ${dayWords(price.fromOn)} · now' : 'from ${dayWords(price.fromOn)}', style: TextStyle(fontSize: 12, color: c.tx3)),
                    ),
                  ],
                  const SizedBox(height: 4),
                ],
              ),
            ),
          ],
          const SizedBox(height: kCardGap),
          DsCard(
            padding: EdgeInsets.zero,
            clip: true,
            child: Column(
              children: [
                DsSectionHeader('Renewals', meta: sub.isLive ? 'Next ${dayWords(sub.nextRenewalOn, year: false)}' : null, padding: const EdgeInsets.fromLTRB(16, 14, 16, 4)),
                if (history.isEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                    child: Align(alignment: Alignment.centerLeft, child: Text('Nothing has come due yet.', style: TextStyle(fontSize: 13, color: c.tx3))),
                  ),
                for (final (i, renewal) in history.indexed) ...[
                  if (i > 0) const Divider(indent: 16, height: 1),
                  _RenewalRow(
                    renewal: renewal,
                    sub: sub,
                    busy: _busy,
                    onMarkPaid: () => _markPaid(renewal.dueOn),
                    onLink: () => _link(renewal.dueOn),
                    onSkip: () => _skip(renewal.dueOn),
                    onUnsay: () => _unsay(renewal.dueOn),
                  ),
                ],
                const SizedBox(height: 4),
              ],
            ),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({required this.sub});
  final Subscription sub;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final status = switch (sub.status) {
      'trial' => const DsBadge('Trial', tone: DsTone.ac),
      'paused' => const DsBadge('Paused'),
      'cancelled' => const DsBadge('Cancelled'),
      _ => null,
    };
    final overdue = sub.isLive && sub.daysToRenewal < 0;
    return DsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              DsMonogram(sub.name, size: 48, tone: sub.isLive ? DsTone.ac : DsTone.neutral),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(child: Text(sub.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx))),
                        if (status != null) ...[const SizedBox(width: 8), status],
                      ],
                    ),
                    Text(
                      [sub.frequencyLabel, if (sub.paidWithLabel != null) sub.paidWithLabel!].join(' · '),
                      style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Text(
            formatMoney(sub.amountMinor),
            style: kNum.copyWith(fontSize: 34, height: 40 / 34, fontWeight: FontWeight.w600, letterSpacing: -0.68, color: c.tx),
          ),
          const SizedBox(height: 4),
          Text(
            [
              if (sub.frequencyPreset != 'monthly') '≈ ${money(sub.monthlyMinor)} a month',
              '${money(sub.yearlyMinor)} a year',
              if (sub.isShared) 'your share ${money(sub.myShareMinor)}',
            ].join(' · '),
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              DsIcon(DsIcons.calendar, size: 16, color: overdue ? c.warn : c.tx2),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  sub.isLive ? '${renewalWords(sub)} · ${dayWords(sub.nextRenewalOn)}' : renewalWords(sub),
                  style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w500, color: overdue ? c.warn : c.tx),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// What needs doing, and the buttons that do it.
class _AlertCard extends StatelessWidget {
  const _AlertCard({
    required this.sub,
    required this.alert,
    required this.busy,
    required this.onMarkPaid,
    required this.onLink,
    required this.onSkip,
    required this.onUpdatePrice,
  });

  final Subscription sub;
  final SubscriptionAlert alert;
  final bool busy;
  final ValueChanged<String> onMarkPaid;
  final ValueChanged<String> onLink;
  final ValueChanged<String> onSkip;
  final ValueChanged<int> onUpdatePrice;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final tone = alertTone(alert);
    final (detail, actions) = switch (alert.kind) {
      'missed' || 'overdue' => (
          alert.kind == 'missed'
              ? 'A week on, no payment of about ${money(alert.amountMinor)} has turned up. If it was paid another way, mark it; if the service skipped it, skip it.'
              : 'Charges often land a few days late. If it already went out, link the payment.',
          <Widget>[
            OutlinedButton(key: ValueKey('alert-paid-${alert.dueOn}'), onPressed: busy ? null : () => onMarkPaid(alert.dueOn!), child: const Text('Mark paid')),
            OutlinedButton(onPressed: busy ? null : () => onLink(alert.dueOn!), child: const Text('Link a payment')),
            TextButton(onPressed: busy ? null : () => onSkip(alert.dueOn!), child: const Text('Skipped')),
          ],
        ),
      'price' => (
          'Keep the old price if it was a one-off; update it if the plan has gone up.',
          <Widget>[
            FilledButton.tonal(key: const ValueKey('alert-update-price'), onPressed: busy ? null : () => onUpdatePrice(alert.toMinor), child: Text('Update to ${money(alert.toMinor)}')),
          ],
        ),
      _ => ('${money(alert.amountMinor)} ${sub.frequencyLabel.toLowerCase()} after that, unless you cancel first.', <Widget>[]),
    };
    return DsCard(
      color: tone == DsTone.warn ? c.warnSoft : c.acSoft,
      borderColor: tone == DsTone.warn ? c.warnSoft : c.acSoft,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DsIconTile(alert.kind == 'price' ? DsIcons.trendingUp : (alert.kind == 'trial_ending' ? DsIcons.bell : DsIcons.alertTriangle), tone: tone, onTinted: true, size: 36, iconSize: 18),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(alertWords(sub, alert), style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: tone == DsTone.warn ? c.warn : c.tx)),
                    const SizedBox(height: 2),
                    Text(detail, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2)),
                  ],
                ),
              ),
            ],
          ),
          if (actions.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(spacing: 8, runSpacing: 8, children: actions),
          ],
        ],
      ),
    );
  }
}

class _RenewalRow extends StatelessWidget {
  const _RenewalRow({
    required this.renewal,
    required this.sub,
    required this.busy,
    required this.onMarkPaid,
    required this.onLink,
    required this.onSkip,
    required this.onUnsay,
  });

  final SubscriptionRenewal renewal;
  final Subscription sub;
  final bool busy;
  final VoidCallback onMarkPaid;
  final VoidCallback onLink;
  final VoidCallback onSkip;
  final VoidCallback onUnsay;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (words, badge) = switch (renewal.status) {
      'paid' => (
          'Paid ${money(renewal.amountMinor ?? sub.amountMinor)}'
              '${renewal.paidOn != null && renewal.paidOn != renewal.dueOn ? ' on ${dayWords(renewal.paidOn!, year: false)}' : ''}'
              '${renewal.transactionId == null ? ' · no payment linked' : ''}',
          const DsBadge('Paid', tone: DsTone.good, icon: DsIcons.check),
        ),
      'skipped' => ('Skipped', const DsBadge('Skipped')),
      _ => ('No payment seen', const DsBadge('Missed', tone: DsTone.warn)),
    };
    return ListTile(
      contentPadding: const EdgeInsets.only(left: 16, right: 4),
      title: Text(dayWords(renewal.dueOn), style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: c.tx)),
      subtitle: Text(words, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          badge,
          PopupMenuButton<String>(
            tooltip: 'Change',
            icon: DsIcon(DsIcons.moreVertical, size: 18, color: c.tx3),
            enabled: !busy,
            onSelected: (value) => switch (value) {
              'paid' => onMarkPaid(),
              'link' => onLink(),
              'skip' => onSkip(),
              'unsay' => onUnsay(),
              _ => null,
            },
            itemBuilder: (_) => [
              if (renewal.status != 'paid') const PopupMenuItem(value: 'paid', child: Text('Mark paid')),
              const PopupMenuItem(value: 'link', child: Text('Link a payment')),
              if (renewal.status != 'skipped') const PopupMenuItem(value: 'skip', child: Text('Skipped')),
              const PopupMenuItem(value: 'unsay', child: Text('Open it again')),
            ],
          ),
        ],
      ),
    );
  }
}

/// Payments around the renewal day that could be the one, likeliest first.
class _LinkPaymentSheet extends StatefulWidget {
  const _LinkPaymentSheet({required this.subscriptionId, required this.dueOn, required this.name});
  final String subscriptionId;
  final String dueOn;
  final String name;

  @override
  State<_LinkPaymentSheet> createState() => _LinkPaymentSheetState();
}

class _LinkPaymentSheetState extends State<_LinkPaymentSheet> {
  List<Transaction>? _rows;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _failed = false);
    try {
      final json = await ApiClient.instance.get('/subscriptions/${widget.subscriptionId}/candidates?on=${widget.dueOn}') as List<dynamic>;
      if (mounted) setState(() => _rows = json.map((t) => Transaction.fromJson(t as Map<String, dynamic>)).toList());
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final rows = _rows;
    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 8),
            const DsDragHandle(),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: DsSheetHeader(
                title: 'Which payment was ${widget.name}?',
                subtitle: 'Around ${dayWords(widget.dueOn)}. Likeliest first.',
                icon: DsIcons.link,
                onClose: () => Navigator.of(context).pop(),
              ),
            ),
            Flexible(
              child: rows == null
                  ? Padding(padding: const EdgeInsets.all(24), child: _failed ? DsCallout(tone: DsTone.warn, title: "Couldn't load payments.", action: TextButton(onPressed: _load, child: const Text('Retry'))) : const DsSpinner())
                  : rows.isEmpty
                      ? const Padding(padding: EdgeInsets.all(16), child: DsEmpty(message: 'No payments around that day.', icon: DsIcons.search))
                      : ListView.separated(
                          shrinkWrap: true,
                          padding: const EdgeInsets.fromLTRB(0, 0, 0, 16),
                          itemCount: rows.length,
                          separatorBuilder: (_, __) => const Divider(indent: 16, height: 1),
                          itemBuilder: (_, i) {
                            final t = rows[i];
                            return ListTile(
                              key: ValueKey('candidate-${t.id}'),
                              onTap: () => Navigator.of(context).pop(t.id),
                              contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                              title: Text(t.merchant ?? t.note ?? 'Payment', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: c.tx)),
                              subtitle: Text(
                                [formatDateTime(t.occurredAt), if (t.account != null) t.account!.label].join(' · '),
                                style: TextStyle(fontSize: 12, color: c.tx3),
                              ),
                              trailing: Text(formatMoney(t.amountMinor), style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx)),
                            );
                          },
                        ),
            ),
          ],
        ),
      ),
    );
  }
}
