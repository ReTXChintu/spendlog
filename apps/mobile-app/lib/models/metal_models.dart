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
