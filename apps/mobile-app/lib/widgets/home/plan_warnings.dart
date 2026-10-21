import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../ds/ds.dart';
import '../../utils/format.dart';

/// The savings-plan rules being broken this month, near the top of Home so
/// they are seen every time the app opens - the whole point of a rule is
/// being reminded of it before the next purchase, not after the month.
class PlanWarnings extends StatelessWidget {
  const PlanWarnings({super.key, required this.warnings, required this.onOpenPlan});

  final List<PlanRule> warnings;
  final VoidCallback onOpenPlan;

  static const _shown = 3;

  @override
  Widget build(BuildContext context) {
    if (warnings.isEmpty) return const SizedBox.shrink();
    final c = context.c;
    final extra = warnings.length - _shown;

    return Padding(
      padding: const EdgeInsets.only(bottom: kCardGap),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final warning in warnings.take(_shown)) _Warning(rule: warning, onTap: onOpenPlan),
          if (extra > 0)
            GestureDetector(
              onTap: onOpenPlan,
              child: Text(
                'and $extra more ${extra == 1 ? 'rule' : 'rules'} slipping - see the savings plan',
                style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: c.ac),
              ),
            ),
        ],
      ),
    );
  }
}

class _Warning extends StatelessWidget {
  const _Warning({required this.rule, required this.onTap});

  final PlanRule rule;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final over = rule.state == 'over';
    final fg = over ? c.crit : c.warn;
    final bg = over ? c.critSoft : c.warnSoft;
    final cap = rule.monthlyCapMinor;
    final spent = rule.spentMinor;

    final String status;
    if (cap != null && spent != null) {
      status = over
          ? '${formatMoneyShort(spent)} of ${formatMoneyShort(cap)} - over the cap'
          : '${formatMoneyShort(spent)} of ${formatMoneyShort(cap)} - ahead of pace'
              '${rule.expectedSoFarMinor != null ? ' (${formatMoneyShort(rule.expectedSoFarMinor!)} by now)' : ''}';
    } else {
      status = over ? 'Broken this month' : 'Slipping this month';
    }

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(Ds.rLg),
          child: Ink(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(Ds.rLg)),
            child: Row(
              children: [
                DsIcon(DsIcons.alertTriangle, size: 20, color: fg),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        rule.text,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: fg),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        rule.category == null ? status : '${rule.category} · $status',
                        style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx2),
                      ),
                    ],
                  ),
                ),
                DsIcon(DsIcons.chevronRight, size: 16, color: fg),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
