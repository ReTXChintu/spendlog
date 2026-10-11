import 'package:intl/intl.dart';
import '../../models/fund_models.dart';
import '../../utils/format.dart';

/// The words the Investments screens put on the server's figures, in one
/// place so the cards, the detail page and the tests agree.

/// "12.3%", "+12.3%" / "−3.2%" when [signed], "—" when there's no figure.
String fundPercent(double? percent, {bool signed = false, int digits = 1}) {
  if (percent == null) return '—';
  final text = '${percent.abs().toStringAsFixed(digits)}%';
  if (percent < 0) return '−$text';
  return signed && percent > 0 ? '+$text' : text;
}

/// "+₹1,350", "−₹420", "₹0": whole rupees with a real minus sign.
String signedMoneyShort(int minor) => '${minor > 0 ? '+' : minor < 0 ? '−' : ''}${formatMoneyShort(minor.abs())}';

/// "₹5,000/month".
String perMonth(int minor) => '${formatMoneyShort(minor)}/month';

/// "9 Oct 2026" from a plain YYYY-MM-DD, parsed as a plain date so no
/// offset can move the day.
String formatIsoLongDate(String isoDate) {
  final parsed = DateTime.tryParse(isoDate);
  return parsed == null ? isoDate : DateFormat('d MMM yyyy').format(parsed);
}

/// A plain calendar date as the server's YYYY-MM-DD.
String isoDay(DateTime date) =>
    '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';

/// "Parag Parikh Flexi Cap Fund" from "Parag Parikh Flexi Cap Fund - Direct
/// Plan - Growth": the plan and option are shown as tags instead.
String shortSchemeName(String name) {
  final planWords = RegExp(
    r'^\(?\s*(direct|regular|growth|idcw|dividend|payout|reinvest(ment)?|option|plan|bonus|monthly|quarterly|annual|daily|weekly|income|distribution|cum|capital|withdrawal|of|and|&|\s)+\)?$',
    caseSensitive: false,
  );
  final segments = name.split(RegExp(r'\s+[-–]\s+|\s*[-–]\s*(?=(direct|regular|growth|idcw)\b)', caseSensitive: false));
  final kept = <String>[segments.first];
  for (final segment in segments.skip(1)) {
    if (!planWords.hasMatch(segment.trim())) kept.add(segment);
  }
  var short = kept.join(' - ').trim();

  // "... Fund Direct Plan Growth", "... Fund (G)", without the dashes.
  final tail = RegExp(
    r'[\s(\-–]*\b(direct|regular|growth|idcw|g)\b(\s*(plan|option))?\)?\s*$',
    caseSensitive: false,
  );
  for (var i = 0; i < 4; i++) {
    final next = short.replaceFirst(tail, '').trim();
    if (next == short || next.isEmpty) break;
    short = next;
  }
  // Nothing left but plan words: the name is all there is.
  return short.isEmpty || planWords.hasMatch(short) ? name : short;
}

/// "₹5,000 on 5th".
String sipLine(FundSip sip) => '${formatMoneyShort(sip.amountMinor)} on ${ordinalDay(sip.dayOfMonth)}';

/// "#12 of 48".
String rankLine(PeerRank rank) => '#${rank.rank} of ${rank.of}';

/// "14 months", "2.3 years", "45 days".
String heldFor(int days) {
  if (days < 60) return '$days ${days == 1 ? 'day' : 'days'}';
  final months = (days / 30.44).round();
  if (months < 24) return '$months months';
  final years = days / 365.25;
  return '${years.toStringAsFixed(years >= 10 ? 0 : 1)} years';
}

/// "3y 9.1% vs median 12.4%".
String returnVsMedian(String period, double? fund, double? median) {
  final own = '$period ${fundPercent(fund)}';
  return median == null ? own : '$own vs median ${fundPercent(median)}';
}

/// The headline on a flag chip: what's wrong, with the numbers.
String flagReason(FundHolding holding, String flag) {
  switch (flag) {
    case FundFlag.laggingCategory:
      final peers = holding.peers;
      final basis = peers?.basis;
      final own = holding.basisReturn;
      final median = peers?.basisMedian;
      if (basis != null && own != null && median != null) {
        return 'Lagging its category: ${returnVsMedian(basis, own, median)}';
      }
      final rank = peers?.rank;
      if (rank != null) return 'Lagging its category: ${rankLine(rank)}${basis == null ? '' : ' on $basis returns'}';
      return 'Lagging its category';
    case FundFlag.lowXirr:
      final xirr = holding.xirrPercent;
      final when = 'after ${heldFor(holding.heldDays)}';
      if (xirr == null) return 'Low return $when';
      return xirr < 0 ? 'Losing money: XIRR ${fundPercent(xirr)} $when' : 'Low return: XIRR ${fundPercent(xirr)} $when';
    case FundFlag.regularPlan:
      return 'Regular plan — the Direct version costs less';
    default:
      return flag;
  }
}

/// Why a flag is raised, from the server's own thresholds.
String flagExplainer(String flag, FlagRules rules) {
  String points(double value) => value == value.roundToDouble() ? value.toInt().toString() : value.toString();
  switch (flag) {
    case FundFlag.laggingCategory:
      return 'Flagged when a fund is in the bottom ${points(rules.bottomPercentile)}% of its category, or more than '
          '${points(rules.belowMedianPp3y)} points a year under the category median on 3-year returns '
          '(${points(rules.belowMedianPp1y)} on 1-year, for a younger fund). Only with at least '
          '${rules.minPeers} other funds to compare against.';
    case FundFlag.lowXirr:
      return 'Flagged when your own return (XIRR) is below zero, or below the '
          '${fundPercent(rules.liquidRatePercent)} a liquid fund pays once you have held it for '
          '${heldFor(rules.lowXirrAfterDays)}.';
    case FundFlag.regularPlan:
      return 'A regular plan pays a distributor commission out of your returns every year. The Direct plan of '
          'the same fund holds the same shares and costs less, so it returns a little more.';
    default:
      return '';
  }
}

/// "Equity", "Debt", "Hybrid", "Other".
String assetClassLabel(String assetClass) => switch (assetClass) {
      'equity' => 'Equity',
      'debt' => 'Debt',
      'hybrid' => 'Hybrid',
      _ => 'Other',
    };

// Goals.

String goalStatusLabel(String status) => switch (status) {
      GoalStatus.done => 'Done',
      GoalStatus.behind => 'Behind',
      _ => 'On track',
    };

/// "8 months left", "1 month left", "Due now".
String monthsLeftLabel(int months) {
  if (months <= 0) return 'Due now';
  return '$months ${months == 1 ? 'month' : 'months'} left';
}

/// "₹2,00,000 by 30 Jun 2027".
String goalTargetLine(FundGoal goal) => '${formatMoneyShort(goal.targetMinor)} by ${formatIsoLongDate(goal.targetOn)}';

/// The one figure a goal card is for: what to put in.
String goalPlanLine(FundGoal goal) {
  if (goal.status == GoalStatus.done) return 'Target reached';
  if (goal.lumpSumNeededMinor > 0) return 'Put in ${formatMoneyShort(goal.lumpSumNeededMinor)} now';
  if (goal.requiredMonthlyMinor > 0) return 'Invest ${perMonth(goal.requiredMonthlyMinor)}';
  return 'Nothing more to add — what you have grows to it';
}

/// "Going in now ₹15,000/month · on course for ₹1,82,000".
String? goalActualLine(FundGoal goal) {
  if (goal.status == GoalStatus.done) return null;
  if (goal.actualMonthlyMinor <= 0) {
    return goal.holdingIds.isEmpty ? 'No funds linked to this goal yet' : 'Nothing going in each month yet';
  }
  return 'Going in now ${perMonth(goal.actualMonthlyMinor)} · on course for ${formatMoneyShort(goal.projectedMinor)}';
}

/// "₹46,000 so far · ₹40,000 in funds + ₹6,000 saved".
String goalSoFarLine(FundGoal goal) {
  final progress = goal.progress;
  final parts = [
    if (progress.holdingsValueMinor > 0) '${formatMoneyShort(progress.holdingsValueMinor)} in funds',
    if (progress.savedMinor > 0) '${formatMoneyShort(progress.savedMinor)} saved',
  ];
  final head = '${formatMoneyShort(progress.currentMinor)} so far';
  return parts.length < 2 ? head : '$head · ${parts.join(' + ')}';
}

/// "Suggested: Liquid / overnight fund (assumes ~6.5% a year — Under a
/// year: the money has to be there on the day, so no equity at all.)"
String? goalSuggestionLine(FundGoal goal) {
  final category = goal.suggestedCategory;
  if (category == null || goal.status == GoalStatus.done) return null;
  final assumption = goal.assumption;
  if (assumption == null) return 'Suggested: $category';
  final rate = assumption.annualReturnPercent;
  final rateText = rate == rate.roundToDouble() ? rate.toInt().toString() : rate.toString();
  final why = assumption.why.isEmpty ? '' : ' — ${assumption.why}';
  return 'Suggested: $category (assumes ~$rateText% a year$why)';
}

/// "Under 12 months", "12–36 months", "Over 60 months".
String assumptionRange(GoalAssumption assumption) {
  final to = assumption.toMonths;
  if (to == null) return '${assumption.fromMonths} months and more';
  if (assumption.fromMonths <= 0) return 'Under ${to + 1} months';
  return '${assumption.fromMonths}–$to months';
}
