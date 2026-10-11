/// Mutual funds and savings goals, from the server's `/funds` and `/goals`.
///
/// Money is paise, percentages are plain numbers (12.34 means 12.34%), and
/// days are YYYY-MM-DD in IST. The figures are all worked out on the
/// server from NAVs it fetches from mfapi and AMFI, so everything is read
/// defensively: a missing or wrong-shaped field comes back as null or a
/// safe default rather than as a crash on the screen.
library;

int _int(Object? value, [int fallback = 0]) => value is int ? value : (value is num ? value.round() : fallback);
int? _intOrNull(Object? value) => value is int ? value : (value is num ? value.round() : null);
double? _numOrNull(Object? value) => value is num ? value.toDouble() : null;
double _num(Object? value, [double fallback = 0]) => value is num ? value.toDouble() : fallback;
String? _str(Object? value) => value is String && value.isNotEmpty ? value : null;
bool _bool(Object? value) => value is bool && value;
Map<String, dynamic>? _map(Object? value) => value is Map<String, dynamic> ? value : null;
List<Map<String, dynamic>> _maps(Object? value) =>
    value is List ? value.whereType<Map<String, dynamic>>().toList() : const [];
List<String> _strings(Object? value) => value is List ? value.whereType<String>().toList() : const [];

/// The three things the server flags a holding for.
class FundFlag {
  const FundFlag._();
  static const laggingCategory = 'lagging_category';
  static const lowXirr = 'low_xirr';
  static const regularPlan = 'regular_plan';
  static const all = [laggingCategory, lowXirr, regularPlan];
}

/// A running (or stopped) SIP's details, as the user gave them.
class FundSip {
  final int amountMinor;
  final int dayOfMonth;
  final String startOn;
  final String? endOn;
  final bool active;

  const FundSip({
    required this.amountMinor,
    required this.dayOfMonth,
    required this.startOn,
    this.endOn,
    this.active = true,
  });

  static FundSip? maybe(Object? value) {
    final json = _map(value);
    final amount = _intOrNull(json?['amountMinor']);
    final day = _intOrNull(json?['dayOfMonth']);
    final start = _str(json?['startOn']);
    if (json == null || amount == null || day == null || start == null) return null;
    return FundSip(
      amountMinor: amount,
      dayOfMonth: day,
      startOn: start,
      endOn: _str(json['endOn']),
      // Stored with `active`; an older row without it was running.
      active: json['active'] is bool ? json['active'] as bool : true,
    );
  }

  Map<String, dynamic> toJson() => {
        'amountMinor': amountMinor,
        'dayOfMonth': dayOfMonth,
        'startOn': startOn,
        'endOn': endOn,
        'active': active,
      };
}

/// Units held as of a day, copied off a statement, and what they cost.
class FundOpening {
  final double units;
  final int investedMinor;
  final String asOf;

  /// When the first money went in, for an XIRR that knows how long it took.
  final String? firstOn;

  const FundOpening({required this.units, required this.investedMinor, required this.asOf, this.firstOn});

  static FundOpening? maybe(Object? value) {
    final json = _map(value);
    final units = _numOrNull(json?['units']);
    final asOf = _str(json?['asOf']);
    if (json == null || units == null || asOf == null) return null;
    return FundOpening(
      units: units,
      investedMinor: _int(json['investedMinor']),
      asOf: asOf,
      firstOn: _str(json['firstOn']),
    );
  }

  Map<String, dynamic> toJson() => {
        'units': units,
        'investedMinor': investedMinor,
        'asOf': asOf,
        'firstOn': firstOn,
      };
}

/// One day's NAV.
class NavPoint {
  final String day;
  final double nav;

  const NavPoint({required this.day, required this.nav});

  static NavPoint? maybe(Object? value) {
    final json = _map(value);
    final day = _str(json?['day']);
    final nav = _numOrNull(json?['nav']);
    if (day == null || nav == null) return null;
    return NavPoint(day: day, nav: nav);
  }
}

/// A category's returns over one period, across the funds in it.
class PeerStats {
  final int count;
  final double? averagePercent;
  final double? medianPercent;

  const PeerStats({this.count = 0, this.averagePercent, this.medianPercent});

  factory PeerStats.fromJson(Object? value) {
    final json = _map(value) ?? const {};
    return PeerStats(
      count: _int(json['count']),
      averagePercent: _numOrNull(json['averagePercent']),
      medianPercent: _numOrNull(json['medianPercent']),
    );
  }
}

/// Where a fund sits in its category: 1 is the best.
class PeerRank {
  final int rank;

  /// The peers plus the fund itself.
  final int of;

  /// The share of its peers it beat, 0 to 100.
  final int percentile;

  const PeerRank({required this.rank, required this.of, required this.percentile});

  static PeerRank? maybe(Object? value) {
    final json = _map(value);
    final rank = _intOrNull(json?['rank']);
    final of = _intOrNull(json?['of']);
    if (rank == null || of == null) return null;
    return PeerRank(rank: rank, of: of, percentile: _int(json!['percentile']));
  }
}

class HoldingPeers {
  final PeerStats oneYear;
  final PeerStats threeYear;

  /// Which period the rank and the flag go by: "3y", "1y", or null when
  /// the fund is too young for either.
  final String? basis;
  final PeerRank? rank;

  const HoldingPeers({
    this.oneYear = const PeerStats(),
    this.threeYear = const PeerStats(),
    this.basis,
    this.rank,
  });

  static HoldingPeers? maybe(Object? value) {
    final json = _map(value);
    if (json == null) return null;
    final basis = json['basis'];
    return HoldingPeers(
      oneYear: PeerStats.fromJson(json['oneYear']),
      threeYear: PeerStats.fromJson(json['threeYear']),
      basis: basis == '3y' || basis == '1y' ? basis as String : null,
      rank: PeerRank.maybe(json['rank']),
    );
  }

  /// The median the rank is measured against.
  double? get basisMedian => basis == '3y' ? threeYear.medianPercent : (basis == '1y' ? oneYear.medianPercent : null);
}

/// One fund in the portfolio, with everything worked out about it.
class FundHolding {
  final String id;
  final int schemeCode;
  final String schemeName;
  final String? fundHouse;
  final String? category;
  final String? categoryKey;
  final String categoryLabel;

  /// equity | debt | hybrid | other
  final String assetClass;
  final bool isDirect;
  final bool isGrowth;
  final bool isRegular;
  final String? folio;
  final FundSip? sip;
  final FundOpening? opening;
  final String? commitmentId;
  final double units;

  /// What the units still held cost.
  final int investedMinor;

  /// Everything ever put in, redemptions or not.
  final int totalInvestedMinor;
  final int valueMinor;
  final int gainMinor;
  final double? gainPercent;
  final int realisedGainMinor;

  /// Null until there are 90 days of history to annualise.
  final double? xirrPercent;
  final int dayChangeMinor;
  final double? dayChangePercent;
  final NavPoint? nav;
  final String? firstOn;
  final int heldDays;
  final int monthlySipMinor;
  final double? oneYearPercent;
  final double? threeYearPercent;
  final HoldingPeers? peers;
  final List<String> flags;

  /// Bought, but the NAV for the day isn't out yet.
  final int pendingCount;
  final bool stale;

  const FundHolding({
    required this.id,
    required this.schemeCode,
    required this.schemeName,
    this.fundHouse,
    this.category,
    this.categoryKey,
    this.categoryLabel = 'Other',
    this.assetClass = 'other',
    this.isDirect = false,
    this.isGrowth = false,
    this.isRegular = false,
    this.folio,
    this.sip,
    this.opening,
    this.commitmentId,
    this.units = 0,
    this.investedMinor = 0,
    this.totalInvestedMinor = 0,
    this.valueMinor = 0,
    this.gainMinor = 0,
    this.gainPercent,
    this.realisedGainMinor = 0,
    this.xirrPercent,
    this.dayChangeMinor = 0,
    this.dayChangePercent,
    this.nav,
    this.firstOn,
    this.heldDays = 0,
    this.monthlySipMinor = 0,
    this.oneYearPercent,
    this.threeYearPercent,
    this.peers,
    this.flags = const [],
    this.pendingCount = 0,
    this.stale = false,
  });

  factory FundHolding.fromJson(Map<String, dynamic> json) {
    final returns = _map(json['returns']) ?? const {};
    final assetClass = json['assetClass'];
    return FundHolding(
      id: _str(json['id']) ?? '',
      schemeCode: _int(json['schemeCode']),
      schemeName: _str(json['schemeName']) ?? 'Unnamed fund',
      fundHouse: _str(json['fundHouse']),
      category: _str(json['category']),
      categoryKey: _str(json['categoryKey']),
      categoryLabel: _str(json['categoryLabel']) ?? _str(json['category']) ?? 'Other',
      assetClass: const ['equity', 'debt', 'hybrid', 'other'].contains(assetClass) ? assetClass as String : 'other',
      isDirect: _bool(json['isDirect']),
      isGrowth: _bool(json['isGrowth']),
      isRegular: _bool(json['isRegular']),
      folio: _str(json['folio']),
      sip: FundSip.maybe(json['sip']),
      opening: FundOpening.maybe(json['opening']),
      commitmentId: _str(json['commitmentId']),
      units: _num(json['units']),
      investedMinor: _int(json['investedMinor']),
      totalInvestedMinor: _int(json['totalInvestedMinor'], _int(json['investedMinor'])),
      valueMinor: _int(json['valueMinor']),
      gainMinor: _int(json['gainMinor']),
      gainPercent: _numOrNull(json['gainPercent']),
      realisedGainMinor: _int(json['realisedGainMinor']),
      xirrPercent: _numOrNull(json['xirrPercent']),
      dayChangeMinor: _int(json['dayChangeMinor']),
      dayChangePercent: _numOrNull(json['dayChangePercent']),
      nav: NavPoint.maybe(json['nav']),
      firstOn: _str(json['firstOn']),
      heldDays: _int(json['heldDays']),
      monthlySipMinor: _int(json['monthlySipMinor']),
      oneYearPercent: _numOrNull(returns['oneYearPercent']),
      threeYearPercent: _numOrNull(returns['threeYearPercent']),
      peers: HoldingPeers.maybe(json['peers']),
      flags: _strings(json['flags']).where(FundFlag.all.contains).toList(),
      pendingCount: _int(json['pendingCount']),
      stale: _bool(json['stale']),
    );
  }

  /// The fund's own return on the period its rank goes by.
  double? get basisReturn =>
      peers?.basis == '3y' ? threeYearPercent : (peers?.basis == '1y' ? oneYearPercent : null);

  /// A SIP that is still going in each month - the server's call, since it
  /// knows today's date in IST and whether the end date has passed.
  bool get sipRunning => sip != null && monthlySipMinor > 0;
}

/// The ledger's kinds of line.
class FundTxnKind {
  const FundTxnKind._();
  static const opening = 'OPENING';
  static const sipScheduled = 'SIP_SCHEDULED';
  static const linked = 'LINKED';
  static const manualBuy = 'MANUAL_BUY';
  static const redeem = 'REDEEM';
}

/// One line of a holding's history.
class FundLedgerEntry {
  final String kind;
  final String on;
  final String? navDay;
  final double? nav;
  final int amountMinor;
  final double units;

  /// Whether it's in the totals. A line inside the opening snapshot is
  /// shown but not counted - the snapshot already holds it.
  final bool counted;

  /// Bought, waiting for the day's NAV.
  final bool pending;
  final String? note;
  final String? transactionId;

  /// The server's id for a line added by hand, which can be deleted.
  final String? txnId;

  /// "link" or "commitment" for a debit from SpendLog.
  final String? via;

  const FundLedgerEntry({
    required this.kind,
    required this.on,
    this.navDay,
    this.nav,
    this.amountMinor = 0,
    this.units = 0,
    this.counted = true,
    this.pending = false,
    this.note,
    this.transactionId,
    this.txnId,
    this.via,
  });

  factory FundLedgerEntry.fromJson(Map<String, dynamic> json) => FundLedgerEntry(
        kind: _str(json['kind']) ?? FundTxnKind.manualBuy,
        on: _str(json['on']) ?? '',
        navDay: _str(json['navDay']),
        nav: _numOrNull(json['nav']),
        amountMinor: _int(json['amountMinor']),
        units: _num(json['units']),
        // Missing means it's an ordinary, counted line.
        counted: json['counted'] is bool ? json['counted'] as bool : true,
        pending: _bool(json['pending']),
        note: _str(json['note']),
        transactionId: _str(json['transactionId']),
        txnId: _str(json['txnId']),
        via: _str(json['via']),
      );

  bool get isManual => kind == FundTxnKind.manualBuy || kind == FundTxnKind.redeem;
}

/// A holding with its full history and a year of NAVs.
class HoldingDetail {
  final FundHolding holding;

  /// Newest first.
  final List<FundLedgerEntry> txns;
  final List<NavPoint> sparkline;
  final String? navError;

  const HoldingDetail({required this.holding, this.txns = const [], this.sparkline = const [], this.navError});

  factory HoldingDetail.fromJson(Map<String, dynamic> json) => HoldingDetail(
        holding: FundHolding.fromJson(json),
        txns: [for (final row in _maps(json['txns'])) FundLedgerEntry.fromJson(row)],
        sparkline: [
          for (final row in json['sparkline'] is List ? json['sparkline'] as List : const [])
            if (NavPoint.maybe(row) case final point?) point,
        ],
        navError: _str(json['navError']),
      );
}

class PortfolioTotals {
  final int investedMinor;
  final int valueMinor;
  final int gainMinor;
  final double? gainPercent;
  final double? xirrPercent;
  final int dayChangeMinor;
  final double? dayChangePercent;
  final int monthlySipMinor;

  const PortfolioTotals({
    this.investedMinor = 0,
    this.valueMinor = 0,
    this.gainMinor = 0,
    this.gainPercent,
    this.xirrPercent,
    this.dayChangeMinor = 0,
    this.dayChangePercent,
    this.monthlySipMinor = 0,
  });

  factory PortfolioTotals.fromJson(Object? value) {
    final json = _map(value) ?? const {};
    return PortfolioTotals(
      investedMinor: _int(json['investedMinor']),
      valueMinor: _int(json['valueMinor']),
      gainMinor: _int(json['gainMinor']),
      gainPercent: _numOrNull(json['gainPercent']),
      xirrPercent: _numOrNull(json['xirrPercent']),
      dayChangeMinor: _int(json['dayChangeMinor']),
      dayChangePercent: _numOrNull(json['dayChangePercent']),
      monthlySipMinor: _int(json['monthlySipMinor']),
    );
  }
}

class AllocationSlice {
  /// equity | debt | hybrid | other
  final String assetClass;
  final int valueMinor;
  final double percent;

  const AllocationSlice({required this.assetClass, this.valueMinor = 0, this.percent = 0});

  factory AllocationSlice.fromJson(Map<String, dynamic> json) => AllocationSlice(
        assetClass: _str(json['assetClass']) ?? 'other',
        valueMinor: _int(json['valueMinor']),
        percent: _num(json['percent']),
      );
}

/// Whether the category table (every scheme's 1y and 3y returns, for the
/// ranks) has been built yet. It's built on first use and can take a while.
class PeersStatus {
  final bool available;
  final String? asOf;

  const PeersStatus({this.available = false, this.asOf});

  factory PeersStatus.fromJson(Object? value) {
    final json = _map(value) ?? const {};
    return PeersStatus(available: _bool(json['available']), asOf: _str(json['asOf']));
  }
}

/// The thresholds behind the flags, so the app can explain them. The
/// defaults are the server's at the time of writing.
class FlagRules {
  final int minPeers;
  final double bottomPercentile;
  final double belowMedianPp3y;
  final double belowMedianPp1y;
  final double liquidRatePercent;
  final int lowXirrAfterDays;

  const FlagRules({
    this.minPeers = 5,
    this.bottomPercentile = 25,
    this.belowMedianPp3y = 2,
    this.belowMedianPp1y = 3,
    this.liquidRatePercent = 6.5,
    this.lowXirrAfterDays = 365,
  });

  factory FlagRules.fromJson(Object? value) {
    final json = _map(value) ?? const {};
    final pp = _map(json['belowMedianPp']) ?? const {};
    const defaults = FlagRules();
    return FlagRules(
      minPeers: _int(json['minPeers'], defaults.minPeers),
      bottomPercentile: _num(json['bottomPercentile'], defaults.bottomPercentile),
      belowMedianPp3y: _num(pp['3y'], defaults.belowMedianPp3y),
      belowMedianPp1y: _num(pp['1y'], defaults.belowMedianPp1y),
      liquidRatePercent: _num(json['liquidRatePercent'], defaults.liquidRatePercent),
      lowXirrAfterDays: _int(json['lowXirrAfterDays'], defaults.lowXirrAfterDays),
    );
  }
}

/// `GET /funds/portfolio`.
class FundPortfolio {
  final List<FundHolding> holdings;
  final PortfolioTotals totals;
  final List<AllocationSlice> allocation;
  final String? lastNavDate;

  /// Some NAVs are older than the server means to keep them.
  final bool stale;

  /// Why the last NAV refresh failed, when it did.
  final String? error;
  final PeersStatus peers;
  final FlagRules flagRules;
  final double staleAfterHours;

  const FundPortfolio({
    this.holdings = const [],
    this.totals = const PortfolioTotals(),
    this.allocation = const [],
    this.lastNavDate,
    this.stale = false,
    this.error,
    this.peers = const PeersStatus(),
    this.flagRules = const FlagRules(),
    this.staleAfterHours = 36,
  });

  bool get isEmpty => holdings.isEmpty;

  factory FundPortfolio.fromJson(Map<String, dynamic> json) => FundPortfolio(
        holdings: [for (final row in _maps(json['holdings'])) FundHolding.fromJson(row)],
        totals: PortfolioTotals.fromJson(json['totals']),
        allocation: [for (final row in _maps(json['allocation'])) AllocationSlice.fromJson(row)],
        lastNavDate: _str(json['lastNavDate']),
        stale: _bool(json['stale']),
        error: _str(json['error']),
        peers: PeersStatus.fromJson(json['peers']),
        flagRules: FlagRules.fromJson(json['flagRules']),
        staleAfterHours: _num(json['staleAfterHours'], 36),
      );
}

/// One scheme from `GET /funds/search`.
class SchemeResult {
  final int schemeCode;
  final String schemeName;
  final bool isDirect;
  final bool isGrowth;
  final bool isRegular;

  const SchemeResult({
    required this.schemeCode,
    required this.schemeName,
    this.isDirect = false,
    this.isGrowth = false,
    this.isRegular = false,
  });

  /// A scheme known only by code and name - an example fund on a goal or in
  /// the advice - with its plan and option read off the name.
  factory SchemeResult.named(int schemeCode, String schemeName) => SchemeResult(
        schemeCode: schemeCode,
        schemeName: schemeName,
        isDirect: RegExp(r'\bdirect\b', caseSensitive: false).hasMatch(schemeName),
        isRegular: RegExp(r'\bregular\b', caseSensitive: false).hasMatch(schemeName),
        isGrowth: RegExp(r'\bgrowth\b', caseSensitive: false).hasMatch(schemeName),
      );

  static SchemeResult? maybe(Map<String, dynamic> json) {
    final code = _intOrNull(json['schemeCode']);
    final name = _str(json['schemeName']);
    if (code == null || name == null) return null;
    return SchemeResult(
      schemeCode: code,
      schemeName: name,
      isDirect: _bool(json['isDirect']),
      isGrowth: _bool(json['isGrowth']),
      isRegular: _bool(json['isRegular']),
    );
  }

  /// Direct-Growth first, then Direct, then Growth, then the rest: what
  /// someone adding a fund almost always means. Stable within each group.
  static List<SchemeResult> preferred(List<SchemeResult> results) {
    int score(SchemeResult r) => (r.isDirect ? 2 : 0) + (r.isGrowth ? 1 : 0);
    final indexed = results.indexed.toList()
      ..sort((a, b) {
        final byScore = score(b.$2) - score(a.$2);
        return byScore != 0 ? byScore : a.$1 - b.$1;
      });
    return [for (final (_, result) in indexed) result];
  }
}

class SchemeSearch {
  final List<SchemeResult> results;

  /// mfapi was down: these are schemes the server already knew.
  final bool fromCache;

  const SchemeSearch({this.results = const [], this.fromCache = false});

  factory SchemeSearch.fromJson(Map<String, dynamic> json) => SchemeSearch(
        results: [
          for (final row in _maps(json['results']))
            if (SchemeResult.maybe(row) case final result?) result,
        ],
        fromCache: _bool(json['fromCache']),
      );
}

/// A debit that looks like this holding's SIP instalment.
class LinkSuggestion {
  final String transactionId;
  final String holdingId;
  final String schemeName;
  final DateTime? occurredAt;
  final int amountMinor;
  final String? merchant;
  final int score;
  final List<String> reasons;

  const LinkSuggestion({
    required this.transactionId,
    required this.holdingId,
    this.schemeName = '',
    this.occurredAt,
    this.amountMinor = 0,
    this.merchant,
    this.score = 0,
    this.reasons = const [],
  });

  static LinkSuggestion? maybe(Map<String, dynamic> json) {
    final transactionId = _str(json['transactionId']);
    final holdingId = _str(json['holdingId']);
    if (transactionId == null || holdingId == null) return null;
    final at = _str(json['occurredAt']);
    return LinkSuggestion(
      transactionId: transactionId,
      holdingId: holdingId,
      schemeName: _str(json['schemeName']) ?? '',
      occurredAt: at == null ? null : DateTime.tryParse(at),
      amountMinor: _int(json['amountMinor']),
      merchant: _str(json['merchant']),
      score: _int(json['score']),
      reasons: _strings(json['reasons']),
    );
  }
}

/// A SIP commitment (a fixed monthly cost of kind SIP) not yet connected
/// to a holding.
class CommitmentSuggestion {
  final String commitmentId;
  final String name;
  final int amountMinor;
  final int? dayOfMonth;
  final bool isActive;
  final int matchedDebits;
  final String? suggestedHoldingId;

  const CommitmentSuggestion({
    required this.commitmentId,
    required this.name,
    this.amountMinor = 0,
    this.dayOfMonth,
    this.isActive = true,
    this.matchedDebits = 0,
    this.suggestedHoldingId,
  });

  static CommitmentSuggestion? maybe(Map<String, dynamic> json) {
    final id = _str(json['commitmentId']);
    if (id == null) return null;
    return CommitmentSuggestion(
      commitmentId: id,
      name: _str(json['name']) ?? 'SIP',
      amountMinor: _int(json['amountMinor']),
      dayOfMonth: _intOrNull(json['dayOfMonth']),
      isActive: json['isActive'] is bool ? json['isActive'] as bool : true,
      matchedDebits: _int(json['matchedDebits']),
      suggestedHoldingId: _str(json['suggestedHoldingId']),
    );
  }
}

class LinkSuggestions {
  final List<LinkSuggestion> suggestions;
  final List<CommitmentSuggestion> commitments;

  const LinkSuggestions({this.suggestions = const [], this.commitments = const []});

  bool get isEmpty => suggestions.isEmpty && commitments.isEmpty;
  int get count => suggestions.length + commitments.length;

  factory LinkSuggestions.fromJson(Map<String, dynamic> json) => LinkSuggestions(
        suggestions: [
          for (final row in _maps(json['suggestions']))
            if (LinkSuggestion.maybe(row) case final suggestion?) suggestion,
        ],
        commitments: [
          for (final row in _maps(json['commitments']))
            if (CommitmentSuggestion.maybe(row) case final commitment?) commitment,
        ],
      );

  List<LinkSuggestion> forHolding(String holdingId) =>
      suggestions.where((suggestion) => suggestion.holdingId == holdingId).toList();
}

/// A fund named by scheme code, to look at or add.
class FundRef {
  final int schemeCode;
  final String name;

  const FundRef({required this.schemeCode, required this.name});

  static FundRef? maybe(Map<String, dynamic> json) {
    final code = _intOrNull(json['schemeCode']);
    final name = _str(json['name']) ?? _str(json['schemeName']);
    if (code == null || name == null) return null;
    return FundRef(schemeCode: code, name: name);
  }
}

class AdviceUnderperformer {
  final String holdingId;
  final String schemeName;
  final String reason;

  const AdviceUnderperformer({required this.holdingId, required this.schemeName, required this.reason});
}

class AdviceAction {
  final String title;
  final String detail;
  final int? amountMinor;
  final String? category;
  final List<FundRef> exampleFunds;

  const AdviceAction({
    this.title = '',
    this.detail = '',
    this.amountMinor,
    this.category,
    this.exampleFunds = const [],
  });
}

class AdviceGoalLine {
  final String goalId;
  final String name;
  final String line;

  const AdviceGoalLine({required this.goalId, required this.name, required this.line});
}

/// The disclaimer the server attaches to every piece of advice, kept here
/// for the screen to show before any advice has been made.
const kAdviceDisclaimer =
    "This is not investment advice. Past returns don't guarantee future returns. Mutual fund investments are "
    'subject to market risks: read the scheme documents, and check with a SEBI-registered adviser before '
    'acting on any of it.';

class FundAdvice {
  final String summary;
  final List<AdviceUnderperformer> underperformers;
  final List<AdviceAction> actions;
  final List<AdviceGoalLine> goals;
  final String disclaimer;
  final DateTime? generatedAt;

  const FundAdvice({
    this.summary = '',
    this.underperformers = const [],
    this.actions = const [],
    this.goals = const [],
    this.disclaimer = kAdviceDisclaimer,
    this.generatedAt,
  });

  static FundAdvice? maybe(Object? value) {
    final json = _map(value);
    if (json == null) return null;
    final at = _str(json['generatedAt']);
    return FundAdvice(
      summary: _str(json['summary']) ?? '',
      underperformers: [
        for (final row in _maps(json['underperformers']))
          if (_str(row['reason']) != null)
            AdviceUnderperformer(
              holdingId: _str(row['holdingId']) ?? '',
              schemeName: _str(row['schemeName']) ?? 'A fund',
              reason: _str(row['reason'])!,
            ),
      ],
      actions: [
        for (final row in _maps(json['actions']))
          AdviceAction(
            title: _str(row['title']) ?? '',
            detail: _str(row['detail']) ?? '',
            amountMinor: _intOrNull(row['amountMinor']),
            category: _str(row['category']),
            exampleFunds: [
              for (final fund in _maps(row['exampleFunds']))
                if (FundRef.maybe(fund) case final ref?) ref,
            ],
          ),
      ],
      goals: [
        for (final row in _maps(json['goals']))
          if (_str(row['line']) != null)
            AdviceGoalLine(
              goalId: _str(row['goalId']) ?? '',
              name: _str(row['name']) ?? 'Goal',
              line: _str(row['line'])!,
            ),
      ],
      // Never blank: the screen promises one is always there.
      disclaimer: _str(json['disclaimer']) ?? kAdviceDisclaimer,
      generatedAt: at == null ? null : DateTime.tryParse(at),
    );
  }
}

/// `GET` and `POST /funds/advice`.
class AdviceResponse {
  final FundAdvice? advice;

  /// The IST day it was made.
  final String? day;
  final String? model;

  /// Today's, kept from earlier, rather than made just now.
  final bool cached;

  /// Whether a Gemini key is saved in Settings.
  final bool hasKey;

  const AdviceResponse({this.advice, this.day, this.model, this.cached = false, this.hasKey = false});

  factory AdviceResponse.fromJson(Map<String, dynamic> json) => AdviceResponse(
        advice: FundAdvice.maybe(json['advice']),
        day: _str(json['day']),
        model: _str(json['model']),
        cached: _bool(json['cached']),
        hasKey: _bool(json['hasKey']),
      );
}

/// The return a goal's plan assumes, by how long there is to go.
class GoalAssumption {
  final String id;
  final int fromMonths;

  /// Null for open-ended.
  final int? toMonths;
  final double annualReturnPercent;
  final String category;
  final String why;

  const GoalAssumption({
    required this.id,
    this.fromMonths = 0,
    this.toMonths,
    this.annualReturnPercent = 0,
    this.category = '',
    this.why = '',
  });

  static GoalAssumption? maybe(Object? value) {
    final json = _map(value);
    if (json == null) return null;
    return GoalAssumption(
      id: _str(json['id']) ?? '',
      fromMonths: _int(json['fromMonths']),
      toMonths: _intOrNull(json['toMonths']),
      annualReturnPercent: _num(json['annualReturnPercent']),
      category: _str(json['category']) ?? '',
      why: _str(json['why']) ?? '',
    );
  }
}

/// A fund the plan points at, from the category table.
class ExampleFund {
  final int schemeCode;
  final String name;
  final String? fundHouse;
  final String? categoryLabel;
  final double? oneYearPercent;
  final double? threeYearPercent;

  const ExampleFund({
    required this.schemeCode,
    required this.name,
    this.fundHouse,
    this.categoryLabel,
    this.oneYearPercent,
    this.threeYearPercent,
  });

  static ExampleFund? maybe(Map<String, dynamic> json) {
    final code = _intOrNull(json['schemeCode']);
    final name = _str(json['name']);
    if (code == null || name == null) return null;
    return ExampleFund(
      schemeCode: code,
      name: name,
      fundHouse: _str(json['fundHouse']),
      categoryLabel: _str(json['categoryLabel']),
      oneYearPercent: _numOrNull(json['oneYearPercent']),
      threeYearPercent: _numOrNull(json['threeYearPercent']),
    );
  }
}

class GoalStatus {
  const GoalStatus._();
  static const onTrack = 'on_track';
  static const behind = 'behind';
  static const done = 'done';
}

class GoalProgress {
  final int currentMinor;
  final int holdingsValueMinor;
  final int savedMinor;
  final double percent;

  const GoalProgress({this.currentMinor = 0, this.holdingsValueMinor = 0, this.savedMinor = 0, this.percent = 0});

  factory GoalProgress.fromJson(Object? value) {
    final json = _map(value) ?? const {};
    return GoalProgress(
      currentMinor: _int(json['currentMinor']),
      holdingsValueMinor: _int(json['holdingsValueMinor']),
      savedMinor: _int(json['savedMinor']),
      percent: _num(json['percent']),
    );
  }
}

/// Something to save up for, with its plan.
class FundGoal {
  final String id;
  final String name;
  final int targetMinor;
  final String targetOn;
  final int savedMinor;
  final List<String> holdingIds;
  final GoalProgress progress;
  final int monthsLeft;

  /// What has to go in each month, at the assumed return, to get there.
  final int requiredMonthlyMinor;

  /// Only when the date is here and the money isn't.
  final int lumpSumNeededMinor;

  /// What is actually going in each month now, from the linked funds.
  final int actualMonthlyMinor;
  final int projectedMinor;
  final int shortfallMonthlyMinor;

  /// on_track | behind | done
  final String status;
  final String? warning;
  final GoalAssumption? assumption;
  final String? suggestedCategory;
  final List<ExampleFund> exampleFunds;

  const FundGoal({
    required this.id,
    required this.name,
    required this.targetMinor,
    required this.targetOn,
    this.savedMinor = 0,
    this.holdingIds = const [],
    this.progress = const GoalProgress(),
    this.monthsLeft = 0,
    this.requiredMonthlyMinor = 0,
    this.lumpSumNeededMinor = 0,
    this.actualMonthlyMinor = 0,
    this.projectedMinor = 0,
    this.shortfallMonthlyMinor = 0,
    this.status = GoalStatus.onTrack,
    this.warning,
    this.assumption,
    this.suggestedCategory,
    this.exampleFunds = const [],
  });

  factory FundGoal.fromJson(Map<String, dynamic> json) {
    final status = json['status'];
    final assumption = GoalAssumption.maybe(json['assumption']);
    return FundGoal(
      id: _str(json['id']) ?? '',
      name: _str(json['name']) ?? 'Goal',
      targetMinor: _int(json['targetMinor']),
      targetOn: _str(json['targetOn']) ?? '',
      savedMinor: _int(json['savedMinor']),
      holdingIds: _strings(json['holdingIds']),
      progress: GoalProgress.fromJson(json['progress']),
      monthsLeft: _int(json['monthsLeft']),
      requiredMonthlyMinor: _int(json['requiredMonthlyMinor']),
      lumpSumNeededMinor: _int(json['lumpSumNeededMinor']),
      actualMonthlyMinor: _int(json['actualMonthlyMinor']),
      projectedMinor: _int(json['projectedMinor']),
      shortfallMonthlyMinor: _int(json['shortfallMonthlyMinor']),
      status: status == GoalStatus.behind || status == GoalStatus.done ? status as String : GoalStatus.onTrack,
      warning: _str(json['warning']),
      assumption: assumption,
      suggestedCategory: _str(json['suggestedCategory']) ?? assumption?.category,
      exampleFunds: [
        for (final row in _maps(json['exampleFunds']))
          if (ExampleFund.maybe(row) case final fund?) fund,
      ],
    );
  }
}

/// `GET /goals`.
class GoalsResponse {
  final List<FundGoal> goals;
  final List<GoalAssumption> assumptions;
  final bool peersAvailable;

  const GoalsResponse({this.goals = const [], this.assumptions = const [], this.peersAvailable = false});

  factory GoalsResponse.fromJson(Map<String, dynamic> json) => GoalsResponse(
        goals: [for (final row in _maps(json['goals'])) FundGoal.fromJson(row)],
        assumptions: [
          for (final row in _maps(json['assumptions']))
            if (GoalAssumption.maybe(row) case final assumption?) assumption,
        ],
        peersAvailable: _bool(json['peersAvailable']),
      );
}
