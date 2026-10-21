import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../services/api_client.dart';
import '../../widgets/ds/ds.dart';
import '../../utils/format.dart';
import '../../widgets/funds/fund_form.dart';
import '../../widgets/funds/fund_text.dart';
import '../../widgets/funds/fund_widgets.dart';
import '../../widgets/funds/sip_history.dart';
import '../../widgets/state_block.dart';
import 'link_sheets.dart';

/// One fund: its NAV over the year, its figures, how it stands in its
/// category, how it's being added to, and every line of its history.
///
/// The caller reloads the portfolio when this closes, whatever happened.
class HoldingDetailScreen extends StatefulWidget {
  const HoldingDetailScreen({
    super.key,
    required this.holdingId,
    this.initial,
    this.rules = const FlagRules(),
    this.peersAvailable = true,
    this.links = const LinkSuggestions(),
  });

  final String holdingId;

  /// The list's copy, to draw the header while the detail loads.
  final FundHolding? initial;
  final FlagRules rules;
  final bool peersAvailable;

  /// The portfolio's suggestions; this fund's are offered here too.
  final LinkSuggestions links;

  @override
  State<HoldingDetailScreen> createState() => _HoldingDetailScreenState();
}

class _HoldingDetailScreenState extends State<HoldingDetailScreen> {
  HoldingDetail? _detail;
  bool _failed = false;
  String? _error;

  /// Suggested debits for this fund, less the ones linked here.
  late List<LinkSuggestion> _suggestions = widget.links.forHolding(widget.holdingId);
  final _busy = <String>{};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final json = await ApiClient.instance.get('/funds/holdings/${widget.holdingId}') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _detail = HoldingDetail.fromJson(json);
        _failed = false;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _failed = true;
          _error = error is ApiException ? error.message : null;
        });
      }
    }
  }

  void _toast(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  String _explain(Object error, String fallback) => error is ApiException && error.message.isNotEmpty ? error.message : fallback;

  /// Runs a change that answers with the holding's detail, and shows it.
  Future<void> _apply(String key, Future<dynamic> Function() call, {String? done, String failed = "Couldn't save that."}) async {
    setState(() => _busy.add(key));
    try {
      final json = await call();
      if (!mounted) return;
      if (json is Map<String, dynamic>) setState(() => _detail = HoldingDetail.fromJson(json));
      if (done != null) _toast(done);
    } catch (error) {
      if (mounted) _toast(_explain(error, failed));
    } finally {
      if (mounted) setState(() => _busy.remove(key));
    }
  }

  Future<void> _link(String transactionId) async {
    await _apply(
      transactionId,
      () => ApiClient.instance.post('/funds/holdings/${widget.holdingId}/link', {'transactionId': transactionId}),
      done: 'Payment linked',
      failed: "Couldn't link that payment.",
    );
    if (mounted && _detail?.txns.any((txn) => txn.transactionId == transactionId) == true) {
      setState(() => _suggestions = _suggestions.where((s) => s.transactionId != transactionId).toList());
    }
  }

  Future<void> _linkAny() async {
    final picked = await pickRecentDebit(context);
    if (picked != null) await _link(picked.id);
  }

  Future<void> _unlink(FundLedgerEntry entry) async {
    final transactionId = entry.transactionId;
    if (transactionId == null) return;
    // The server answers with the detail, but ApiClient.delete drops bodies,
    // so it's fetched again.
    await _apply(
      transactionId,
      () async {
        await ApiClient.instance.delete('/funds/holdings/${widget.holdingId}/link/$transactionId');
        return null;
      },
      failed: "Couldn't unlink that payment.",
    );
    await _load();
  }

  Future<void> _deleteManual(FundLedgerEntry entry) async {
    final txnId = entry.txnId;
    if (txnId == null) return;
    await _apply(
      txnId,
      () async {
        await ApiClient.instance.delete('/funds/holdings/${widget.holdingId}/txns/$txnId');
        return null;
      },
      failed: "Couldn't remove that entry.",
    );
    await _load();
  }

  Future<void> _addManual() async {
    final json = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (_) => _ManualEntryDialog(holdingId: widget.holdingId),
    );
    if (json != null && mounted) setState(() => _detail = HoldingDetail.fromJson(json));
  }

  Future<void> _editTerms(_Terms terms) async {
    final holding = _detail?.holding ?? widget.initial;
    if (holding == null) return;
    final json = await Navigator.of(context).push<Map<String, dynamic>>(
      MaterialPageRoute(builder: (_) => _EditTermsScreen(holding: holding, terms: terms)),
    );
    if (json != null && mounted) setState(() => _detail = HoldingDetail.fromJson(json));
  }

  Future<void> _connectCommitment() async {
    setState(() => _busy.add('commitment'));
    LinkSuggestions links;
    try {
      links = LinkSuggestions.fromJson(await ApiClient.instance.get('/funds/link-suggestions') as Map<String, dynamic>);
    } catch (error) {
      if (mounted) _toast(_explain(error, "Couldn't load your SIP commitments."));
      return;
    } finally {
      if (mounted) setState(() => _busy.remove('commitment'));
    }
    if (!mounted) return;
    final commitments = links.commitments;
    final picked = await showModalBottomSheet<CommitmentSuggestion>(
      context: context,
      useSafeArea: true,
      builder: (context) {
        return ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(0, 0, 0, 16),
          children: [
            const DsDragHandle(),
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: DsSheetHeader(
                title: 'Connect a SIP commitment',
                subtitle: 'Every debit matched to the commitment counts as an instalment of this fund.',
                icon: DsIcons.repeat,
              ),
            ),
            if (commitments.isEmpty)
              const Padding(
                padding: EdgeInsets.all(16),
                child: DsEmpty(
                  icon: DsIcons.repeat,
                  message: 'No SIP commitments to connect. Add one under Settings → Budget → fixed costs, with the kind SIP.',
                ),
              ),
            for (final commitment in commitments)
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                title: Text(commitment.name),
                subtitle: Text(
                  '${formatMoneyShort(commitment.amountMinor)}'
                  '${commitment.dayOfMonth == null ? '' : ' on ${ordinalDay(commitment.dayOfMonth!)}'}'
                  ' · ${commitment.matchedDebits} matched',
                ),
                trailing: commitment.suggestedHoldingId == widget.holdingId ? const FundTag('Likely', tone: TagTone.brand) : null,
                onTap: () => Navigator.of(context).pop(commitment),
              ),
          ],
        );
      },
    );
    if (picked == null) return;
    await _apply(
      'commitment',
      () => ApiClient.instance.patch('/funds/holdings/${widget.holdingId}', {'commitmentId': picked.commitmentId}),
      done: 'SIP connected',
      failed: "Couldn't connect that SIP.",
    );
  }

  String get _sipPath => '/funds/holdings/${widget.holdingId}/sip';

  /// A step-up or step-down from a month.
  Future<void> _changeAmount() async {
    final sip = _detail?.holding.sip;
    if (sip == null) return;
    final body = await showDialog<Map<String, dynamic>>(context: context, builder: (_) => SipChangeDialog(sip: sip));
    if (body == null || !mounted) return;
    await _apply(
      'sip-change',
      () => ApiClient.instance.post('$_sipPath/change', body),
      done: 'SIP amount changed from ${sipMonthLabel(body['fromOn'] as String)}',
      failed: "Couldn't change the amount.",
    );
  }

  /// A month tapped on the timeline: skipped, or the skip taken back.
  Future<void> _toggleMonth(SipPlanMonth month) async {
    final label = sipMonthLabel(month.month);
    if (month.linkedTransactionId != null) {
      _toast('A payment is linked to $label. Unlink it in the history to skip the month.');
      return;
    }
    if (month.covered) {
      _toast('$label is inside the opening balance, so skipping it changes nothing.');
      return;
    }
    final key = 'month-${month.month}';
    if (month.isSkipped) {
      // ApiClient.delete drops the body, so the detail is fetched again.
      await _apply(
        key,
        () async {
          await ApiClient.instance.delete('$_sipPath/skip/${month.month}');
          return null;
        },
        done: '$label counted again',
        failed: "Couldn't take that skip back.",
      );
      await _load();
    } else {
      await _apply(
        key,
        () => ApiClient.instance.post('$_sipPath/skip', {'month': month.month}),
        done: '$label marked skipped',
        failed: "Couldn't skip that month.",
      );
    }
  }

  Future<void> _pause() async {
    final sip = _detail?.holding.sip;
    if (sip == null) return;
    final body = await showDialog<Map<String, dynamic>>(context: context, builder: (_) => SipPauseDialog(sip: sip));
    if (body == null || !mounted) return;
    await _apply(
      'sip-pause',
      () => ApiClient.instance.post('$_sipPath/pause', body),
      done: 'SIP paused from ${sipMonthLabel(body['fromOn'] as String)}',
      failed: "Couldn't pause the SIP.",
    );
  }

  Future<void> _resume() => _apply(
        'sip-pause',
        () => ApiClient.instance.post('$_sipPath/resume', {}),
        done: 'SIP resumed',
        failed: "Couldn't resume the SIP.",
      );

  Future<void> _disconnectCommitment() => _apply(
        'commitment',
        () => ApiClient.instance.patch('/funds/holdings/${widget.holdingId}', {'commitmentId': null}),
        done: 'SIP disconnected',
      );

  Future<void> _delete() async {
    final holding = _detail?.holding ?? widget.initial;
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove this fund?'),
        content: Text(
          '${holding == null ? 'It' : shortSchemeName(holding.schemeName)} comes off your portfolio and any goals, '
          'with its history. Linked payments stay in your transactions, untouched.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            // The final, destructive confirm (§7.1): critFill with white text.
            style: FilledButton.styleFrom(backgroundColor: context.c.critFill, foregroundColor: Colors.white),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    final navigator = Navigator.of(context);
    try {
      await ApiClient.instance.delete('/funds/holdings/${widget.holdingId}');
      navigator.pop(true);
    } catch (error) {
      if (mounted) _toast(_explain(error, "Couldn't remove that fund."));
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final holding = _detail?.holding ?? widget.initial;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Text(
          holding == null ? 'Fund' : shortSchemeName(holding.schemeName),
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontWeight: FontWeight.w600, fontSize: 19, height: 24 / 19, color: c.tx),
        ),
        actions: [
          PopupMenuButton<String>(
            tooltip: 'More',
            icon: DsIcon(DsIcons.moreVertical, size: 20, color: c.tx2),
            onSelected: (choice) {
              switch (choice) {
                case 'sip':
                  _editTerms(_Terms.sip);
                case 'opening':
                  _editTerms(_Terms.opening);
                case 'link':
                  _linkAny();
                case 'manual':
                  _addManual();
                case 'delete':
                  _delete();
              }
            },
            itemBuilder: (_) => [
              PopupMenuItem(value: 'sip', child: Text(holding?.sip == null ? 'Add a SIP' : 'Edit SIP')),
              PopupMenuItem(
                value: 'opening',
                child: Text(holding?.opening == null ? 'Add units already held' : 'Edit units already held'),
              ),
              const PopupMenuItem(value: 'link', child: Text('Link a payment')),
              const PopupMenuItem(value: 'manual', child: Text('Add a buy or redemption')),
              const PopupMenuItem(value: 'delete', child: Text('Remove fund')),
            ],
          ),
        ],
      ),
      body: _body(),
    );
  }

  Widget _body() {
    final detail = _detail;
    if (detail == null) {
      if (_failed) {
        return StateBlock(
          icon: Icons.wifi_off,
          warn: true,
          title: "Couldn't load this fund",
          body: _error ?? 'The connection failed. Check your internet and try again.',
          actionLabel: 'Retry',
          onAction: () {
            setState(() => _failed = false);
            _load();
          },
        );
      }
      return const Center(child: DsSpinner());
    }

    final c = context.c;
    final h = detail.holding;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          if (detail.navError != null || h.stale) ...[
            FundBanner(
              icon: DsIcons.refresh,
              tone: TagTone.neutral,
              actionLabel: 'Retry',
              onTap: _load,
              text: [
                h.nav == null ? 'No NAV yet' : 'NAV as of ${formatIsoLongDate(h.nav!.day)}',
                if (detail.navError != null) "couldn't refresh: ${detail.navError}",
              ].join(' · '),
            ),
            const SizedBox(height: 12),
          ],
          _Header(holding: h),
          const SizedBox(height: kCardGap),
          _SparklineCard(points: detail.sparkline),
          const SizedBox(height: kCardGap),
          _StatsCard(holding: h),
          if (h.flags.isNotEmpty) ...[
            const SizedBox(height: 24),
            const FundSectionHeader(title: 'Worth a look'),
            const SizedBox(height: 12),
            for (final flag in h.flags) ...[
              FlagNote(holding: h, flag: flag, rules: widget.rules, explain: true),
              const SizedBox(height: 8),
            ],
          ],
          const SizedBox(height: 24),
          FundSectionHeader(title: 'In its category · ${h.categoryLabel}'),
          const SizedBox(height: 12),
          _PeersCard(holding: h, peersAvailable: widget.peersAvailable),
          const SizedBox(height: 24),
          const FundSectionHeader(title: "How it's tracked"),
          const SizedBox(height: 12),
          _TermsCard(
            holding: h,
            commitmentBusy: _busy.contains('commitment'),
            onEditSip: () => _editTerms(_Terms.sip),
            onEditOpening: () => _editTerms(_Terms.opening),
            onConnect: _connectCommitment,
            onDisconnect: _disconnectCommitment,
          ),
          if (h.sip != null) ...[
            const SizedBox(height: 24),
            const FundSectionHeader(title: 'SIP history'),
            const SizedBox(height: 12),
            SipHistoryCard(
              sip: h.sip!,
              plan: detail.sipPlan,
              paused: sipHasPauseAhead(h.sip!, istToday()),
              busy: _busy,
              onChangeAmount: _changeAmount,
              onPause: _pause,
              onResume: _resume,
              onTapMonth: _toggleMonth,
            ),
          ],
          if (_suggestions.isNotEmpty) ...[
            const SizedBox(height: 24),
            FundSectionHeader(title: 'Payments that look like this SIP', count: _suggestions.length),
            const SizedBox(height: 12),
            for (final suggestion in _suggestions) ...[
              DebitRow(
                merchant: suggestion.merchant,
                occurredAt: suggestion.occurredAt,
                amountMinor: suggestion.amountMinor,
                detail: suggestion.reasons.map(linkReasonLabel).join(' · '),
                busy: _busy.contains(suggestion.transactionId),
                actionLabel: 'Link',
                onAction: () => _link(suggestion.transactionId),
              ),
              const SizedBox(height: 8),
            ],
          ],
          const SizedBox(height: 24),
          FundSectionHeader(title: 'History', count: detail.txns.length),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                style: _smallButton,
                onPressed: _linkAny,
                icon: const DsIcon(DsIcons.link, size: 18),
                label: const Text('Link a payment'),
              ),
              OutlinedButton.icon(
                style: _smallButton,
                onPressed: _addManual,
                icon: const DsIcon(DsIcons.plus, size: 18),
                label: const Text('Buy or redemption'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (detail.txns.isEmpty)
            const DsEmpty(
              icon: DsIcons.list,
              message: 'Nothing yet. Add units you already hold or a SIP, or link the payments that bought it.',
            )
          else
            FundCard(
              padding: EdgeInsets.zero,
              child: Column(
                children: [
                  for (final (i, entry) in detail.txns.indexed) ...[
                    if (i > 0) Divider(height: 1, color: c.ln),
                    LedgerRow(
                      entry: entry,
                      busy: _busy.contains(entry.transactionId) || _busy.contains(entry.txnId),
                      onUnlink: entry.kind == FundTxnKind.linked && entry.via == 'link' ? () => _unlink(entry) : null,
                      onDelete: entry.isManual && entry.txnId != null ? () => _deleteManual(entry) : null,
                    ),
                  ],
                ],
              ),
            ),
          const SizedBox(height: 24),
          // Destructive (§7.1): transparent, crit text, critSoft border, trash.
          OutlinedButton.icon(
            style: OutlinedButton.styleFrom(
              minimumSize: const Size(64, 48),
              backgroundColor: Colors.transparent,
              foregroundColor: c.crit,
              side: BorderSide(color: c.critSoft),
              textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 15, fontWeight: FontWeight.w600),
            ),
            onPressed: _delete,
            icon: const DsIcon(DsIcons.trash, size: 18),
            label: const Text('Remove fund'),
          ),
        ],
      ),
    );
  }
}

/// The 40 h secondary button used for row and section actions.
final ButtonStyle _smallButton = OutlinedButton.styleFrom(
  minimumSize: const Size(0, 40),
  padding: const EdgeInsets.symmetric(horizontal: 14),
  textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 14, fontWeight: FontWeight.w600),
);

class _Header extends StatelessWidget {
  const _Header({required this.holding});

  final FundHolding holding;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final h = holding;
    final nav = h.nav;
    return FundCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const DsLabel('Fund detail'),
          const SizedBox(height: 4),
          Text(
            h.schemeName,
            style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
          ),
          const SizedBox(height: 2),
          Text(
            [if (h.fundHouse != null) h.fundHouse!, h.categoryLabel].join(' · '),
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              ...schemeTags(isDirect: h.isDirect, isRegular: h.isRegular, isGrowth: h.isGrowth),
              FundTag(assetClassLabel(h.assetClass), tone: TagTone.brand),
              if (h.folio != null) FundTag('Folio ${h.folio}'),
            ],
          ),
          const SizedBox(height: 16),
          Divider(height: 1, color: c.ln),
          const SizedBox(height: 16),
          const DsLabel('Value today'),
          const SizedBox(height: 2),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              formatMoney(h.valueMinor),
              style: kNum.copyWith(fontSize: 28, height: 34 / 28, fontWeight: FontWeight.w600, letterSpacing: -0.56, color: c.tx),
            ),
          ),
          const SizedBox(height: 4),
          Wrap(
            spacing: 12,
            runSpacing: 2,
            children: [
              Text(
                '${signedMoneyShort(h.gainMinor)} (${fundPercent(h.gainPercent, signed: true)}) overall',
                style: kNum.copyWith(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: gainColor(c, h.gainMinor)),
              ),
              Text(
                '${signedMoneyShort(h.dayChangeMinor)} (${fundPercent(h.dayChangePercent, signed: true, digits: 2)}) today',
                style: kNum.copyWith(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: gainColor(c, h.dayChangeMinor)),
              ),
            ],
          ),
          if (nav != null) ...[
            const SizedBox(height: 6),
            Text(
              'NAV ₹${nav.nav.toStringAsFixed(4)} on ${formatIsoLongDate(nav.day)}',
              style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
          ],
        ],
      ),
    );
  }
}

class _SparklineCard extends StatelessWidget {
  const _SparklineCard({required this.points});

  final List<NavPoint> points;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final change = points.length >= 2 && points.first.nav > 0 ? (points.last.nav / points.first.nav - 1) * 100 : null;
    return FundCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'NAV over the year',
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
              ),
              if (change != null)
                Text(
                  fundPercent(change, signed: true),
                  style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: gainColor(c, change)),
                ),
            ],
          ),
          const SizedBox(height: 12),
          NavSparkline(points: points, height: 120),
          if (points.length >= 2) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                Text(formatIsoLongDate(points.first.day), style: kNum.copyWith(fontSize: 11, height: 14 / 11, color: c.tx3)),
                const Spacer(),
                Text(formatIsoLongDate(points.last.day), style: kNum.copyWith(fontSize: 11, height: 14 / 11, color: c.tx3)),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _StatsCard extends StatelessWidget {
  const _StatsCard({required this.holding});

  final FundHolding holding;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final h = holding;
    return FundCard(
      child: StatGrid(cells: [
        StatCell(label: 'Invested', value: formatMoneyShort(h.investedMinor)),
        StatCell(
          label: 'Gain',
          value: signedMoneyShort(h.gainMinor),
          sub: fundPercent(h.gainPercent, signed: true),
          color: gainColor(c, h.gainMinor),
        ),
        StatCell(
          label: 'XIRR (a year)',
          value: h.xirrPercent == null ? '—' : fundPercent(h.xirrPercent),
          sub: h.xirrPercent == null ? 'After 3 months held' : null,
          color: h.xirrPercent == null ? null : gainColor(c, h.xirrPercent),
        ),
        StatCell(label: 'Units', value: h.units.toStringAsFixed(3)),
        StatCell(label: 'Put in, all told', value: formatMoneyShort(h.totalInvestedMinor)),
        StatCell(label: 'Held for', value: h.firstOn == null ? '—' : heldFor(h.heldDays)),
        if (h.realisedGainMinor != 0)
          StatCell(
            label: 'Realised on redemptions',
            value: signedMoneyShort(h.realisedGainMinor),
            color: gainColor(c, h.realisedGainMinor),
          ),
        StatCell(label: 'Going in monthly', value: h.monthlySipMinor > 0 ? formatMoneyShort(h.monthlySipMinor) : '—'),
      ]),
    );
  }
}

/// The fund's 1y and 3y returns against its category's median and average.
class _PeersCard extends StatelessWidget {
  const _PeersCard({required this.holding, required this.peersAvailable});

  final FundHolding holding;
  final bool peersAvailable;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final peers = holding.peers;
    if (peers == null) {
      if (!peersAvailable) return const RanksComingNote();
      return FundCard(
        child: Text(
          'No category to compare it with: too few similar funds, or it is too young for a 1-year return.',
          style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
        ),
      );
    }

    final head = TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.tx2);
    final divider = BoxDecoration(border: Border(top: BorderSide(color: c.ln)));
    TableRow row(String label, double? own, PeerStats stats, bool basis) {
      final cell = kNum.copyWith(fontSize: 14, fontWeight: basis ? FontWeight.w600 : FontWeight.w400, color: c.tx);
      final median = stats.medianPercent;
      final ownColour = own == null || median == null ? c.tx : (own >= median ? c.good : c.crit);
      return TableRow(decoration: divider, children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Text(label, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: c.tx2)),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Text(
            fundPercent(own),
            textAlign: TextAlign.right,
            style: cell.copyWith(color: ownColour, fontWeight: FontWeight.w600),
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Text(fundPercent(median), textAlign: TextAlign.right, style: cell),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Text(fundPercent(stats.averagePercent), textAlign: TextAlign.right, style: cell),
        ),
      ]);
    }

    final rank = peers.rank;
    final basisName = peers.basis == '3y' ? '3-year' : '1-year';
    return FundCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Table(
            columnWidths: const {0: FlexColumnWidth(1.1), 1: FlexColumnWidth(1.2), 2: FlexColumnWidth(1.2), 3: FlexColumnWidth(1.2)},
            children: [
              TableRow(children: [
                Padding(padding: const EdgeInsets.only(bottom: 8), child: Text('Return', style: head)),
                Text('This fund', textAlign: TextAlign.right, style: head),
                Text('Median', textAlign: TextAlign.right, style: head),
                Text('Average', textAlign: TextAlign.right, style: head),
              ]),
              row('1 year', holding.oneYearPercent, peers.oneYear, peers.basis == '1y'),
              row('3 years', holding.threeYearPercent, peers.threeYear, peers.basis == '3y'),
            ],
          ),
          const SizedBox(height: 8),
          if (rank != null)
            Wrap(
              spacing: 8,
              runSpacing: 6,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                DsBadge(rankLine(rank), tone: rank.percentile >= 50 ? DsTone.good : DsTone.crit),
                Text(
                  'on $basisName returns · beats ${rank.percentile}% of its category',
                  style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx2),
                ),
              ],
            )
          else
            Text(
              'Too young to rank: a rank needs at least a 1-year return.',
              style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
            ),
          const SizedBox(height: 8),
          Text(
            '${peers.threeYear.count > 0 ? peers.threeYear.count : peers.oneYear.count} funds in the category. '
            'Returns are a year, compounded, from NAVs alone.',
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
        ],
      ),
    );
  }
}

class _TermsCard extends StatelessWidget {
  const _TermsCard({
    required this.holding,
    required this.commitmentBusy,
    required this.onEditSip,
    required this.onEditOpening,
    required this.onConnect,
    required this.onDisconnect,
  });

  final FundHolding holding;
  final bool commitmentBusy;
  final VoidCallback onEditSip;
  final VoidCallback onEditOpening;
  final VoidCallback onConnect;
  final VoidCallback onDisconnect;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final sip = holding.sip;
    final opening = holding.opening;

    Widget line(Object icon, String title, String body, String action, VoidCallback? onTap,
        {bool busy = false, bool last = false}) {
      return Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: c.ln))),
        child: Row(
          children: [
            DsIconTile(icon),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx)),
                  Text(body, style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3)),
                ],
              ),
            ),
            if (busy)
              const Padding(
                padding: EdgeInsets.all(12),
                child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
              )
            else
              TextButton(onPressed: onTap, child: Text(action)),
          ],
        ),
      );
    }

    return FundCard(
      padding: const EdgeInsets.fromLTRB(16, 4, 8, 4),
      child: Column(
        children: [
          line(
            DsIcons.repeat,
            'SIP',
            sip == null
                ? 'None set'
                : [
                    sipLine(sip),
                    'since ${formatIsoLongDate(sip.startOn)}',
                    if (sip.endOn != null) 'until ${formatIsoLongDate(sip.endOn!)}',
                    if (holding.sipPaused) 'paused' else if (!holding.sipRunning) 'stopped',
                  ].join(' · '),
            sip == null ? 'Add' : 'Edit',
            onEditSip,
          ),
          line(
            DsIcons.banknote,
            'Units already held',
            opening == null
                ? 'None set'
                : '${opening.units.toStringAsFixed(3)} units for ${formatMoneyShort(opening.investedMinor)} '
                    'as of ${formatIsoLongDate(opening.asOf)}',
            opening == null ? 'Add' : 'Edit',
            onEditOpening,
          ),
          line(
            DsIcons.link,
            'SIP commitment',
            holding.commitmentId == null
                ? 'Not connected. Connect one and its matched debits count as instalments.'
                : 'Connected: debits matched to it count as instalments.',
            holding.commitmentId == null ? 'Connect' : 'Disconnect',
            holding.commitmentId == null ? onConnect : onDisconnect,
            busy: commitmentBusy,
            last: true,
          ),
        ],
      ),
    );
  }
}

/// One line of history: what, when, at what NAV, and how much.
class LedgerRow extends StatelessWidget {
  const LedgerRow({super.key, required this.entry, this.busy = false, this.onUnlink, this.onDelete});

  final FundLedgerEntry entry;
  final bool busy;
  final VoidCallback? onUnlink;
  final VoidCallback? onDelete;

  static String title(FundLedgerEntry entry) => switch (entry.kind) {
        FundTxnKind.opening => 'Opening balance',
        FundTxnKind.sipScheduled => 'SIP instalment (scheduled)',
        FundTxnKind.linked => entry.via == 'commitment' ? 'SIP debit, from the commitment' : 'Linked payment',
        FundTxnKind.redeem => 'Redeemed',
        _ => 'Bought',
      };

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (Object icon, DsTone tone) = switch (entry.kind) {
      FundTxnKind.opening => (Icons.inventory_2_outlined, DsTone.neutral),
      FundTxnKind.sipScheduled => (DsIcons.repeat, DsTone.ac),
      FundTxnKind.linked => (DsIcons.link, DsTone.ac),
      FundTxnKind.redeem => (DsIcons.arrowDownLeft, DsTone.good),
      _ => (DsIcons.plus, DsTone.neutral),
    };
    final nav = entry.nav;
    final detail = [
      formatIsoLongDate(entry.on),
      if (!entry.pending && nav != null && entry.units > 0)
        '${entry.units.toStringAsFixed(3)} units at ₹${nav.toStringAsFixed(4)}'
            '${entry.navDay != null && entry.navDay != entry.on ? ' (${formatIsoShortDate(entry.navDay!)})' : ''}',
    ].join(' · ');
    final amount = entry.kind == FundTxnKind.redeem ? '−${formatMoney(entry.amountMinor)}' : formatMoney(entry.amountMinor);

    final row = Padding(
      padding: EdgeInsets.fromLTRB(16, 12, onUnlink != null || onDelete != null ? 4 : 16, 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DsIconTile(icon, tone: tone, size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title(entry), style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx)),
                Text(detail, style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3)),
                if (entry.pending) ...[
                  const SizedBox(height: 6),
                  const FundTag('Waiting for NAV', tone: TagTone.warn),
                ] else if (entry.note != null && (!entry.counted || entry.inSkippedMonth || entry.differsFromPlan)) ...[
                  const SizedBox(height: 2),
                  Text(entry.note!, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                ],
              ],
            ),
          ),
          const SizedBox(width: 8),
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Text(
              entry.amountMinor > 0 || entry.kind != FundTxnKind.redeem ? amount : '${entry.units.toStringAsFixed(3)} u',
              style: kNum.copyWith(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: c.tx),
            ),
          ),
          if (busy)
            const Padding(
              padding: EdgeInsets.fromLTRB(12, 2, 12, 0),
              child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
            )
          else if (onUnlink != null)
            IconButton(
              tooltip: 'Unlink',
              visualDensity: VisualDensity.compact,
              icon: Icon(Icons.link_off, size: 18, color: c.tx3),
              onPressed: onUnlink,
            )
          else if (onDelete != null)
            IconButton(
              tooltip: 'Remove',
              visualDensity: VisualDensity.compact,
              icon: DsIcon(DsIcons.trash, size: 18, color: c.tx3),
              onPressed: onDelete,
            ),
        ],
      ),
    );

    // Inside the opening snapshot: shown, but greyed, since it's not counted twice.
    return entry.counted || entry.pending ? row : Opacity(opacity: 0.5, child: row);
  }
}

enum _Terms { sip, opening }

/// The SIP, or the units already held, on their own - to change, or to remove.
/// Pops the holding's detail as the server sends it back.
class _EditTermsScreen extends StatefulWidget {
  const _EditTermsScreen({required this.holding, required this.terms});

  final FundHolding holding;
  final _Terms terms;

  @override
  State<_EditTermsScreen> createState() => _EditTermsScreenState();
}

class _EditTermsScreenState extends State<_EditTermsScreen> {
  late final _fields = FundFormFields(
    sip: widget.holding.sip,
    opening: widget.holding.opening,
    folio: widget.holding.folio,
  );
  bool _saving = false;
  String? _error;

  bool get _isSip => widget.terms == _Terms.sip;
  bool get _exists => _isSip ? widget.holding.sip != null : widget.holding.opening != null;

  @override
  void initState() {
    super.initState();
    // Only the section being edited is checked and sent.
    _fields.runsSip = _isSip;
    _fields.holdsUnits = !_isSip;
    _fields.sipStart ??= istToday();
  }

  @override
  void dispose() {
    _fields.dispose();
    super.dispose();
  }

  Future<void> _send(Map<String, dynamic> body) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    try {
      final json = await ApiClient.instance.patch('/funds/holdings/${widget.holding.id}', body);
      navigator.pop(json is Map<String, dynamic> ? json : null);
    } catch (error) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = error is ApiException ? error.message : "Couldn't save that.";
        });
      }
    }
  }

  Future<void> _save() async {
    final check = _fields.data.check(istToday());
    if (!check.ok) {
      setState(() => _error = check.error);
      return;
    }
    final folioChanged = check.folio != widget.holding.folio;
    await _send({
      if (_isSip) 'sip': check.sip else 'opening': check.opening,
      if (folioChanged) 'folio': check.folio,
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Text(
          _isSip ? (_exists ? 'Edit SIP' : 'Add a SIP') : (_exists ? 'Units already held' : 'Add units already held'),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          Text(
            shortSchemeName(widget.holding.schemeName),
            style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
          ),
          const SizedBox(height: 12),
          ToggleSection(
            icon: _isSip ? DsIcons.repeat : DsIcons.banknote,
            title: _isSip ? 'SIP' : 'Units already held',
            subtitle: _isSip ? 'An amount each month on the same day, with any changes along the way.' : 'From a statement, as of a day.',
            on: true,
            onChanged: null,
            child: _isSip
                ? SipFields(fields: _fields, showActive: _exists, onChanged: () => setState(() {}))
                : OpeningFields(fields: _fields, onChanged: () => setState(() {})),
          ),
          const SizedBox(height: 16),
          LabelledField(label: 'Folio number (optional)', controller: _fields.folio),
          if (_error != null) ...[
            const SizedBox(height: 12),
            DsCallout(tone: DsTone.crit, title: _error!),
          ],
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Save'),
          ),
          if (_exists) ...[
            const SizedBox(height: 8),
            TextButton.icon(
              style: TextButton.styleFrom(foregroundColor: c.crit, minimumSize: const Size(48, 48)),
              onPressed: _saving ? null : () => _send({if (_isSip) 'sip': null else 'opening': null}),
              icon: const DsIcon(DsIcons.trash, size: 18),
              label: Text(_isSip ? 'Remove the SIP' : 'Remove the units held'),
            ),
            Text(
              _isSip
                  ? 'Removing it drops every scheduled instalment. To keep what went in, turn off "Still running" '
                      'instead.'
                  : 'Removing it takes those units off the fund. Linked payments and SIP instalments stay.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
          ],
        ],
      ),
    );
  }
}

/// A one-off purchase SpendLog never saw, or a redemption.
class _ManualEntryDialog extends StatefulWidget {
  const _ManualEntryDialog({required this.holdingId});

  final String holdingId;

  @override
  State<_ManualEntryDialog> createState() => _ManualEntryDialogState();
}

class _ManualEntryDialogState extends State<_ManualEntryDialog> {
  String _kind = FundTxnKind.manualBuy;
  String _on = istToday();
  final _amount = TextEditingController();
  final _units = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    _units.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final amountMinor = _amount.text.trim().isEmpty ? null : parseRupees(_amount.text);
    final units = _units.text.trim().isEmpty ? null : double.tryParse(_units.text.replaceAll(',', '').trim());
    if ((_amount.text.trim().isNotEmpty && amountMinor == null) || (_units.text.trim().isNotEmpty && units == null)) {
      setState(() => _error = 'That amount or number of units is not a number.');
      return;
    }
    if ((amountMinor ?? 0) <= 0 && (units ?? 0) <= 0) {
      setState(() => _error = 'Give an amount or units. The other comes from that day\'s NAV.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    try {
      final json = await ApiClient.instance.post('/funds/holdings/${widget.holdingId}/txns', {
        'kind': _kind,
        'on': _on,
        if ((amountMinor ?? 0) > 0) 'amountMinor': amountMinor,
        if ((units ?? 0) > 0) 'units': units,
      });
      navigator.pop(json is Map<String, dynamic> ? json : null);
    } catch (error) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = error is ApiException ? error.message : "Couldn't add that.";
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return AlertDialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      title: const Text('Add a buy or redemption'),
      content: SizedBox(
        width: double.maxFinite,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              DsSegmented<String>(
                segments: const [(FundTxnKind.manualBuy, 'Bought'), (FundTxnKind.redeem, 'Redeemed')],
                selected: _kind,
                onChanged: (kind) => setState(() => _kind = kind),
              ),
              const SizedBox(height: 16),
              DateField(
                label: 'On',
                value: _on,
                onPick: () async {
                  final picked = await pickIsoDate(context, initial: _on, first: DateTime(1990), last: DateTime.parse(istToday()));
                  if (picked != null) setState(() => _on = picked);
                },
              ),
              const SizedBox(height: 14),
              LabelledField(
                label: 'Amount',
                controller: _amount,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                prefix: '₹ ',
              ),
              const SizedBox(height: 14),
              LabelledField(
                label: 'Units (optional)',
                controller: _units,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
              ),
              const SizedBox(height: 8),
              Text(
                _kind == FundTxnKind.redeem
                    ? 'Redeeming everything? Give the units. Gains on what you sold show as realised.'
                    : 'For a purchase SpendLog never saw. If the payment is in your transactions, link it instead.',
                style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                DsCallout(tone: DsTone.crit, title: _error!),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _saving ? null : _save, child: const Text('Add')),
      ],
    );
  }
}
