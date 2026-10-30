/// IBJA's gold and silver rates by the day, against the 30 days before.
library;

int? _intOrNull(Object? value) => value is int ? value : (value is num ? value.round() : null);
double? _doubleOrNull(Object? value) => value is num ? value.toDouble() : null;
String? _str(Object? value) => value is String && value.isNotEmpty ? value : null;
Map<String, dynamic> _map(Object? value) => value is Map<String, dynamic> ? value : const {};

/// Today's rate against the days before it.
class MetalSignal {
  final int? averageMinor;

  /// How far below the 30-day average, as a percentage; negative above it.
  final double? belowAveragePercent;
  final bool isGoodDay;

  /// Against the day before, as a percentage.
  final double? changePercent;

  const MetalSignal({this.averageMinor, this.belowAveragePercent, this.isGoodDay = false, this.changePercent});

  factory MetalSignal.fromJson(Map<String, dynamic> json) => MetalSignal(
        averageMinor: _intOrNull(json['averageMinor']),
        belowAveragePercent: _doubleOrNull(json['belowAveragePercent']),
        isGoodDay: json['isGoodDay'] == true,
        changePercent: _doubleOrNull(json['changePercent']),
      );
}

class MetalPoint {
  final DateTime day;
  final int perGramMinor;

  const MetalPoint(this.day, this.perGramMinor);

  static List<MetalPoint> listFrom(Object? value) => [
        for (final row in (value is List ? value : const []))
          if (row is Map<String, dynamic> && DateTime.tryParse(row['day'] as String? ?? '') != null && row['perGramMinor'] is int)
            MetalPoint(DateTime.parse(row['day'] as String), row['perGramMinor'] as int),
      ];
}

class MetalRates {
  final bool available;

  /// The day the rates are for, and which of its quotes ("AM", "PM", or
  /// "CLOSE" for one only known from IBJA's history).
  final DateTime? day;
  final String? session;
  final bool isToday;
  final String sourceName;
  final String? sourceUrl;

  final int? gold24Minor;
  final int? gold22Minor;
  final int? gold18Minor;

  /// 24K with 3% GST: about what a digital gold app charges, before its margin.
  final int? goldWithGstMinor;
  final MetalSignal goldSignal;
  final List<MetalPoint> goldHistory;

  final int? silverMinor;
  final int? silverPerKgMinor;
  final int? silverWithGstMinor;
  final MetalSignal silverSignal;
  final List<MetalPoint> silverHistory;

  /// Whether the day's rates are pushed to this phone.
  final bool push;

  const MetalRates({
    this.available = false,
    this.day,
    this.session,
    this.isToday = false,
    this.sourceName = 'IBJA',
    this.sourceUrl,
    this.gold24Minor,
    this.gold22Minor,
    this.gold18Minor,
    this.goldWithGstMinor,
    this.goldSignal = const MetalSignal(),
    this.goldHistory = const [],
    this.silverMinor,
    this.silverPerKgMinor,
    this.silverWithGstMinor,
    this.silverSignal = const MetalSignal(),
    this.silverHistory = const [],
    this.push = false,
  });

  factory MetalRates.fromJson(Map<String, dynamic> json) {
    final gold = _map(json['gold']);
    final perGram = _map(gold['perGramMinor']);
    final silver = _map(json['silver']);
    final source = _map(json['source']);
    return MetalRates(
      available: json['available'] == true,
      day: DateTime.tryParse(_str(json['day']) ?? ''),
      session: _str(json['session']),
      isToday: json['isToday'] == true,
      sourceName: _str(source['name']) ?? 'IBJA',
      sourceUrl: _str(source['url']),
      gold24Minor: _intOrNull(perGram['24K']),
      gold22Minor: _intOrNull(perGram['22K']),
      gold18Minor: _intOrNull(perGram['18K']),
      goldWithGstMinor: _intOrNull(gold['withGstPerGramMinor']),
      goldSignal: MetalSignal.fromJson(_map(gold['signal'])),
      goldHistory: MetalPoint.listFrom(gold['history']),
      silverMinor: _intOrNull(silver['perGramMinor']),
      silverPerKgMinor: _intOrNull(silver['perKgMinor']),
      silverWithGstMinor: _intOrNull(silver['withGstPerGramMinor']),
      silverSignal: MetalSignal.fromJson(_map(silver['signal'])),
      silverHistory: MetalPoint.listFrom(silver['history']),
      push: json['push'] == true,
    );
  }

  /// "Morning rates", "Evening rates", or "Closing rates".
  String get sessionLabel => switch (session) {
        'PM' => 'Evening rates',
        'AM' => 'Morning rates',
        _ => 'Closing rates',
      };
}

/// "1.8% below its 30-day average", "0.6% above", or null with nothing to compare.
String? averageLine(MetalSignal signal) {
  final below = signal.belowAveragePercent;
  if (below == null) return null;
  if (below == 0) return 'at its 30-day average';
  return below > 0
      ? '${below.toStringAsFixed(1)}% below its 30-day average'
      : '${(-below).toStringAsFixed(1)}% above its 30-day average';
}

/// Gold or silver the user owns, in grams, valued at today's rate.
class MetalHolding {
  final String id;
  final String name;

  /// "24K", "22K", "18K" or "SILVER".
  final String purity;

  /// "DIGITAL", "JEWELLERY" or "OTHER".
  final String kind;
  final String? payee;
  final bool isActive;
  final double grams;
  final double openingGrams;
  final int? investedMinor;
  final int? valueMinor;
  final int? gainMinor;
  final int purchases;
  final double boughtThisMonthGrams;

  const MetalHolding({
    required this.id,
    required this.name,
    this.purity = '24K',
    this.kind = 'OTHER',
    this.payee,
    this.isActive = true,
    this.grams = 0,
    this.openingGrams = 0,
    this.investedMinor,
    this.valueMinor,
    this.gainMinor,
    this.purchases = 0,
    this.boughtThisMonthGrams = 0,
  });

  bool get isSilver => purity == 'SILVER';

  /// "24K gold · Digital", "Silver · Jewellery".
  String get subtitle => [
        isSilver ? 'Silver' : '$purity gold',
        switch (kind) {
          'DIGITAL' => 'Digital',
          'JEWELLERY' => 'Jewellery',
          _ => null,
        },
      ].whereType<String>().join(' · ');

  factory MetalHolding.fromJson(Map<String, dynamic> json) => MetalHolding(
        id: _str(json['id']) ?? '',
        name: _str(json['name']) ?? 'Gold',
        purity: _str(json['purity']) ?? '24K',
        kind: _str(json['kind']) ?? 'OTHER',
        payee: _str(json['payee']),
        isActive: json['isActive'] != false,
        grams: _doubleOrNull(json['grams']) ?? 0,
        openingGrams: _doubleOrNull(json['openingGrams']) ?? 0,
        investedMinor: _intOrNull(json['investedMinor']),
        valueMinor: _intOrNull(json['valueMinor']),
        gainMinor: _intOrNull(json['gainMinor']),
        purchases: _intOrNull(json['purchases']) ?? 0,
        boughtThisMonthGrams: _doubleOrNull(json['boughtThisMonthGrams']) ?? 0,
      );
}

/// Grams as people say them: "3.3 g", "0.0345 g".
String formatGrams(double grams) {
  final fixed = grams >= 10 ? grams.toStringAsFixed(2) : grams.toStringAsFixed(4);
  return '${fixed.contains('.') ? fixed.replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '') : fixed} g';
}

/// One kind of investment in the overview.
class OverviewPart {
  /// "FUNDS", "DEPOSITS", "GOLD" or "SILVER".
  final String kind;
  final String label;
  final int valueMinor;
  final int? investedMinor;
  final int count;

  const OverviewPart({required this.kind, required this.label, this.valueMinor = 0, this.investedMinor, this.count = 0});

  int? get gainMinor => investedMinor == null ? null : valueMinor - investedMinor!;

  factory OverviewPart.fromJson(Map<String, dynamic> json) => OverviewPart(
        kind: _str(json['kind']) ?? '',
        label: _str(json['label']) ?? '',
        valueMinor: _intOrNull(json['valueMinor']) ?? 0,
        investedMinor: _intOrNull(json['investedMinor']),
        count: _intOrNull(json['count']) ?? 0,
      );
}

/// Everything held, in one total.
class InvestmentsOverview {
  final int valueMinor;
  final int investedMinor;
  final int gainMinor;
  final double? gainPercent;

  /// Some of it has no cost to measure a gain against.
  final bool partial;
  final List<OverviewPart> parts;
  final List<MetalHolding> holdings;

  const InvestmentsOverview({
    this.valueMinor = 0,
    this.investedMinor = 0,
    this.gainMinor = 0,
    this.gainPercent,
    this.partial = false,
    this.parts = const [],
    this.holdings = const [],
  });

  bool get isEmpty => parts.isEmpty && holdings.isEmpty;

  factory InvestmentsOverview.fromJson(Map<String, dynamic> json) => InvestmentsOverview(
        valueMinor: _intOrNull(json['valueMinor']) ?? 0,
        investedMinor: _intOrNull(json['investedMinor']) ?? 0,
        gainMinor: _intOrNull(json['gainMinor']) ?? 0,
        gainPercent: _doubleOrNull(json['gainPercent']),
        partial: json['partial'] == true,
        parts: (json['parts'] as List<dynamic>? ?? const []).whereType<Map<String, dynamic>>().map(OverviewPart.fromJson).toList(),
        holdings: (json['holdings'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(MetalHolding.fromJson)
            .where((h) => h.id.isNotEmpty)
            .toList(),
      );
}
