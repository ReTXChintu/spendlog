import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../../models/metal_models.dart';
import '../../services/api_client.dart';
import '../../utils/format.dart';
import '../../widgets/ds/ds.dart';
import '../../widgets/state_block.dart';

/// Gold and silver by the day: IBJA's 24K, 22K and 18K and silver per
/// gram, whether today is below its 30-day average - the day to buy - and
/// about three months of each as a chart. The daily notification is
/// switched on here.
class MetalsTab extends StatefulWidget {
  const MetalsTab({super.key});

  @override
  State<MetalsTab> createState() => _MetalsTabState();
}

class _MetalsTabState extends State<MetalsTab> {
  MetalRates? _rates;
  bool _failed = false;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final json = await ApiClient.instance.get('/metals') as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _rates = MetalRates.fromJson(json);
          _failed = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  Future<void> _setPush(bool on) async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _saving = true);
    try {
      final json = await ApiClient.instance.patch('/metals/settings', {'push': on}) as Map<String, dynamic>;
      if (mounted) setState(() => _rates = MetalRates.fromJson(json));
      messenger.showSnackBar(SnackBar(
        content: Text(on ? "You'll get the day's rates once IBJA publishes them, about 12:30 pm." : 'Daily rates notification off.'),
      ));
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text("Couldn't change that. Try again.")));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final rates = _rates;
    if (rates == null) {
      return _failed
          ? StateBlock(
              icon: Icons.wifi_off,
              warn: true,
              title: "Couldn't load the rates",
              body: 'The connection failed. Check your internet and try again.',
              actionLabel: 'Retry',
              onAction: _load,
            )
          : const Center(child: DsSpinner());
    }
    if (!rates.available) {
      return StateBlock(
        icon: DsIcons.trendingUp,
        title: 'No rates yet',
        body: "IBJA's gold and silver rates are read every working day from about 12:30 pm. Check back then.",
        actionLabel: 'Retry',
        onAction: _load,
      );
    }

    final day = rates.day == null ? '' : formatShortDate(rates.day!);
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
        children: [
          Text(
            [rates.isToday ? 'Today' : day, rates.sessionLabel, 'IBJA'].where((part) => part.isNotEmpty).join(' · '),
            style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3),
          ),
          const SizedBox(height: 8),
          MetalSignalCallout(metal: 'gold', signal: rates.goldSignal),
          const SizedBox(height: kCardGap),
          DsCard(
            key: const ValueKey('gold-card'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const DsLabel('Gold, per gram'),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 24,
                  runSpacing: 10,
                  children: [
                    DsInlineStat(label: '24K (999)', value: _money(rates.gold24Minor)),
                    DsInlineStat(label: '22K (916)', value: _money(rates.gold22Minor)),
                    DsInlineStat(label: '18K (750)', value: _money(rates.gold18Minor)),
                  ],
                ),
                const SizedBox(height: 10),
                _ChangeLine(signal: rates.goldSignal),
                if (rates.goldWithGstMinor != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    '24K with 3% GST: ${_money(rates.goldWithGstMinor)}/g - about what a digital gold app charges, before '
                    'its own margin. A jeweller adds making charges and GST to the 22K or 18K rate.',
                    style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
                  ),
                ],
                const SizedBox(height: 14),
                MetalChart(points: rates.goldHistory, average: rates.goldSignal.averageMinor),
              ],
            ),
          ),
          const SizedBox(height: kCardGap),
          MetalSignalCallout(metal: 'silver', signal: rates.silverSignal),
          const SizedBox(height: kCardGap),
          DsCard(
            key: const ValueKey('silver-card'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const DsLabel('Silver (999)'),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 24,
                  runSpacing: 10,
                  children: [
                    DsInlineStat(label: 'Per gram', value: _money(rates.silverMinor)),
                    DsInlineStat(label: 'Per kg', value: rates.silverPerKgMinor == null ? '-' : formatMoneyShort(rates.silverPerKgMinor!)),
                    if (rates.silverWithGstMinor != null)
                      DsInlineStat(label: 'With 3% GST', value: _money(rates.silverWithGstMinor)),
                  ],
                ),
                const SizedBox(height: 10),
                _ChangeLine(signal: rates.silverSignal),
                const SizedBox(height: 14),
                MetalChart(points: rates.silverHistory, average: rates.silverSignal.averageMinor),
              ],
            ),
          ),
          const SizedBox(height: kCardGap),
          DsCard(
            child: SwitchListTile(
              key: const ValueKey('metal-push'),
              contentPadding: EdgeInsets.zero,
              value: rates.push,
              onChanged: _saving ? null : _setPush,
              title: Text('Daily rates notification', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: c.tx)),
              subtitle: Text(
                "Each working day once IBJA's rates are out, about 12:30 pm - marked when it's a good day to buy.",
                style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
              ),
            ),
          ),
          const SizedBox(height: 16),
          Text(
            "Rates are IBJA's (India Bullion and Jewellers Association) benchmark, before GST and making charges. A "
            'good day is one below the average of the 30 days before it - a guide, not a forecast.',
            style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
          ),
        ],
      ),
    );
  }

  static String _money(int? minor) => minor == null ? '-' : formatMoney(minor);
}

/// "A good day to buy gold: 1.8% below its 30-day average", or how far
/// above it today is.
class MetalSignalCallout extends StatelessWidget {
  const MetalSignalCallout({super.key, required this.metal, required this.signal});

  final String metal;
  final MetalSignal signal;

  @override
  Widget build(BuildContext context) {
    final line = averageLine(signal);
    if (line == null) {
      return DsCallout(tone: DsTone.neutral, title: 'Not enough ${metal == 'gold' ? 'gold' : 'silver'} history yet to compare.');
    }
    final name = '${metal[0].toUpperCase()}${metal.substring(1)}';
    return DsCallout(
      key: ValueKey('signal-$metal'),
      tone: signal.isGoodDay ? DsTone.good : DsTone.neutral,
      title: signal.isGoodDay ? 'A good day to buy $metal' : '$name is above its usual',
      detail: '$name is $line.',
    );
  }
}

/// Up or down on the day before.
class _ChangeLine extends StatelessWidget {
  const _ChangeLine({required this.signal});

  final MetalSignal signal;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final change = signal.changePercent;
    if (change == null) return const SizedBox.shrink();
    final colour = change < 0 ? c.good : (change > 0 ? c.crit : c.tx3);
    return Text(
      change == 0
          ? 'Same as the day before'
          : '${change > 0 ? '▲' : '▼'} ${change.abs().toStringAsFixed(2)}% on the day before'
              '${signal.averageMinor != null ? ' · 30-day average ${formatMoney(signal.averageMinor!)}/g' : ''}',
      style: kNum.copyWith(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: colour),
    );
  }
}

/// About three months of a rate per gram as a line, its 30-day average
/// dashed across, and the highest and lowest marked.
class MetalChart extends StatelessWidget {
  const MetalChart({super.key, required this.points, this.average, this.height = 120});

  final List<MetalPoint> points;
  final int? average;
  final double height;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    if (points.length < 2) {
      return SizedBox(
        height: height,
        child: Center(child: Text('Not enough history yet', style: TextStyle(fontSize: 12, color: c.tx3))),
      );
    }
    final values = [for (final point in points) point.perGramMinor];
    final high = values.reduce(math.max);
    final low = values.reduce(math.min);
    final label = kNum.copyWith(fontSize: 11, height: 14 / 11, color: c.tx3);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: height,
          child: CustomPaint(
            painter: _MetalChartPainter(values: values, average: average, line: c.ac, averageLine: c.tx3, grid: c.ln),
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(child: Text(formatShortDate(points.first.day), style: label)),
            Text('Low ${formatMoneyShort(low)} · High ${formatMoneyShort(high)}', style: label),
            Expanded(child: Text(formatShortDate(points.last.day), style: label, textAlign: TextAlign.right)),
          ],
        ),
      ],
    );
  }
}

class _MetalChartPainter extends CustomPainter {
  _MetalChartPainter({required this.values, required this.average, required this.line, required this.averageLine, required this.grid});

  final List<int> values;
  final int? average;
  final Color line;
  final Color averageLine;
  final Color grid;

  @override
  void paint(Canvas canvas, Size size) {
    final all = [...values, if (average != null) average!];
    final low = all.reduce(math.min).toDouble();
    final high = all.reduce(math.max).toDouble();
    final span = high - low == 0 ? 1.0 : high - low;
    const pad = 6.0;
    final usable = size.height - pad * 2;
    double y(num value) => pad + usable - ((value - low) / span) * usable;

    final gridPaint = Paint()
      ..color = grid
      ..strokeWidth = 1;
    for (final f in [0.0, 0.5, 1.0]) {
      canvas.drawLine(Offset(0, pad + usable * f), Offset(size.width, pad + usable * f), gridPaint);
    }

    if (average != null) {
      final dash = Paint()
        ..color = averageLine
        ..strokeWidth = 1;
      final ay = y(average!);
      for (var x = 0.0; x < size.width; x += 8) {
        canvas.drawLine(Offset(x, ay), Offset(math.min(x + 4, size.width), ay), dash);
      }
    }

    Offset at(int i) => Offset(size.width * i / (values.length - 1), y(values[i]));
    final path = Path()..moveTo(at(0).dx, at(0).dy);
    for (var i = 1; i < values.length; i++) {
      path.lineTo(at(i).dx, at(i).dy);
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = line
        ..strokeWidth = 1.75
        ..style = PaintingStyle.stroke
        ..strokeJoin = StrokeJoin.round,
    );
    canvas.drawCircle(at(values.length - 1), 3.5, Paint()..color = line);
  }

  @override
  bool shouldRepaint(covariant _MetalChartPainter old) =>
      old.values != values || old.average != average || old.line != line;
}

/// Home's gold and silver tile: 24K, 22K and silver per gram, and the
/// day's signal.
class MetalsTile extends StatelessWidget {
  const MetalsTile({super.key, required this.rates, this.onTap});

  final MetalRates? rates;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final data = rates;
    String money(int? minor) => minor == null ? '-' : formatMoney(minor);

    return DsCard(
      key: const ValueKey('metals-tile'),
      onTap: onTap,
      child: data == null || !data.available
          ? Row(
              children: [
                const DsIconTile(DsIcons.trendingUp, tone: DsTone.neutral, size: 36),
                const SizedBox(width: 12),
                Expanded(
                  child: Text('Gold and silver rates', style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2)),
                ),
              ],
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(child: DsLabel('Gold & silver · ${data.isToday ? 'today' : formatShortDate(data.day!)}')),
                    if (data.goldSignal.isGoodDay)
                      const DsBadge('Good day for gold', tone: DsTone.good)
                    else if (data.silverSignal.isGoodDay)
                      const DsBadge('Good day for silver', tone: DsTone.good),
                  ],
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 20,
                  runSpacing: 8,
                  children: [
                    DsInlineStat(label: '24K /g', value: money(data.gold24Minor)),
                    DsInlineStat(label: '22K /g', value: money(data.gold22Minor)),
                    DsInlineStat(label: '18K /g', value: money(data.gold18Minor)),
                    DsInlineStat(label: 'Silver /g', value: money(data.silverMinor)),
                  ],
                ),
                if (averageLine(data.goldSignal) != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    'Gold is ${averageLine(data.goldSignal)}',
                    style: TextStyle(
                      fontSize: 12,
                      height: 16 / 12,
                      fontWeight: FontWeight.w600,
                      color: data.goldSignal.isGoodDay ? c.good : c.tx3,
                    ),
                  ),
                ],
              ],
            ),
    );
  }
}
