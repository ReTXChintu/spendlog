/// IPOs open now, coming up, and closed but not yet listed, from the
/// server's `GET /ipos` (IPO Guru's calendar and grey market premium,
/// cached on the server).
///
/// Read defensively throughout: the server passes on a third party's data,
/// so a field that is missing or the wrong shape comes back as null or
/// empty rather than as a crash on the screen.
library;

int? _intOrNull(Object? value) => value is int ? value : (value is num ? value.round() : null);
double? _numOrNull(Object? value) => value is num ? value.toDouble() : null;
String? _str(Object? value) => value is String && value.isNotEmpty ? value : null;
bool _bool(Object? value) => value is bool && value;
Map<String, dynamic>? _mapOrNull(Object? value) => value is Map<String, dynamic> ? value : null;
List<Map<String, dynamic>> _maps(Object? value) =>
    value is List ? value.whereType<Map<String, dynamic>>().toList() : const [];

/// Today's grey market premium for one share.
class IpoGmp {
  /// Per share, in paise. Zero is a real reading - no premium today - and
  /// it can be negative.
  final int premiumMinor;
  final double? percent;

  /// When the source last changed it, as the source says it ("2h ago").
  final String? updatedAtLabel;

  const IpoGmp({required this.premiumMinor, this.percent, this.updatedAtLabel});

  static IpoGmp? maybe(Object? value) {
    final json = _mapOrNull(value);
    final premium = _intOrNull(json?['premiumMinor']);
    if (json == null || premium == null) return null;
    return IpoGmp(
      premiumMinor: premium,
      percent: _numOrNull(json['percent']),
      updatedAtLabel: _str(json['updatedAtLabel']),
    );
  }
}

/// Simple arithmetic on today's GMP for one lot: what it costs at the top
/// of the band, and what it would be worth at that premium.
class IpoPerLot {
  final int costMinor;
  final int atGmpMinor;

  /// Negative is a loss.
  final int gainMinor;
  final double? gainPercent;

  const IpoPerLot({
    required this.costMinor,
    required this.atGmpMinor,
    required this.gainMinor,
    this.gainPercent,
  });

  static IpoPerLot? maybe(Object? value) {
    final json = _mapOrNull(value);
    if (json == null) return null;
    final cost = _intOrNull(json['costMinor']);
    final gain = _intOrNull(json['gainMinor']);
    if (cost == null || gain == null) return null;
    return IpoPerLot(
      costMinor: cost,
      atGmpMinor: _intOrNull(json['atGmpMinor']) ?? cost + gain,
      gainMinor: gain,
      gainPercent: _numOrNull(json['gainPercent']),
    );
  }
}

class Ipo {
  final String slug;
  final String name;

  /// MAINBOARD | SME
  final String type;

  /// UPCOMING | OPEN | CLOSED. CLOSED is bidding closed, not yet listed.
  final String status;

  /// Plain YYYY-MM-DD days.
  final String? openDate;
  final String? closeDate;
  final String? allotmentDate;
  final String? listingDate;

  /// As the source writes it.
  final String? priceBand;
  final int? priceMaxMinor;

  /// Shares in one lot.
  final int? lotSize;
  final int? minInvestmentMinor;
  final IpoGmp? gmp;
  final double? subscriptionTimes;
  final String? webUrl;
  final IpoPerLot? perLot;

  const Ipo({
    required this.slug,
    required this.name,
    this.type = 'MAINBOARD',
    this.status = 'UPCOMING',
    this.openDate,
    this.closeDate,
    this.allotmentDate,
    this.listingDate,
    this.priceBand,
    this.priceMaxMinor,
    this.lotSize,
    this.minInvestmentMinor,
    this.gmp,
    this.subscriptionTimes,
    this.webUrl,
    this.perLot,
  });

  bool get isSme => type == 'SME';

  /// [fallbackStatus] is the list the row came in, for a row that does not
  /// say its own.
  factory Ipo.fromJson(Map<String, dynamic> json, {String fallbackStatus = 'UPCOMING'}) {
    final status = json['status'];
    return Ipo(
      slug: _str(json['slug']) ?? _str(json['name']) ?? '',
      name: _str(json['name']) ?? 'Unnamed IPO',
      type: json['type'] == 'SME' ? 'SME' : 'MAINBOARD',
      status: status == 'UPCOMING' || status == 'OPEN' || status == 'CLOSED' ? status as String : fallbackStatus,
      openDate: _str(json['openDate']),
      closeDate: _str(json['closeDate']),
      allotmentDate: _str(json['allotmentDate']),
      listingDate: _str(json['listingDate']),
      priceBand: _str(json['priceBand']),
      priceMaxMinor: _intOrNull(json['priceMaxMinor']),
      lotSize: _intOrNull(json['lotSize']),
      minInvestmentMinor: _intOrNull(json['minInvestmentMinor']),
      gmp: IpoGmp.maybe(json['gmp']),
      subscriptionTimes: _numOrNull(json['subscriptionTimes']),
      webUrl: _str(json['webUrl']),
      perLot: IpoPerLot.maybe(json['perLot']),
    );
  }
}

class IpoList {
  /// False when the server has no IPO key: the feature is hidden.
  final bool available;
  final DateTime? fetchedAt;

  /// Older than the server meant to keep it, because a refresh failed.
  final bool stale;

  /// Why the last refresh failed, when it did.
  final String? error;
  final String sourceName;
  final String? sourceUrl;
  final List<Ipo> open;
  final List<Ipo> upcoming;

  /// Bidding closed, waiting to list.
  final List<Ipo> closed;

  const IpoList({
    required this.available,
    this.fetchedAt,
    this.stale = false,
    this.error,
    this.sourceName = 'IPO Guru',
    this.sourceUrl,
    this.open = const [],
    this.upcoming = const [],
    this.closed = const [],
  });

  bool get isEmpty => open.isEmpty && upcoming.isEmpty && closed.isEmpty;

  factory IpoList.fromJson(Map<String, dynamic> json) {
    final source = _mapOrNull(json['source']);
    final fetchedAt = _str(json['fetchedAt']);
    List<Ipo> rows(String key, String status) =>
        [for (final row in _maps(json[key])) Ipo.fromJson(row, fallbackStatus: status)];

    return IpoList(
      available: _bool(json['available']),
      fetchedAt: fetchedAt == null ? null : DateTime.tryParse(fetchedAt),
      stale: _bool(json['stale']),
      error: _str(json['error']),
      sourceName: _str(source?['name']) ?? 'IPO Guru',
      sourceUrl: _str(source?['url']),
      open: rows('open', 'OPEN'),
      upcoming: rows('upcoming', 'UPCOMING'),
      closed: rows('closed', 'CLOSED'),
    );
  }
}
