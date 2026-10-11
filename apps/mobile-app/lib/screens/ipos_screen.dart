import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/ipo_models.dart';
import '../services/api_client.dart';
import '../theme.dart';
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
  const IposScreen({super.key});

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

    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Text('IPOs', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink)),
        shape: Border(bottom: BorderSide(color: c.line)),
      ),
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
    if (data == null) return const Center(child: CircularProgressIndicator());

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
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
        children: [
          if (data.stale || data.error != null) ...[
            _StaleBanner(fetchedAt: data.fetchedAt, failed: data.error != null),
            const SizedBox(height: 12),
          ],
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _BoardChip(label: 'All', on: _board == _Board.all, onTap: () => setState(() => _board = _Board.all)),
              _BoardChip(
                label: 'Mainboard',
                on: _board == _Board.mainboard,
                onTap: () => setState(() => _board = _Board.mainboard),
              ),
              _BoardChip(label: 'SME', on: _board == _Board.sme, onTap: () => setState(() => _board = _Board.sme)),
            ],
          ),
          if (nothingShown)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 28),
              child: Text(
                _board == _Board.sme
                    ? 'No SME IPOs open or coming up right now.'
                    : 'No mainboard IPOs open or coming up right now.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13, color: c.muted),
              ),
            ),
          for (final (title, rows) in sections)
            if (rows.isNotEmpty) ...[
              const SizedBox(height: 18),
              _SectionHeader(title: title, count: rows.length),
              const SizedBox(height: 8),
              for (final (i, ipo) in rows.indexed) ...[
                if (i > 0) const SizedBox(height: 10),
                IpoCard(ipo: ipo, onTap: ipo.webUrl == null ? null : () => _openPage(ipo)),
              ],
            ],
          const SizedBox(height: 20),
          Text(
            'Grey market premium (GMP) is unofficial and changes daily. These figures are simple '
            'arithmetic on today\'s GMP, not a forecast or advice. Data: ${data.sourceName}.',
            style: TextStyle(fontSize: 11.5, height: 1.5, color: c.muted),
          ),
        ],
      ),
    );
  }
}

/// "OPEN NOW  3"
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
          title.toUpperCase(),
          style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 1.1, color: c.muted),
        ),
        const SizedBox(width: 8),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
          decoration: BoxDecoration(color: c.chipNeutral, borderRadius: BorderRadius.circular(100)),
          child: Text(
            '$count',
            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, color: c.ink70),
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
  Widget build(BuildContext context) {
    final c = context.c;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 7),
        decoration: BoxDecoration(
          color: on ? c.brand50 : c.surface,
          border: Border.all(color: on ? c.brand : c.lineStrong),
          borderRadius: BorderRadius.circular(100),
        ),
        child: Text(
          label,
          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: on ? c.brandDark : c.ink70),
        ),
      ),
    );
  }
}

/// The server kept its last good rows after a refresh failed, or has not
/// refreshed in longer than it means to.
class _StaleBanner extends StatelessWidget {
  const _StaleBanner({required this.fetchedAt, required this.failed});

  final DateTime? fetchedAt;
  final bool failed;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final at = fetchedAt;
    final text = [
      at == null ? 'Showing older data' : 'Showing data from ${_ago(at)}',
      if (failed) "couldn't refresh",
    ].join(' · ');

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(color: c.warnBg, borderRadius: BorderRadius.circular(T.rSm)),
      child: Row(
        children: [
          Icon(Icons.schedule, size: 16, color: c.warn),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.warn)),
          ),
        ],
      ),
    );
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

    final smallPrint = [
      if (ipo.priceBand != null) 'Price band ${ipo.priceBand}',
      if (ipo.gmp?.updatedAtLabel != null) 'GMP updated ${ipo.gmp!.updatedAtLabel}',
      if (subscribed != null) 'Subscribed ${subscribed.toStringAsFixed(1)}×',
      if (minimum != null && lotCost != null && minimum > lotCost) 'Minimum ${formatMoneyShort(minimum)}',
    ];

    return Material(
      color: c.surface,
      shape: RoundedRectangleBorder(
        side: BorderSide(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Text(
                      ipo.name,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink),
                    ),
                  ),
                  if (ipo.isSme) ...[
                    const SizedBox(width: 8),
                    Container(
                      margin: const EdgeInsets.only(top: 2),
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(color: c.chipNeutral, borderRadius: BorderRadius.circular(4)),
                      child: Text(
                        'SME',
                        style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, letterSpacing: 0.5, color: c.ink70),
                      ),
                    ),
                  ],
                  if (onTap != null) ...[
                    const SizedBox(width: 4),
                    Icon(Icons.open_in_new, size: 15, color: c.mutedLight),
                  ],
                ],
              ),
              const SizedBox(height: 3),
              Text(ipoDateLine(ipo), style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.ink70)),
              const SizedBox(height: 10),
              Text(
                lotSize == null
                    ? 'Lot size not announced yet'
                    : [
                        '1 lot',
                        '$lotSize ${lotSize == 1 ? 'share' : 'shares'}',
                        if (lotCost != null) formatMoneyShort(lotCost),
                      ].join(' · '),
                style: TextStyle(fontSize: 12.5, color: lotSize == null ? c.muted : c.ink70),
              ),
              const SizedBox(height: 6),
              _GmpLine(ipo: ipo),
              if (smallPrint.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(smallPrint.join(' · '), style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted)),
              ],
              if (ipo.isSme) ...[
                const SizedBox(height: 6),
                Text(
                  'SME: small, thinly traded; minimum application is often more than 1 lot',
                  style: TextStyle(fontSize: 11.5, height: 1.4, fontStyle: FontStyle.italic, color: c.muted),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// The figure the card is for: today's premium on one lot.
class _GmpLine extends StatelessWidget {
  const _GmpLine({required this.ipo});

  final Ipo ipo;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final perLot = ipo.perLot;
    final gmp = ipo.gmp;
    final lead = TextStyle(fontSize: 13, color: c.ink70);

    // A premium without a lot size to multiply it by: say it per share.
    if (perLot == null && gmp != null) {
      final colour = gmp.premiumMinor > 0 ? c.credit : (gmp.premiumMinor < 0 ? c.debit : c.ink);
      return Text.rich(
        TextSpan(children: [
          TextSpan(text: 'GMP ', style: lead),
          TextSpan(
            text: _signedMoney(gmp.premiumMinor),
            style: kNum.copyWith(fontSize: 17, fontWeight: FontWeight.w800, color: colour),
          ),
          if (gmp.percent != null)
            TextSpan(
              text: ' (${_signedPercent(gmp.percent!)})',
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: colour),
            ),
          TextSpan(text: ' a share', style: lead),
        ]),
      );
    }

    if (perLot == null) {
      return Text('No GMP yet', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: c.muted));
    }

    final gain = perLot.gainMinor;
    if (gain == 0) {
      return Text(
        'GMP ₹0 · no premium today',
        style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: c.ink),
      );
    }

    final colour = gain > 0 ? c.credit : c.debit;
    final percent = perLot.gainPercent ?? (perLot.costMinor > 0 ? gain * 100 / perLot.costMinor : null);

    return Text.rich(
      TextSpan(children: [
        TextSpan(text: "At today's GMP ", style: lead),
        TextSpan(
          text: _signedMoney(gain),
          style: kNum.copyWith(fontSize: 19, fontWeight: FontWeight.w800, color: colour),
        ),
        if (percent != null)
          TextSpan(
            text: ' (${_signedPercent(percent)})',
            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: colour),
          ),
        TextSpan(text: ' per lot', style: lead),
      ]),
    );
  }
}
