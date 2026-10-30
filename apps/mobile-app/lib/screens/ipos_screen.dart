import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/ipo_models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';

/// IPOs open now, coming up, and closed but not yet listed, each with what
/// one lot costs and what today's grey market premium would make of it.
///
/// The premium is unofficial and moves daily, so the figure is worded as
/// arithmetic on today's number, never as a forecast. The data is IPO
/// Guru's, fetched and cached by the server: their key stays there, and
/// their free plan's ten calls a day are shared by everyone.
class IposScreen extends StatefulWidget {
  const IposScreen({super.key, this.embedded = false});

  /// A section of Invest, under its own title: no app bar.
  final bool embedded;

  @override
  State<IposScreen> createState() => _IposScreenState();
}

/// The chips above the list.
enum _Board { all, mainboard, sme }

class _IposScreenState extends State<IposScreen> {
  IpoList? _data;
  bool _failed = false;
  String? _error;
  _Board _board = _Board.all;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final json = await ApiClient.instance.get('/ipos') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _data = IpoList.fromJson(json);
        _failed = false;
        _error = null;
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

  Future<void> _retry() async {
    setState(() {
      _failed = false;
      _data = null;
    });
    await _load();
  }

  List<Ipo> _filter(List<Ipo> rows) {
    switch (_board) {
      case _Board.all:
        return rows;
      case _Board.mainboard:
        return rows.where((ipo) => !ipo.isSme).toList();
      case _Board.sme:
        return rows.where((ipo) => ipo.isSme).toList();
    }
  }

  Future<void> _openPage(Ipo ipo) async {
    final url = ipo.webUrl;
    if (url == null) return;
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    try {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } catch (_) {
      // No browser to hand it to; the card already says everything we know.
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    if (widget.embedded) return ColoredBox(color: c.bg, child: _body());
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('IPOs')),
      body: _body(),
    );
  }

  Widget _body() {
    final c = context.c;

    if (_failed) {
      return StateBlock(
        icon: Icons.wifi_off,
        warn: true,
        title: "Couldn't load IPOs",
        body: _error ?? 'The connection failed. Check your internet and try again.',
        actionLabel: 'Retry',
        onAction: _retry,
      );
    }

    final data = _data;
    if (data == null) return const Center(child: DsSpinner());

    if (!data.available) {
      return const StateBlock(
        icon: Icons.show_chart,
        title: "IPOs aren't set up on the server yet",
        body: 'The server needs an IPO Guru API key before it can show the IPO calendar.',
      );
    }

    if (data.isEmpty) {
      // Never fetched successfully, so there is nothing stale to fall back on.
      if (data.error != null) {
        return StateBlock(
          icon: Icons.wifi_off,
          warn: true,
          title: "Couldn't load IPOs",
          body: data.error!,
          actionLabel: 'Retry',
          onAction: _retry,
        );
      }
      return StateBlock(
        icon: Icons.show_chart,
        title: 'No IPOs open or coming up right now',
        body: 'New issues show here once they are announced, and stay until they list.',
        actionLabel: 'Refresh',
        onAction: _retry,
      );
    }

    final sections = [
      ('Open now', _filter(data.open)),
      ('Upcoming', _filter(data.upcoming)),
      ('Waiting to list', _filter(data.closed)),
    ];
    final nothingShown = sections.every((section) => section.$2.isEmpty);

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: kPagePad,
        children: [
          if (data.stale || data.error != null) ...[
            _StaleBanner(fetchedAt: data.fetchedAt, failed: data.error != null),
            const SizedBox(height: 12),
          ],
          // Chips scroll sideways rather than wrap on a phone.
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _BoardChip(label: 'All', on: _board == _Board.all, onTap: () => setState(() => _board = _Board.all)),
                const SizedBox(width: 8),
                _BoardChip(
                  label: 'Mainboard',
                  on: _board == _Board.mainboard,
                  onTap: () => setState(() => _board = _Board.mainboard),
                ),
                const SizedBox(width: 8),
                _BoardChip(label: 'SME', on: _board == _Board.sme, onTap: () => setState(() => _board = _Board.sme)),
              ],
            ),
          ),
          if (nothingShown)
            Padding(
              padding: const EdgeInsets.only(top: 16),
              child: DsEmpty(
                icon: DsIcons.trendingUp,
                message: _board == _Board.sme
                    ? 'No SME IPOs open or coming up right now.'
                    : 'No mainboard IPOs open or coming up right now.',
              ),
            ),
          for (final (title, rows) in sections)
            if (rows.isNotEmpty) ...[
              const SizedBox(height: 20),
              _SectionHeader(title: title, count: rows.length),
              const SizedBox(height: 8),
              for (final (i, ipo) in rows.indexed) ...[
                if (i > 0) const SizedBox(height: kCardGap),
                IpoCard(ipo: ipo, onTap: ipo.webUrl == null ? null : () => _openPage(ipo)),
              ],
            ],
          const SizedBox(height: 20),
          Text(
            'Grey market premium (GMP) is unofficial and changes daily. These figures are simple '
            'arithmetic on today\'s GMP, not a forecast or advice. Data: ${data.sourceName}.',
            style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
          ),
        ],
      ),
    );
  }
}

/// "Open now  3": a section title with a neutral count badge.
class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.title, required this.count});

  final String title;
  final int count;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Row(
      children: [
        Text(
          title,
          style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
        ),
        const SizedBox(width: 8),
        Container(
          constraints: const BoxConstraints(minWidth: 24, minHeight: 24),
          padding: const EdgeInsets.symmetric(horizontal: 7),
          alignment: Alignment.center,
          decoration: BoxDecoration(color: c.sunk, borderRadius: BorderRadius.circular(Ds.rSm)),
          child: Text(
            '$count',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.tx2, fontFeatures: Ds.tabular),
          ),
        ),
      ],
    );
  }
}

class _BoardChip extends StatelessWidget {
  const _BoardChip({required this.label, required this.on, required this.onTap});

  final String label;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => DsChip(label: label, selected: on, onTap: onTap);
}

/// The server kept its last good rows after a refresh failed, or has not
/// refreshed in longer than it means to: the neutral stale-data callout.
class _StaleBanner extends StatelessWidget {
  const _StaleBanner({required this.fetchedAt, required this.failed});

  final DateTime? fetchedAt;
  final bool failed;

  @override
  Widget build(BuildContext context) {
    final at = fetchedAt;
    final text = [
      at == null ? 'Showing older data' : 'Showing data from ${_ago(at)}',
      if (failed) "couldn't refresh",
    ].join(' · ');

    return DsCallout(title: text, tone: DsTone.neutral, icon: DsIcons.refresh);
  }
}


/// "7h ago", from the server's fetch time.
String _ago(DateTime at) {
  final age = DateTime.now().difference(at);
  if (age.inMinutes < 1) return 'just now';
  if (age.inMinutes < 60) return '${age.inMinutes}m ago';
  if (age.inHours < 48) return '${age.inHours}h ago';
  return '${age.inDays}d ago';
}

/// "+₹1,350", "−₹420", "₹0": whole rupees with a real minus sign.
String _signedMoney(int minor) => '${minor > 0 ? '+' : minor < 0 ? '−' : ''}${formatMoneyShort(minor.abs())}';

String _signedPercent(double percent) =>
    '${percent > 0 ? '+' : percent < 0 ? '−' : ''}${percent.abs().toStringAsFixed(1)}%';

/// "Open till 14 Oct", "Opens 16 Oct – closes 18 Oct", "Lists 21 Oct".
String ipoDateLine(Ipo ipo) {
  String day(String iso) => iso == istToday() ? 'today' : formatIsoShortDate(iso);

  switch (ipo.status) {
    case 'OPEN':
      final close = ipo.closeDate;
      if (close == null) return 'Open now';
      return close == istToday() ? 'Closes today' : 'Open till ${day(close)}';
    case 'CLOSED':
      if (ipo.listingDate != null) return 'Lists ${day(ipo.listingDate!)}';
      if (ipo.allotmentDate != null) return 'Bidding closed · allotment ${day(ipo.allotmentDate!)}';
      return 'Bidding closed · listing date not out yet';
    default:
      final open = ipo.openDate;
      final close = ipo.closeDate;
      if (open == null) return 'Dates not announced yet';
      if (close == null) return 'Opens ${day(open)}';
      return 'Opens ${day(open)} – closes ${day(close)}';
  }
}


/// The status tag on a card: what stage the issue is at.
(String, DsTone) _statusBadge(Ipo ipo) => switch (ipo.status) {
      'OPEN' => ('Bidding open', DsTone.good),
      'CLOSED' => ('Awaiting listing', DsTone.neutral),
      _ => ('Opens soon', DsTone.ac),
    };

/// One IPO, full width: what it is, when, what a lot costs, and what
/// today's premium would make of that lot.
class IpoCard extends StatelessWidget {
  const IpoCard({super.key, required this.ipo, this.onTap});

  final Ipo ipo;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final lotCost = ipo.perLot?.costMinor ??
        (ipo.lotSize != null && ipo.priceMaxMinor != null ? ipo.lotSize! * ipo.priceMaxMinor! : null);
    final lotSize = ipo.lotSize;
    final minimum = ipo.minInvestmentMinor;
    final subscribed = ipo.subscriptionTimes;
    final (statusLabel, statusTone) = _statusBadge(ipo);

    final smallPrint = [
      if (ipo.priceBand != null) 'Price band ${ipo.priceBand}',
      if (ipo.gmp?.updatedAtLabel != null) 'GMP updated ${ipo.gmp!.updatedAtLabel}',
      if (subscribed != null) 'Subscribed ${subscribed.toStringAsFixed(1)}×',
      if (minimum != null && lotCost != null && minimum > lotCost) 'Minimum ${formatMoneyShort(minimum)}',
    ];

    return DsCard(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DsMonogram(ipo.name, tone: ipo.isSme ? DsTone.warn : DsTone.ac),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      ipo.name,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      ipoDateLine(ipo),
                      style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        DsBadge(statusLabel, tone: statusTone),
                        if (ipo.isSme) const DsBadge('SME', outline: true),
                      ],
                    ),
                  ],
                ),
              ),
              if (onTap != null) ...[
                const SizedBox(width: 8),
                DsIcon(DsIcons.arrowUpRight, size: 18, color: c.tx3),
              ],
            ],
          ),
          const SizedBox(height: 14),
          const DsLabel('Lot'),
          const SizedBox(height: 2),
          Text(
            lotSize == null
                ? 'Lot size not announced yet'
                : [
                    '1 lot',
                    '$lotSize ${lotSize == 1 ? 'share' : 'shares'}',
                    if (lotCost != null) formatMoneyShort(lotCost),
                  ].join(' · '),
            style: TextStyle(
              fontSize: 15,
              height: 20 / 15,
              fontWeight: lotSize == null ? FontWeight.w400 : FontWeight.w600,
              color: lotSize == null ? c.tx3 : c.tx,
              fontFeatures: Ds.tabular,
            ),
          ),
          const SizedBox(height: 12),
          _GmpLine(ipo: ipo),
          if (smallPrint.isNotEmpty) ...[
            const SizedBox(height: 10),
            Text(
              smallPrint.join(' · '),
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3, fontFeatures: Ds.tabular),
            ),
          ],
          if (ipo.isSme) ...[
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 1),
                  child: DsIcon(DsIcons.alertTriangle, size: 14, color: c.warn),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    'SME: small, thinly traded; minimum application is often more than 1 lot',
                    style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx2),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// The figure the card is for: today's premium on one lot, in a band
/// tinted by what it says (green for a premium, red for a discount).
class _GmpLine extends StatelessWidget {
  const _GmpLine({required this.ipo});

  final Ipo ipo;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final perLot = ipo.perLot;
    final gmp = ipo.gmp;

    Widget band(DsTone tone, Widget child) => Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(color: c.soft(tone), borderRadius: BorderRadius.circular(Ds.rLg)),
          child: child,
        );

    // A premium without a lot size to multiply it by: say it per share.
    if (perLot == null && gmp != null) {
      final up = gmp.premiumMinor > 0;
      final down = gmp.premiumMinor < 0;
      final colour = up ? c.good : (down ? c.crit : c.tx);
      final lead = TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: colour);
      return band(
        up ? DsTone.good : (down ? DsTone.crit : DsTone.neutral),
        Text.rich(
          TextSpan(children: [
            TextSpan(text: 'GMP ', style: lead),
            TextSpan(
              text: _signedMoney(gmp.premiumMinor),
              style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w600, color: colour),
            ),
            if (gmp.percent != null)
              TextSpan(
                text: ' (${_signedPercent(gmp.percent!)})',
                style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: colour),
              ),
            TextSpan(text: ' a share', style: lead),
          ]),
        ),
      );
    }

    if (perLot == null) {
      return band(
        DsTone.neutral,
        Text('No GMP yet', style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx3)),
      );
    }

    final gain = perLot.gainMinor;
    if (gain == 0) {
      return band(
        DsTone.neutral,
        Text(
          'GMP ₹0 · no premium today',
          style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
        ),
      );
    }

    final colour = gain > 0 ? c.good : c.crit;
    final lead = TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: colour);
    final percent = perLot.gainPercent ?? (perLot.costMinor > 0 ? gain * 100 / perLot.costMinor : null);

    return band(
      gain > 0 ? DsTone.good : DsTone.crit,
      Text.rich(
        TextSpan(children: [
          TextSpan(text: "At today's GMP ", style: lead),
          TextSpan(
            text: _signedMoney(gain),
            style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w600, color: colour),
          ),
          if (percent != null)
            TextSpan(
              text: ' (${_signedPercent(percent)})',
              style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: colour),
            ),
          TextSpan(text: ' per lot', style: lead),
        ]),
      ),
    );
  }
}
