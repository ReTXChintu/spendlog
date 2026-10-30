import 'package:flutter/material.dart';
import '../../models/metal_models.dart';
import '../../services/api_client.dart';
import '../../utils/format.dart';
import '../../widgets/ds/ds.dart';
import '../../widgets/state_block.dart';

/// Everything the user has invested, in one total: mutual funds at today's
/// NAV, RDs and FDs, gold and silver at today's rate - and the gold and
/// silver they hold, each from the grams they started with plus every
/// purchase since.
class MineTab extends StatefulWidget {
  const MineTab({super.key, required this.onOpenSection});

  /// Opens another section of Invest, by its index.
  final void Function(int section) onOpenSection;

  @override
  State<MineTab> createState() => MineTabState();
}

class MineTabState extends State<MineTab> {
  InvestmentsOverview? _overview;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final json = await ApiClient.instance.get('/investments/overview') as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _overview = InvestmentsOverview.fromJson(json);
          _failed = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  /// Add gold or silver held today; reloads when one was saved.
  Future<void> addHolding() => _edit(null);

  Future<void> _edit(MetalHolding? holding) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: context.c.sf,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl))),
      builder: (_) => _HoldingEditor(holding: holding),
    );
    if (saved == true) await load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final overview = _overview;
    if (overview == null) {
      return _failed
          ? StateBlock(
              icon: Icons.wifi_off,
              warn: true,
              title: "Couldn't load your investments",
              body: 'The connection failed. Check your internet and try again.',
              actionLabel: 'Retry',
              onAction: load,
            )
          : const Center(child: DsSpinner());
    }

    final gain = overview.gainMinor;
    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
        children: [
          DsCard(
            key: const ValueKey('invest-total'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const DsLabel('All your investments'),
                const SizedBox(height: 6),
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(
                    formatMoney(overview.valueMinor),
                    style: kNum.copyWith(fontSize: 30, height: 36 / 30, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 24,
                  runSpacing: 8,
                  children: [
                    DsInlineStat(label: 'Put in', value: formatMoneyShort(overview.investedMinor)),
                    DsInlineStat(
                      label: 'Gain',
                      value: '${gain >= 0 ? '+' : '−'}${formatMoneyShort(gain.abs())}'
                          '${overview.gainPercent == null ? '' : ' (${overview.gainPercent!.toStringAsFixed(1)}%)'}',
                      valueColor: gain > 0 ? c.good : (gain < 0 ? c.crit : null),
                    ),
                  ],
                ),
                if (overview.partial)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      'The gain leaves out gold or silver held before SpendLog with no cost given. Add what it cost '
                      'to count it.',
                      style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                    ),
                  ),
              ],
            ),
          ),
          if (overview.parts.isNotEmpty) ...[
            const SizedBox(height: kCardGap),
            DsCard(
              padding: EdgeInsets.zero,
              clip: true,
              child: Column(
                children: [
                  for (final (i, part) in overview.parts.indexed)
                    _PartRow(
                      part: part,
                      last: i == overview.parts.length - 1,
                      onTap: () => widget.onOpenSection(switch (part.kind) {
                        'FUNDS' => 1,
                        'DEPOSITS' => 4,
                        _ => 2,
                      }),
                    ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 24),
          DsSectionHeader(
            'Gold & silver you hold',
            badge: overview.holdings.isEmpty ? null : DsCountBadge(overview.holdings.length),
          ),
          const SizedBox(height: 8),
          if (overview.holdings.isEmpty)
            DsCard(
              dashed: true,
              onTap: addHolding,
              child: Text(
                'Add what you hold today - digital gold, jewellery, coins - in grams. Each gold buy after that adds '
                'its grams, worked out from that day\'s rate.',
                style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2),
              ),
            )
          else
            for (final (i, holding) in overview.holdings.indexed) ...[
              if (i > 0) const SizedBox(height: kCardGap),
              MetalHoldingCard(holding: holding, onTap: () => _edit(holding)),
            ],
          const SizedBox(height: 16),
          Text(
            'Funds at today\'s NAV, deposits at what they hold, gold and silver at today\'s IBJA rate before GST. To '
            'add a purchase, open the payment and pick "Bought gold".',
            style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
          ),
        ],
      ),
    );
  }
}

class _PartRow extends StatelessWidget {
  const _PartRow({required this.part, required this.onTap, this.last = false});

  final OverviewPart part;
  final VoidCallback onTap;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final gain = part.gainMinor;
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: c.ln))),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(part.label, style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx)),
                  Text(
                    gain == null || gain == 0
                        ? '${part.count} ${part.count == 1 ? 'holding' : 'holdings'}'
                        : '${gain > 0 ? '+' : '−'}${formatMoneyShort(gain.abs())} on ${formatMoneyShort(part.investedMinor!)}',
                    style: kNum.copyWith(
                      fontSize: 12,
                      height: 16 / 12,
                      color: gain == null || gain == 0 ? c.tx3 : (gain > 0 ? c.good : c.crit),
                    ),
                  ),
                ],
              ),
            ),
            Text(formatMoneyShort(part.valueMinor),
                style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w600, color: c.tx)),
            const SizedBox(width: 4),
            DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3),
          ],
        ),
      ),
    );
  }
}

/// One holding: grams, today's value, and what this month added.
class MetalHoldingCard extends StatelessWidget {
  const MetalHoldingCard({super.key, required this.holding, this.onTap});

  final MetalHolding holding;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final gain = holding.gainMinor;
    final foot = [
      formatGrams(holding.grams),
      if (holding.boughtThisMonthGrams > 0) '+${formatGrams(holding.boughtThisMonthGrams)} this month',
      if (gain != null && gain != 0) '${gain > 0 ? '+' : '−'}${formatMoneyShort(gain.abs())}',
      if (!holding.isActive) 'Closed',
    ].join(' · ');
    return DsCard(
      key: ValueKey('holding-${holding.id}'),
      onTap: onTap,
      child: Row(
        children: [
          DsIconTile(DsIcons.piggyBank, tone: holding.isSilver ? DsTone.neutral : DsTone.warn),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(holding.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx)),
                Text(holding.subtitle, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                Text(foot, style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx2)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            holding.valueMinor == null ? '-' : formatMoneyShort(holding.valueMinor!),
            style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
          ),
        ],
      ),
    );
  }
}

/// Add gold or silver held today, or change one.
class _HoldingEditor extends StatefulWidget {
  const _HoldingEditor({this.holding});

  final MetalHolding? holding;

  @override
  State<_HoldingEditor> createState() => _HoldingEditorState();
}

class _HoldingEditorState extends State<_HoldingEditor> {
  late final TextEditingController _name = TextEditingController(text: widget.holding?.name ?? '');
  late final TextEditingController _grams = TextEditingController(
    text: widget.holding == null ? '' : _trim(widget.holding!.openingGrams),
  );
  late final TextEditingController _invested = TextEditingController();
  late final TextEditingController _payee = TextEditingController(text: widget.holding?.payee ?? '');
  late String _purity = widget.holding?.purity ?? '24K';
  late String _kind = widget.holding?.kind ?? 'DIGITAL';
  bool _saving = false;
  String? _error;

  static String _trim(double grams) => grams.toStringAsFixed(4).replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '');

  @override
  void dispose() {
    _name.dispose();
    _grams.dispose();
    _invested.dispose();
    _payee.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final grams = double.tryParse(_grams.text.trim());
    if (name.isEmpty) return setState(() => _error = 'Give it a name, like "Digital gold" or "Wedding jewellery".');
    if (grams == null || grams < 0) return setState(() => _error = 'Enter the grams you hold today, 0 if none yet.');
    final invested = _invested.text.trim().isEmpty ? null : parseRupees(_invested.text);

    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    final existing = widget.holding;
    try {
      final payee = _payee.text.trim().isEmpty ? null : _payee.text.trim();
      if (existing == null) {
        await ApiClient.instance.post('/metals/holdings', {
          'name': name,
          'purity': _purity,
          'kind': _kind,
          'grams': grams,
          'investedMinor': invested,
          'payee': payee,
        });
      } else {
        await ApiClient.instance.patch('/metals/holdings/${existing.id}', {
          'name': name,
          'kind': _kind,
          'openingGrams': grams,
          if (invested != null) 'openingInvestedMinor': invested,
          'payee': payee,
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

  Future<void> _delete() async {
    final navigator = Navigator.of(context);
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this holding?'),
        content: const Text('Its purchases stay as the payments they were.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Delete')),
        ],
      ),
    );
    if (sure != true) return;
    await ApiClient.instance.delete('/metals/holdings/${widget.holding!.id}').catchError((_) {});
    navigator.pop(true);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final existing = widget.holding;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(existing == null ? 'Gold or silver you hold' : 'Edit ${existing.name}',
                style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx)),
            const SizedBox(height: 16),
            if (existing == null) ...[
              DsSegmented<String>(
                segments: const [('24K', '24K'), ('22K', '22K'), ('18K', '18K'), ('SILVER', 'Silver')],
                selected: _purity,
                onChanged: (purity) => setState(() => _purity = purity),
              ),
              const SizedBox(height: 12),
            ],
            DsSegmented<String>(
              segments: const [('DIGITAL', 'Digital'), ('JEWELLERY', 'Jewellery'), ('OTHER', 'Coins/other')],
              selected: _kind,
              onChanged: (kind) => setState(() => _kind = kind),
            ),
            const SizedBox(height: 12),
            DsField(
              label: 'Name',
              child: TextField(
                key: const ValueKey('holding-name'),
                controller: _name,
                textCapitalization: TextCapitalization.sentences,
                decoration: const InputDecoration(hintText: 'Digital gold'),
              ),
            ),
            const SizedBox(height: 12),
            DsField(
              label: existing == null ? 'Grams you hold today' : 'Grams you held at the start',
              child: TextField(
                key: const ValueKey('holding-grams'),
                controller: _grams,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(suffixText: 'g', hintText: '0'),
              ),
            ),
            const SizedBox(height: 12),
            DsField(
              label: existing == null ? 'What it cost you (optional)' : 'What those grams cost (optional)',
              child: TextField(
                key: const ValueKey('holding-invested'),
                controller: _invested,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(prefixText: '₹ ', hintText: 'For the gain'),
              ),
            ),
            const SizedBox(height: 12),
            DsField(
              label: 'Bought from (optional)',
              child: TextField(
                key: const ValueKey('holding-payee'),
                controller: _payee,
                decoration: const InputDecoration(
                  hintText: 'SafeGold, the jeweller',
                  helperText: 'As your bank names them. A payment to them is counted as a purchase by itself.',
                  helperMaxLines: 3,
                ),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: c.crit)),
            ],
            const SizedBox(height: 16),
            FilledButton(onPressed: _saving ? null : _save, child: Text(existing == null ? 'Add' : 'Save')),
            if (existing != null)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: _saving ? null : _delete,
                  style: TextButton.styleFrom(foregroundColor: c.crit),
                  child: const Text('Delete'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
