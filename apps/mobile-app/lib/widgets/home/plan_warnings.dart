import 'package:flutter/material.dart';
import '../../models/models.dart';
import '../../theme.dart';
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
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final warning in warnings.take(_shown)) _Warning(rule: warning, onTap: onOpenPlan),
          if (extra > 0)
            GestureDetector(
              onTap: onOpenPlan,
              child: Text(
                'and $extra more ${extra == 1 ? 'rule' : 'rules'} slipping - see the savings plan',
                style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: c.muted),
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
    final fg = over ? c.debit : c.warn;
    final bg = over ? c.debit50 : c.warnBg;
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
          borderRadius: BorderRadius.circular(T.rSm),
          child: Ink(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(T.rSm)),
            child: Row(
              children: [
                Icon(over ? Icons.error_outline : Icons.warning_amber_rounded, size: 17, color: fg),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        rule.text,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12.8, fontWeight: FontWeight.w700, color: fg),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        rule.category == null ? status : '${rule.category} · $status',
                        style: TextStyle(fontSize: 11.5, color: fg),
                      ),
                    ],
                  ),
                ),
                Icon(Icons.chevron_right, size: 16, color: fg),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
