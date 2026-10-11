import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/fund_models.dart';
import 'package:spendlog/screens/investments/add_fund_screen.dart';
import 'package:spendlog/screens/investments/goal_editor_screen.dart';
import 'package:spendlog/screens/investments/holding_detail_screen.dart';
import 'package:spendlog/screens/investments/investments_screen.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/utils/format.dart';
import 'package:spendlog/widgets/funds/fund_form.dart';
import 'package:spendlog/widgets/funds/fund_text.dart';
import 'package:spendlog/widgets/funds/goal_card.dart';
import 'package:spendlog/widgets/home/investments_tile.dart';

// Fixtures, shaped as funds.routes.ts and goals.routes.ts send them.

Map<String, dynamic> _holding({
  String id = '64f000000000000000000001',
  String name = 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth',
  bool isRegular = false,
  List<String> flags = const [],
  double? xirr = 14.2,
  int heldDays = 700,
  Object? peers = const {
    'oneYear': {'count': 40, 'averagePercent': 15.1, 'medianPercent': 14.8},
    'threeYear': {'count': 36, 'averagePercent': 16.0, 'medianPercent': 15.5},
    'basis': '3y',
    'rank': {'rank': 4, 'of': 37, 'percentile': 92},
  },
  double? oneYear = 18.4,
  double? threeYear = 21.0,
  int pendingCount = 0,
}) =>
    {
      'id': id,
      'schemeCode': 122639,
      'schemeName': name,
      'fundHouse': 'PPFAS Mutual Fund',
      'category': 'Equity Scheme - Flexi Cap Fund',
      'categoryKey': 'equity:flexi cap',
      'categoryLabel': 'Flexi Cap',
      'assetClass': 'equity',
      'isDirect': !isRegular,
      'isGrowth': true,
      'isRegular': isRegular,
      'folio': '1234567/89',
      'sip': {'amountMinor': 500000, 'dayOfMonth': 5, 'startOn': '2024-11-05', 'endOn': null, 'active': true},
      'opening': {'units': 812.345, 'investedMinor': 5000000, 'asOf': '2024-10-31', 'firstOn': '2022-01-10'},
      'commitmentId': null,
      'units': 1402.118,
      'investedMinor': 11000000,
      'totalInvestedMinor': 11000000,
      'valueMinor': 13456700,
      'gainMinor': 2456700,
      'gainPercent': 22.33,
      'realisedGainMinor': 0,
      'xirrPercent': xirr,
      'dayChangeMinor': 45600,
      'dayChangePercent': 0.34,
      'nav': {'day': '2026-10-09', 'nav': 95.9721},
      'firstOn': '2022-01-10',
      'heldDays': heldDays,
      'monthlySipMinor': 500000,
      'returns': {'oneYearPercent': oneYear, 'threeYearPercent': threeYear},
      'peers': peers,
      'flags': flags,
      'pendingCount': pendingCount,
      'stale': false,
    };

/// A lagging regular plan with a poor XIRR: every flag at once.
final _laggard = _holding(
  id: '64f000000000000000000002',
  name: 'Axis Bluechip Fund - Regular Plan - Growth',
  isRegular: true,
  flags: const ['lagging_category', 'low_xirr', 'regular_plan'],
  xirr: 3.2,
  heldDays: 426,
  oneYear: 7.0,
  threeYear: 9.1,
  pendingCount: 1,
  peers: const {
    'oneYear': {'count': 30, 'averagePercent': 12.0, 'medianPercent': 11.5},
    'threeYear': {'count': 28, 'averagePercent': 12.9, 'medianPercent': 12.4},
    'basis': '3y',
    'rank': {'rank': 26, 'of': 29, 'percentile': 11},
  },
);

Map<String, dynamic> _portfolio({
  List<Map<String, dynamic>>? holdings,
  bool stale = false,
  String? error,
  bool peersAvailable = true,
}) =>
    {
      'holdings': holdings ?? [_holding(), _laggard],
      'totals': {
        'investedMinor': 22000000,
        'valueMinor': 25123400,
        'gainMinor': 3123400,
        'gainPercent': 14.2,
        'xirrPercent': 12.6,
        'dayChangeMinor': -81200,
        'dayChangePercent': -0.32,
        'monthlySipMinor': 1000000,
      },
      'allocation': [
        {'assetClass': 'equity', 'valueMinor': 20000000, 'percent': 79.6},
        {'assetClass': 'debt', 'valueMinor': 4000000, 'percent': 15.9},
        {'assetClass': 'hybrid', 'valueMinor': 1123400, 'percent': 4.5},
        {'assetClass': 'other', 'valueMinor': 0, 'percent': 0},
      ],
      'lastNavDate': '2026-10-09',
      'stale': stale,
      'error': error,
      'peers': {
        'available': peersAvailable,
        'asOf': peersAvailable ? '2026-10-09' : null,
        'oneYearOn': null,
        'threeYearOn': null,
        'fetchedAt': null,
      },
      'flagRules': {
        'minPeers': 5,
        'bottomPercentile': 25,
        'belowMedianPp': {'3y': 2, '1y': 3},
        'liquidRatePercent': 6.5,
        'lowXirrAfterDays': 365,
      },
      'staleAfterHours': 36,
    };

final _emptyPortfolio = _portfolio(holdings: const []);

final _links = {
  'suggestions': [
    {
      'transactionId': '650000000000000000000001',
      'holdingId': '64f000000000000000000001',
      'schemeName': 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth',
      'occurredAt': '2026-10-05T04:30:00.000Z',
      'amountMinor': 500000,
      'merchant': 'BSE STAR MF',
      'score': 7,
      'reasons': ['sip_words', 'amount', 'day'],
    },
  ],
  'commitments': [
    {
      'commitmentId': '660000000000000000000001',
      'name': 'Axis SIP',
      'amountMinor': 500000,
      'dayOfMonth': 10,
      'isActive': true,
      'matchedDebits': 6,
      'suggestedHoldingId': '64f000000000000000000002',
    },
  ],
};

const _noLinks = {'suggestions': [], 'commitments': []};

Map<String, dynamic> _goal({
  String status = 'on_track',
  String? warning,
  int required = 1950000,
  int lump = 0,
  int actual = 2000000,
  List<String> holdingIds = const ['64f000000000000000000001'],
}) =>
    {
      'id': '670000000000000000000001',
      'name': 'Laptop',
      'targetMinor': 20000000,
      'targetOn': '2027-06-30',
      'savedMinor': 600000,
      'holdingIds': holdingIds,
      'progress': {'currentMinor': 4600000, 'holdingsValueMinor': 4000000, 'savedMinor': 600000, 'percent': 23},
      'monthsLeft': 8,
      'requiredMonthlyMinor': required,
      'lumpSumNeededMinor': lump,
      'actualMonthlyMinor': actual,
      'projectedMinor': 21000000,
      'shortfallMonthlyMinor': 0,
      'status': status,
      'warning': warning,
      'assumption': {
        'id': 'liquid',
        'fromMonths': 0,
        'toMonths': 11,
        'annualReturnPercent': 6.5,
        'category': 'Liquid / overnight fund',
        'why': 'Under a year: the money has to be there on the day, so no equity at all.',
      },
      'suggestedCategory': 'Liquid / overnight fund',
      'exampleFunds': [
        {
          'schemeCode': 119800,
          'name': 'Parag Parikh Liquid Fund - Direct Plan - Growth',
          'fundHouse': 'PPFAS Mutual Fund',
          'categoryLabel': 'Liquid',
          'oneYearPercent': 7.21,
          'threeYearPercent': 6.94,
        },
      ],
    };

final _assumptions = [
  {'id': 'liquid', 'fromMonths': 0, 'toMonths': 11, 'annualReturnPercent': 6.5, 'category': 'Liquid / overnight fund', 'why': 'Under a year.'},
  {'id': 'short_debt', 'fromMonths': 12, 'toMonths': 36, 'annualReturnPercent': 7, 'category': 'Short duration debt fund', 'why': 'One to three years.'},
  {'id': 'equity', 'fromMonths': 61, 'toMonths': null, 'annualReturnPercent': 11, 'category': 'Equity index fund (Nifty 50)', 'why': 'Over five years.'},
];

Map<String, dynamic> _goals({List<Map<String, dynamic>>? goals}) => {
      'goals': goals ?? [_goal()],
      'assumptions': _assumptions,
      'peersAvailable': true,
    };

final _advice = {
  'advice': {
    'summary': 'Mostly equity, doing well. One regular plan is costing you.',
    'underperformers': [
      {'holdingId': '64f000000000000000000002', 'schemeName': 'Axis Bluechip Fund - Regular Plan - Growth', 'reason': 'Rank 26 of 29 on 3y.'},
    ],
    'actions': [
      {
        'title': 'Switch to a better large cap',
        'detail': 'Move the Axis SIP to an index fund.',
        'amountMinor': 500000,
        'category': 'Large Cap',
        'exampleFunds': [
          {'schemeCode': 120716, 'name': 'UTI Nifty 50 Index Fund - Direct Plan - Growth'},
        ],
      },
    ],
    'goals': [
      {'goalId': '670000000000000000000001', 'name': 'Laptop', 'line': 'Put ₹19,500/month into a liquid fund.'},
    ],
    'disclaimer': 'This is not investment advice. Past returns don\'t guarantee future returns.',
    'generatedAt': '2026-10-11T03:00:00.000Z',
  },
  'day': istToday(),
  'model': 'gemini-2.5-flash',
  'cached': true,
  'hasKey': true,
};

const _noAdviceNoKey = {'advice': null, 'day': null, 'model': null, 'cached': false, 'hasKey': false};

Map<String, dynamic> _detail(Map<String, dynamic> holding) => {
      ...holding,
      'txns': [
        {'kind': 'SIP_SCHEDULED', 'on': '2026-10-05', 'navDay': null, 'nav': null, 'amountMinor': 500000, 'units': 0, 'counted': true, 'pending': true, 'note': 'Waiting for the NAV', 'transactionId': null, 'txnId': null, 'via': null},
        {'kind': 'LINKED', 'on': '2026-09-05', 'navDay': '2026-09-05', 'nav': 93.1, 'amountMinor': 500000, 'units': 53.706, 'counted': true, 'pending': false, 'note': null, 'transactionId': '650000000000000000000009', 'txnId': '680000000000000000000001', 'via': 'link'},
        {'kind': 'MANUAL_BUY', 'on': '2025-03-01', 'navDay': '2025-03-03', 'nav': 80.0, 'amountMinor': 1000000, 'units': 125, 'counted': true, 'pending': false, 'note': null, 'transactionId': null, 'txnId': '680000000000000000000002', 'via': null},
        {'kind': 'LINKED', 'on': '2024-10-05', 'navDay': '2024-10-07', 'nav': 70.0, 'amountMinor': 500000, 'units': 71.4, 'counted': false, 'pending': false, 'note': 'Inside the opening balance', 'transactionId': '650000000000000000000008', 'txnId': '680000000000000000000003', 'via': 'link'},
        {'kind': 'OPENING', 'on': '2024-10-31', 'navDay': '2024-10-31', 'nav': 61.55, 'amountMinor': 5000000, 'units': 812.345, 'counted': true, 'pending': false, 'note': null, 'transactionId': null, 'txnId': null, 'via': null},
      ],
      'sparkline': [
        for (var i = 0; i < 60; i++) {'day': '2026-${(i ~/ 6 + 1).toString().padLeft(2, '0')}-01', 'nav': 80 + i * 0.3 + (i % 5) * 0.8},
      ],
      'navError': null,
    };

/// Answers each path with its body. A path missing from [routes] is a 404.
http.Response _respond(Map<String, Object> routes, http.Request request) {
  final path = request.url.path;
  for (final entry in routes.entries) {
    if (path.endsWith(entry.key)) {
      final value = entry.value;
      if (value is http.Response) return value;
      return http.Response(jsonEncode(value), 200, headers: {'content-type': 'application/json; charset=utf-8'});
    }
  }
  return http.Response(jsonEncode({'error': 'Not found'}), 404);
}

MockClient _server(Map<String, Object> routes, {List<http.Request>? log}) => MockClient((request) async {
      log?.add(request);
      return _respond(routes, request);
    });

Map<String, Object> _routes({
  Object? portfolio,
  Object? links,
  Object? goals,
  Object? advice,
}) =>
    {
      '/funds/portfolio': portfolio ?? _portfolio(),
      '/funds/link-suggestions': links ?? _links,
      '/goals': goals ?? _goals(),
      '/funds/advice': advice ?? _advice,
    };

/// 360 logical pixels wide.
Future<void> _pump(WidgetTester tester, Widget home, {Brightness brightness = Brightness.light, double height = 7200}) async {
  tester.view.physicalSize = Size(1080, height);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: home));
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('models', () {
    test('FundPortfolio reads holdings, totals, allocation and rules', () {
      final p = FundPortfolio.fromJson(_portfolio());
      expect(p.holdings, hasLength(2));
      expect(p.totals.valueMinor, 25123400);
      expect(p.totals.dayChangeMinor, -81200);
      expect(p.totals.xirrPercent, 12.6);
      expect(p.totals.monthlySipMinor, 1000000);
      expect(p.allocation.map((a) => a.assetClass), ['equity', 'debt', 'hybrid', 'other']);
      expect(p.lastNavDate, '2026-10-09');
      expect(p.peers.available, isTrue);
      expect(p.flagRules.belowMedianPp3y, 2);
      expect(p.flagRules.belowMedianPp1y, 3);
      expect(p.flagRules.liquidRatePercent, 6.5);
      expect(p.staleAfterHours, 36);

      final h = p.holdings.first;
      expect(h.id, '64f000000000000000000001');
      expect(h.schemeCode, 122639);
      expect(h.categoryLabel, 'Flexi Cap');
      expect(h.assetClass, 'equity');
      expect(h.isDirect, isTrue);
      expect(h.sip!.amountMinor, 500000);
      expect(h.sip!.dayOfMonth, 5);
      expect(h.sip!.active, isTrue);
      expect(h.sipRunning, isTrue);
      expect(h.opening!.units, 812.345);
      expect(h.opening!.firstOn, '2022-01-10');
      expect(h.nav!.nav, 95.9721);
      expect(h.oneYearPercent, 18.4);
      expect(h.threeYearPercent, 21.0);
      expect(h.peers!.basis, '3y');
      expect(h.peers!.rank!.rank, 4);
      expect(h.peers!.rank!.of, 37);
      expect(h.peers!.basisMedian, 15.5);
      expect(h.basisReturn, 21.0);

      final laggard = p.holdings[1];
      expect(laggard.flags, ['lagging_category', 'low_xirr', 'regular_plan']);
      expect(laggard.pendingCount, 1);
    });

    test('missing and wrong-shaped fields fall back instead of throwing', () {
      final p = FundPortfolio.fromJson({
        'holdings': [
          {'id': 'x'},
          'not a holding',
          {
            'id': 'y',
            'schemeCode': 1.0,
            'assetClass': 'crypto',
            'sip': {'amountMinor': 100},
            'opening': {'units': 'lots'},
            'peers': {'basis': '5y', 'rank': {'rank': 1}},
            'flags': ['lagging_category', 'made_up', 3],
            'returns': null,
            'nav': {'day': '2026-10-09'},
          },
        ],
        'totals': null,
        'allocation': 'nope',
        'flagRules': {'belowMedianPp': null},
      });
      expect(p.holdings, hasLength(2));
      final bare = p.holdings.first;
      expect(bare.schemeName, 'Unnamed fund');
      expect(bare.categoryLabel, 'Other');
      expect(bare.assetClass, 'other');
      expect(bare.sip, isNull);
      expect(bare.peers, isNull);
      expect(bare.xirrPercent, isNull);
      expect(bare.flags, isEmpty);

      final odd = p.holdings[1];
      expect(odd.schemeCode, 1);
      expect(odd.assetClass, 'other');
      expect(odd.sip, isNull); // no day or start
      expect(odd.opening, isNull);
      expect(odd.peers!.basis, isNull);
      expect(odd.peers!.rank, isNull);
      expect(odd.flags, ['lagging_category']);
      expect(odd.nav, isNull);

      expect(p.totals.valueMinor, 0);
      expect(p.allocation, isEmpty);
      expect(p.peers.available, isFalse);
      expect(p.flagRules.belowMedianPp3y, 2); // the default
      expect(p.flagRules.minPeers, 5);
    });

    test('HoldingDetail reads the ledger and sparkline', () {
      final d = HoldingDetail.fromJson(_detail(_holding()));
      expect(d.txns, hasLength(5));
      expect(d.txns.first.pending, isTrue);
      expect(d.txns[1].via, 'link');
      expect(d.txns[2].isManual, isTrue);
      expect(d.txns[3].counted, isFalse);
      expect(d.txns[3].note, 'Inside the opening balance');
      expect(d.sparkline, hasLength(60));
      expect(HoldingDetail.fromJson({'id': 'z', 'txns': [{}], 'sparkline': [{'day': 'x'}]}).sparkline, isEmpty);
    });

    test('goals, advice, links and search', () {
      final goals = GoalsResponse.fromJson(_goals());
      final goal = goals.goals.single;
      expect(goal.requiredMonthlyMinor, 1950000);
      expect(goal.progress.percent, 23);
      expect(goal.assumption!.annualReturnPercent, 6.5);
      expect(goal.exampleFunds.single.schemeCode, 119800);
      expect(goals.assumptions, hasLength(3));
      expect(goals.assumptions.last.toMonths, isNull);

      final bareGoal = FundGoal.fromJson({'id': 'g', 'status': 'weird', 'assumption': {'category': 'Debt'}});
      expect(bareGoal.status, GoalStatus.onTrack);
      expect(bareGoal.suggestedCategory, 'Debt');
      expect(bareGoal.exampleFunds, isEmpty);

      final advice = AdviceResponse.fromJson(_advice);
      expect(advice.hasKey, isTrue);
      expect(advice.advice!.underperformers.single.holdingId, '64f000000000000000000002');
      expect(advice.advice!.actions.single.amountMinor, 500000);
      expect(advice.advice!.actions.single.exampleFunds.single.schemeCode, 120716);
      expect(advice.advice!.goals.single.line, contains('₹19,500'));

      final none = AdviceResponse.fromJson(_noAdviceNoKey);
      expect(none.advice, isNull);
      expect(none.hasKey, isFalse);
      // A blank disclaimer is never shown blank.
      expect(FundAdvice.maybe({'summary': 'x', 'disclaimer': ''})!.disclaimer, kAdviceDisclaimer);

      final links = LinkSuggestions.fromJson(_links);
      expect(links.count, 2);
      expect(links.forHolding('64f000000000000000000001'), hasLength(1));
      expect(links.commitments.single.suggestedHoldingId, '64f000000000000000000002');
      expect(LinkSuggestions.fromJson({'suggestions': [{'holdingId': 'h'}]}).isEmpty, isTrue);

      final search = SchemeSearch.fromJson({
        'results': [
          {'schemeCode': 1, 'schemeName': 'A Fund - Regular Plan - Growth', 'isRegular': true, 'isGrowth': true},
          {'schemeCode': 2, 'schemeName': 'A Fund - Direct Plan - IDCW', 'isDirect': true},
          {'schemeCode': 3, 'schemeName': 'A Fund - Direct Plan - Growth', 'isDirect': true, 'isGrowth': true},
          {'schemeName': 'no code'},
        ],
        'fromCache': true,
      });
      expect(search.fromCache, isTrue);
      expect(search.results, hasLength(3));
      expect(SchemeResult.preferred(search.results).map((r) => r.schemeCode), [3, 2, 1]);

      final named = SchemeResult.named(5, 'UTI Nifty 50 Index Fund - Direct Plan - Growth');
      expect(named.isDirect, isTrue);
      expect(named.isGrowth, isTrue);
      expect(named.isRegular, isFalse);
    });
  });

  group('wording', () {
    test('short scheme names drop the plan and option', () {
      expect(shortSchemeName('Parag Parikh Flexi Cap Fund - Direct Plan - Growth'), 'Parag Parikh Flexi Cap Fund');
      expect(shortSchemeName('Axis Bluechip Fund - Regular Plan - Growth'), 'Axis Bluechip Fund');
      expect(shortSchemeName('HDFC Mid-Cap Opportunities Fund - Growth Option - Direct Plan'),
          'HDFC Mid-Cap Opportunities Fund');
      expect(shortSchemeName('Mirae Asset Large Cap Fund Direct Growth'), 'Mirae Asset Large Cap Fund');
      expect(shortSchemeName('Quant Small Cap Fund (G)'), 'Quant Small Cap Fund');
      expect(
        shortSchemeName('ICICI Prudential Equity & Debt Fund - IDCW Payout'),
        'ICICI Prudential Equity & Debt Fund',
      );
      expect(shortSchemeName('Nippon India Growth Fund'), 'Nippon India Growth Fund');
      expect(shortSchemeName('Direct Growth'), 'Direct Growth');
    });

    test('percent, money and SIP lines', () {
      expect(fundPercent(12.34), '12.3%');
      expect(fundPercent(12.34, signed: true), '+12.3%');
      expect(fundPercent(-3.2), '−3.2%');
      expect(fundPercent(null), '—');
      expect(signedMoneyShort(135000), '+₹1,350');
      expect(signedMoneyShort(-42000), '−₹420');
      expect(sipLine(const FundSip(amountMinor: 500000, dayOfMonth: 5, startOn: '2024-01-05')), '₹5,000 on 5th');
      expect(sipLine(const FundSip(amountMinor: 250000, dayOfMonth: 22, startOn: '2024-01-22')), '₹2,500 on 22nd');
      expect(rankLine(const PeerRank(rank: 12, of: 48, percentile: 77)), '#12 of 48');
      expect(heldFor(45), '45 days');
      expect(heldFor(426), '14 months');
      expect(heldFor(840), '2.3 years');
    });

    test('flag reasons say what is wrong, with the numbers', () {
      final laggard = FundHolding.fromJson(_laggard);
      expect(flagReason(laggard, FundFlag.laggingCategory), 'Lagging its category: 3y 9.1% vs median 12.4%');
      expect(flagReason(laggard, FundFlag.regularPlan), 'Regular plan — the Direct version costs less');
      expect(flagReason(laggard, FundFlag.lowXirr), 'Low return: XIRR 3.2% after 14 months');

      final losing = FundHolding.fromJson(_holding(xirr: -4.5, heldDays: 200, flags: const ['low_xirr']));
      expect(flagReason(losing, FundFlag.lowXirr), 'Losing money: XIRR −4.5% after 7 months');

      // Ranked in the bottom quarter but with no median to quote.
      final unranked = FundHolding.fromJson(_holding(peers: {
        'oneYear': {'count': 9},
        'threeYear': {'count': 0},
        'basis': '1y',
        'rank': {'rank': 9, 'of': 10, 'percentile': 11},
      }));
      expect(flagReason(unranked, FundFlag.laggingCategory), 'Lagging its category: #9 of 10 on 1y returns');

      const rules = FlagRules();
      expect(flagExplainer(FundFlag.laggingCategory, rules), contains('bottom 25% of its category'));
      expect(flagExplainer(FundFlag.laggingCategory, rules), contains('more than 2 points a year'));
      expect(flagExplainer(FundFlag.lowXirr, rules), contains('6.5% a liquid fund pays'));
      expect(flagExplainer(FundFlag.regularPlan, rules), contains('distributor commission'));
    });

    test('goal lines for each status', () {
      final onTrack = FundGoal.fromJson(_goal());
      expect(goalStatusLabel(onTrack.status), 'On track');
      expect(goalTargetLine(onTrack), '₹2,00,000 by 30 Jun 2027');
      expect(monthsLeftLabel(onTrack.monthsLeft), '8 months left');
      expect(goalPlanLine(onTrack), 'Invest ₹19,500/month');
      expect(goalActualLine(onTrack), 'Going in now ₹20,000/month · on course for ₹2,10,000');
      expect(goalSoFarLine(onTrack), '₹46,000 so far · ₹40,000 in funds + ₹6,000 saved');
      expect(
        goalSuggestionLine(onTrack),
        'Suggested: Liquid / overnight fund (assumes ~6.5% a year — Under a year: the money has to be there on '
        'the day, so no equity at all.)',
      );

      final behind = FundGoal.fromJson(_goal(status: 'behind', actual: 0, holdingIds: const [], warning: 'x'));
      expect(goalStatusLabel(behind.status), 'Behind');
      expect(goalPlanLine(behind), 'Invest ₹19,500/month');
      expect(goalActualLine(behind), 'No funds linked to this goal yet');

      final late = FundGoal.fromJson({..._goal(status: 'behind', required: 0, lump: 5000000), 'monthsLeft': 0});
      expect(goalPlanLine(late), 'Put in ₹50,000 now');
      expect(monthsLeftLabel(late.monthsLeft), 'Due now');

      final done = FundGoal.fromJson(_goal(status: 'done'));
      expect(goalStatusLabel(done.status), 'Done');
      expect(goalPlanLine(done), 'Target reached');
      expect(goalActualLine(done), isNull);
      expect(goalSuggestionLine(done), isNull);

      expect(monthsLeftLabel(1), '1 month left');
      expect(assumptionRange(GoalAssumption.maybe(_assumptions[0])!), 'Under 12 months');
      expect(assumptionRange(GoalAssumption.maybe(_assumptions[1])!), '12–36 months');
      expect(assumptionRange(GoalAssumption.maybe(_assumptions[2])!), '61 months and more');
    });

    testWidgets('the goal card shows the plan, status, warning and examples', (tester) async {
      final holdings = FundPortfolio.fromJson(_portfolio()).holdings;
      Future<void> card(Map<String, dynamic> json) async {
        await _pump(
          tester,
          Scaffold(
            body: SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: GoalCard(goal: FundGoal.fromJson(json), holdings: holdings, onExampleFund: (_) {}),
            ),
          ),
          height: 2400,
        );
      }

      await card(_goal());
      expect(find.text('On track'), findsOneWidget);
      expect(find.text('Invest ₹19,500/month'), findsOneWidget);
      expect(find.text('₹2,00,000 by 30 Jun 2027 · 8 months left'), findsOneWidget);
      expect(find.textContaining('Suggested: Liquid / overnight fund (assumes ~6.5% a year'), findsOneWidget);
      expect(find.text('Parag Parikh Liquid Fund'), findsOneWidget);
      expect(find.text('1y 7.2% · 3y 6.9%'), findsOneWidget);
      expect(find.text('Counting: Parag Parikh Flexi Cap Fund'), findsOneWidget);

      await card(_goal(status: 'behind', warning: '₹4,500 a month short: put in ₹19,500 a month to get there by 2027-06-30.'));
      expect(find.text('Behind'), findsOneWidget);
      expect(find.textContaining('₹4,500 a month short'), findsOneWidget);

      await card(_goal(status: 'done', warning: null));
      expect(find.text('Done'), findsOneWidget);
      expect(find.text('Target reached'), findsOneWidget);
      expect(find.text('Parag Parikh Liquid Fund'), findsNothing);
      expect(find.textContaining('Suggested:'), findsNothing);
    });
  });

  group('forms', () {
    const today = '2026-10-11';

    test('add fund: neither section is allowed, bare', () {
      const data = FundFormData();
      expect(data.isBare, isTrue);
      final check = data.check(today);
      expect(check.ok, isTrue);
      expect(check.createBody(122639), {'schemeCode': 122639});
    });

    test('add fund: units held need units, cost and a past date', () {
      expect(const FundFormData(holdsUnits: true, invested: '1000', asOf: today).check(today).error,
          'Enter the units you hold.');
      expect(const FundFormData(holdsUnits: true, units: '0', invested: '1000', asOf: today).check(today).error,
          'Enter the units you hold.');
      expect(const FundFormData(holdsUnits: true, units: '10', asOf: today).check(today).error,
          'Enter what those units cost you in all.');
      expect(const FundFormData(holdsUnits: true, units: '10', invested: '1000', asOf: '2026-10-12').check(today).error,
          "The units can't be as of a future date.");
      expect(
        const FundFormData(holdsUnits: true, units: '10', invested: '1000', asOf: '2026-01-01', firstOn: '2026-02-01')
            .check(today)
            .error,
        "The first investment can't be after the as-of date.",
      );

      final ok = const FundFormData(
        holdsUnits: true,
        units: '1,234.567',
        invested: '₹1,00,000',
        asOf: '2026-09-30',
        firstOn: '2022-01-10',
        folio: ' 123/45 ',
      ).check(today);
      expect(ok.ok, isTrue);
      expect(ok.createBody(1), {
        'schemeCode': 1,
        'folio': '123/45',
        'opening': {'units': 1234.567, 'investedMinor': 10000000, 'asOf': '2026-09-30', 'firstOn': '2022-01-10'},
      });
    });

    test('add fund: a SIP needs an amount, a day of the month and a start', () {
      expect(const FundFormData(runsSip: true, sipDay: '5', sipStart: today).check(today).error, 'Enter the SIP amount.');
      expect(const FundFormData(runsSip: true, sipAmount: '5000', sipDay: '32', sipStart: today).check(today).error,
          'The SIP day is a date of the month, 1 to 31.');
      expect(const FundFormData(runsSip: true, sipAmount: '5000', sipDay: '5').check(today).error,
          'Pick when the SIP started.');
      expect(
        const FundFormData(runsSip: true, sipAmount: '5000', sipDay: '5', sipStart: '2026-01-05', sipEnd: '2025-01-05')
            .check(today)
            .error,
        "The SIP can't end before it starts.",
      );
      final ok = const FundFormData(runsSip: true, sipAmount: '5000', sipDay: '5', sipStart: '2024-11-05').check(today);
      expect(ok.createBody(9)['sip'], {
        'amountMinor': 500000,
        'dayOfMonth': 5,
        'startOn': '2024-11-05',
        'endOn': null,
        'active': true,
      });
      expect(const FundFormData(folio: '12345678901234567890123456789012345678901').check(today).error,
          'A folio number is at most 40 characters.');
    });

    test('goal: a name, a cost and a future date', () {
      expect(const GoalFormData(target: '200000', targetOn: '2027-06-30').check(today, isNew: true).error,
          'Give the goal a name, like "Laptop".');
      expect(const GoalFormData(name: 'Laptop', targetOn: '2027-06-30').check(today, isNew: true).error,
          'Enter how much it will cost.');
      expect(const GoalFormData(name: 'Laptop', target: '200000').check(today, isNew: true).error,
          'Pick when you need the money.');
      expect(const GoalFormData(name: 'Laptop', target: '200000', targetOn: today).check(today, isNew: true).error,
          'Pick a date in the future.');
      // An old goal's date may have passed.
      expect(const GoalFormData(name: 'Laptop', target: '200000', targetOn: today).check(today, isNew: false).error,
          isNull);
      final ok = const GoalFormData(name: ' Laptop ', target: '2,00,000', targetOn: '2027-06-30', saved: '6000', holdingIds: ['h'])
          .check(today, isNew: true);
      expect(ok.body, {
        'name': 'Laptop',
        'targetMinor': 20000000,
        'targetOn': '2027-06-30',
        'savedMinor': 600000,
        'holdingIds': ['h'],
      });
    });

    testWidgets('the add-fund form says what is missing, then posts the body', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(
          tester,
          const AddFundScreen(
            initialScheme: SchemeResult(
              schemeCode: 122639,
              schemeName: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth',
              isDirect: true,
              isGrowth: true,
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Parag Parikh Flexi Cap Fund'), findsOneWidget);
        expect(find.textContaining('Nothing to fill in?'), findsOneWidget);

        await tester.tap(find.text('I run a SIP'));
        await tester.pumpAndSettle();
        expect(find.textContaining('Nothing to fill in?'), findsNothing);

        await tester.tap(find.text('Add to portfolio'));
        await tester.pumpAndSettle();
        expect(find.text('Enter the SIP amount.'), findsOneWidget);
        expect(log, isEmpty);

        await tester.enterText(find.byKey(const ValueKey('sip-amount')), '5000');
        await tester.enterText(find.byKey(const ValueKey('sip-day')), '5');
        await tester.tap(find.text('Add to portfolio'));
        await tester.pumpAndSettle();
      }, () => _server({'/funds/holdings': http.Response(jsonEncode(_detail(_holding())), 201)}, log: log));

      expect(log, hasLength(1));
      final body = jsonDecode(log.single.body) as Map<String, dynamic>;
      expect(body['schemeCode'], 122639);
      expect(body['sip']['amountMinor'], 500000);
      expect(body['sip']['dayOfMonth'], 5);
      expect(body['sip']['startOn'], istToday());
      expect(body.containsKey('opening'), isFalse);
    });

    testWidgets('search prefers Direct-Growth and shows the tags', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const AddFundScreen(), height: 2400);
        await tester.enterText(find.byType(TextField), 'parag');
        await tester.pump(const Duration(milliseconds: 400));
        await tester.pumpAndSettle();
      }, () => _server({
            '/funds/search': {
              'results': [
                {'schemeCode': 1, 'schemeName': 'Parag Parikh Flexi Cap Fund - Regular Plan - Growth', 'isRegular': true, 'isGrowth': true},
                {'schemeCode': 2, 'schemeName': 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth', 'isDirect': true, 'isGrowth': true},
              ],
              'fromCache': false,
            },
          }));

      final direct = tester.getTopLeft(find.text('Parag Parikh Flexi Cap Fund - Direct Plan - Growth'));
      final regular = tester.getTopLeft(find.text('Parag Parikh Flexi Cap Fund - Regular Plan - Growth'));
      expect(direct.dy, lessThan(regular.dy));
      expect(find.text('Direct'), findsOneWidget);
      expect(find.text('Regular'), findsOneWidget);
      expect(find.text('Growth'), findsNWidgets(2));
    });
  });

  group('InvestmentsScreen', () {
    testWidgets('loading, then the header, allocation, links banner and cards', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const InvestmentsScreen());
        expect(find.byType(CircularProgressIndicator), findsWidgets);
        await tester.pumpAndSettle();
      }, () => _server(_routes()));

      expect(find.text('CURRENT VALUE'), findsOneWidget);
      expect(find.text('₹2,51,234'), findsOneWidget);
      expect(find.text('−₹812 (−0.32%) today'), findsOneWidget);
      expect(find.text('₹2,20,000'), findsOneWidget); // invested
      expect(find.text('12.6%'), findsOneWidget); // XIRR
      expect(find.text('₹10,000'), findsOneWidget); // SIPs a month
      expect(find.text('NAV as of 9 Oct 2026'), findsOneWidget);
      expect(find.text('Equity 80%'), findsOneWidget);
      expect(find.text('Hybrid 4.5%'), findsOneWidget);
      expect(find.textContaining('Other 0'), findsNothing);
      expect(find.textContaining('Link SIP payments: 1 payment looks like SIP instalments'), findsOneWidget);
      expect(find.textContaining('Category ranks coming'), findsNothing);

      expect(find.text('Parag Parikh Flexi Cap Fund'), findsOneWidget);
      expect(find.text('PPFAS Mutual Fund · Flexi Cap'), findsNWidgets(2));
      expect(find.text('SIP ₹5,000 on 5th · #4 of 37 in category (3y)'), findsOneWidget);
      expect(find.text('1y 18.4% vs median 14.8% · 3y 21.0% vs median 15.5%'), findsOneWidget);
      expect(find.text('Lagging its category: 3y 9.1% vs median 12.4%'), findsOneWidget);
      expect(find.text('Regular plan — the Direct version costs less'), findsOneWidget);
      expect(find.text('Low return: XIRR 3.2% after 14 months'), findsOneWidget);
      expect(find.text('Regular'), findsOneWidget);
      expect(find.text('1 needs a look'), findsOneWidget);
      expect(find.text('Add fund'), findsOneWidget);
    });

    testWidgets('no holdings invites the first fund', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const InvestmentsScreen());
        await tester.pumpAndSettle();
      }, () => _server(_routes(portfolio: _emptyPortfolio, links: _noLinks)));

      expect(find.text('Track your mutual funds'), findsOneWidget);
      expect(find.text('Add fund'), findsOneWidget); // the state's button, not a FAB
      expect(find.byType(FloatingActionButton), findsNothing);
    });

    testWidgets('stale prices, a failed refresh and ranks still coming', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const InvestmentsScreen());
        await tester.pumpAndSettle();
      }, () => _server(_routes(
            portfolio: _portfolio(stale: true, error: 'mfapi is down', peersAvailable: false),
            links: _noLinks,
          )));

      expect(find.text("Prices are from 9 Oct 2026 · couldn't refresh: mfapi is down"), findsOneWidget);
      expect(find.textContaining('Category ranks coming'), findsOneWidget);
      expect(find.textContaining('Link SIP payments'), findsNothing);
    });

    testWidgets('a failed load says so, and Retry loads again', (tester) async {
      var calls = 0;
      await http.runWithClient(() async {
        await _pump(tester, const InvestmentsScreen());
        await tester.pumpAndSettle();
        expect(find.text("Couldn't load your funds"), findsOneWidget);
        expect(find.text('Server sad'), findsOneWidget);
        await tester.tap(find.text('Retry'));
        await tester.pumpAndSettle();
      }, () => MockClient((request) async {
            if (request.url.path.endsWith('/funds/portfolio')) {
              calls++;
              if (calls == 1) return http.Response(jsonEncode({'error': 'Server sad'}), 500);
              return http.Response(jsonEncode(_portfolio()), 200, headers: {'content-type': 'application/json; charset=utf-8'});
            }
            return _respond(_routes(), request);
          }));

      expect(calls, 2);
      expect(find.text('CURRENT VALUE'), findsOneWidget);
    });

    testWidgets('the Goals tab shows the cards and the assumptions', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const InvestmentsScreen(initialTab: 1));
        await tester.pumpAndSettle();
      }, () => _server(_routes()));

      expect(find.text('Laptop'), findsOneWidget);
      expect(find.text('Invest ₹19,500/month'), findsOneWidget);
      expect(find.text('How the plans are worked out'), findsOneWidget);
      expect(find.text('Under 12 months'), findsOneWidget);
      expect(find.text('Add goal'), findsOneWidget);
    });

    testWidgets('no goals yet invites the first', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const InvestmentsScreen(initialTab: 1));
        await tester.pumpAndSettle();
      }, () => _server(_routes(goals: _goals(goals: const []))));

      expect(find.text('Save up for something'), findsOneWidget);
      expect(find.text('Add a goal'), findsOneWidget);
      expect(find.text('How the plans are worked out'), findsOneWidget);
    });

    testWidgets('advice shows its sections and the disclaimer', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const InvestmentsScreen(initialTab: 2));
        await tester.pumpAndSettle();
      }, () => _server(_routes()));

      expect(find.text('Made today · gemini-2.5-flash'), findsOneWidget);
      expect(find.text('Mostly equity, doing well. One regular plan is costing you.'), findsOneWidget);
      expect(find.text('NOT PERFORMING WELL'), findsOneWidget);
      expect(find.text('Axis Bluechip Fund'), findsOneWidget);
      expect(find.text('Rank 26 of 29 on 3y.'), findsOneWidget);
      expect(find.text('Switch to a better large cap'), findsOneWidget);
      expect(find.text('₹5,000'), findsOneWidget);
      expect(find.text('Large Cap'), findsOneWidget);
      expect(find.text('UTI Nifty 50 Index Fund'), findsOneWidget);
      expect(find.text('Put ₹19,500/month into a liquid fund.'), findsOneWidget);
      expect(find.byKey(const ValueKey('advice-disclaimer')), findsOneWidget);
      expect(find.textContaining('This is not investment advice.'), findsOneWidget);
      expect(find.text('Refresh'), findsOneWidget);
    });

    testWidgets('no key and no advice: how to add one, and still the disclaimer', (tester) async {
      var opened = 0;
      await http.runWithClient(() async {
        await _pump(tester, InvestmentsScreen(initialTab: 2, onOpenAiSettings: () => opened++));
        await tester.pumpAndSettle();
        expect(find.text('Advice needs a Gemini key'), findsOneWidget);
        expect(find.textContaining('Settings → You → AI assistant'), findsOneWidget);
        expect(find.text('Get advice'), findsNothing);
        expect(find.textContaining('This is not investment advice.'), findsOneWidget);
        await tester.tap(find.text('Go to Settings'));
        await tester.pumpAndSettle();
      }, () => _server(_routes(advice: _noAdviceNoKey)));

      expect(opened, 1);
    });

    testWidgets('Get advice posts, and a refusal is shown', (tester) async {
      final log = <http.Request>[];
      await http.runWithClient(() async {
        await _pump(tester, const InvestmentsScreen(initialTab: 2));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Get advice'));
        await tester.pumpAndSettle();
      }, () => MockClient((request) async {
            log.add(request);
            if (request.method == 'POST') return http.Response(jsonEncode({'error': 'Gemini is rate limiting'}), 429);
            final routes = _routes(advice: {..._noAdviceNoKey, 'hasKey': true});
            return _respond(routes, request);
          }));

      expect(log.where((r) => r.method == 'POST').single.url.path, endsWith('/funds/advice'));
      expect(find.text('Gemini is rate limiting'), findsOneWidget);
      expect(find.textContaining('This is not investment advice.'), findsOneWidget);
    });

    testWidgets('tapping a fund opens its page with the ledger', (tester) async {
      await http.runWithClient(() async {
        await _pump(tester, const InvestmentsScreen());
        await tester.pumpAndSettle();
        await tester.tap(find.text('Axis Bluechip Fund'));
        await tester.pumpAndSettle();
      }, () => _server({..._routes(), '/funds/holdings/64f000000000000000000002': _detail(_laggard)}));

      expect(find.text('NAV over the year'), findsOneWidget);
      expect(find.text('Waiting for NAV'), findsOneWidget);
      expect(find.text('Inside the opening balance'), findsOneWidget);
      expect(find.text('Opening balance'), findsOneWidget);
      expect(find.text('Linked payment'), findsNWidgets(2));
      expect(find.textContaining('#26 of 29', findRichText: true), findsOneWidget);
      expect(find.textContaining('Flagged when a fund is in the bottom 25%'), findsOneWidget);
    });
  });

  group('dashboard tile', () {
    testWidgets('value and today, an invitation, loading and failed', (tester) async {
      await tile(tester, FundPortfolio.fromJson(_portfolio()));
      expect(find.text('MUTUAL FUNDS · 2 FUNDS'), findsOneWidget);
      expect(find.text('₹2,51,234'), findsOneWidget);
      expect(find.text('−₹812 today'), findsOneWidget);
      expect(find.text('SIPs ₹10,000/month · 1 needs a look'), findsOneWidget);

      await tile(tester, FundPortfolio.fromJson(_emptyPortfolio));
      expect(find.text('Track your mutual funds'), findsOneWidget);

      await tile(tester, null);
      expect(find.text('Loading your funds…'), findsOneWidget);

      await tile(tester, null, failed: true);
      expect(find.textContaining("Couldn't load your funds"), findsOneWidget);
    });
  });

  group('no overflow at 360 px', () {
    final long = _holding(
      id: '64f000000000000000000003',
      name: 'Aditya Birla Sun Life Banking and Financial Services Fund - Regular Plan - Income Distribution cum '
          'Capital Withdrawal',
      isRegular: true,
      flags: const ['lagging_category', 'low_xirr', 'regular_plan'],
      xirr: -12.34,
    );
    final routes = _routes(
      portfolio: _portfolio(holdings: [_holding(), _laggard, long], stale: true, error: 'AMFI took too long to answer'),
      goals: _goals(goals: [
        _goal(),
        {..._goal(status: 'behind', warning: '₹4,50,000 a month short: put in ₹19,50,000 a month to get there.'), 'name': 'A very long goal name for a house deposit in Bengaluru'},
        _goal(status: 'done'),
      ]),
    );

    for (final brightness in Brightness.values) {
      for (final (tab, last) in [(0, 'Category figures compare'), (1, 'How the plans are worked out'), (2, 'This is not investment advice')]) {
        testWidgets('tab $tab (${brightness.name})', (tester) async {
          await http.runWithClient(() async {
            await _pump(tester, InvestmentsScreen(initialTab: tab), brightness: brightness, height: 2400);
            await tester.pumpAndSettle();
          }, () => _server(routes));
          expect(tester.takeException(), isNull);

          await tester.scrollUntilVisible(
            find.textContaining(last),
            300,
            scrollable: find.byType(Scrollable).last,
          );
          expect(tester.takeException(), isNull);
        });
      }

      testWidgets('holding detail (${brightness.name})', (tester) async {
        await http.runWithClient(() async {
          await _pump(
            tester,
            HoldingDetailScreen(holdingId: '64f000000000000000000003', links: LinkSuggestions.fromJson({
              ..._links,
              'suggestions': [
                {...(_links['suggestions'] as List).first as Map<String, dynamic>, 'holdingId': '64f000000000000000000003'},
              ],
            })),
            brightness: brightness,
            height: 2400,
          );
          await tester.pumpAndSettle();
        }, () => _server({'/funds/holdings/64f000000000000000000003': _detail(long)}));
        expect(tester.takeException(), isNull);

        await tester.scrollUntilVisible(find.text('Remove fund'), 300, scrollable: find.byType(Scrollable).last);
        expect(tester.takeException(), isNull);
      });

      testWidgets('add fund form and goal editor (${brightness.name})', (tester) async {
        await http.runWithClient(() async {
          await _pump(
            tester,
            AddFundScreen(initialScheme: SchemeResult.named(1, long['schemeName'] as String)),
            brightness: brightness,
            height: 2400,
          );
          await tester.pumpAndSettle();
          await tester.tap(find.text('I already hold units'));
          await tester.tap(find.text('I run a SIP'));
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);

          await _pump(
            tester,
            GoalEditorScreen(
              goal: FundGoal.fromJson(_goal()),
              holdings: FundPortfolio.fromJson(_portfolio(holdings: [_holding(), long])).holdings,
            ),
            brightness: brightness,
            height: 2400,
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
        }, () => _server(const {}));
      });

      testWidgets('dashboard tile (${brightness.name})', (tester) async {
        await tile(tester, FundPortfolio.fromJson(_portfolio(holdings: [_holding(), _laggard, long])), b: brightness);
        expect(tester.takeException(), isNull);
      });
    }
  });
}

/// The dashboard tile on its own, 360 px wide.
Future<void> tile(WidgetTester tester, FundPortfolio? portfolio, {bool failed = false, Brightness b = Brightness.light}) =>
    _pump(
      tester,
      Scaffold(
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: InvestmentsTile(portfolio: portfolio, failed: failed, onTap: () {}),
        ),
      ),
      brightness: b,
      height: 2400,
    );
