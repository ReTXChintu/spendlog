import 'package:flutter/material.dart';
import '../models/models.dart';
import '../theme.dart';
import '../utils/format.dart';

/// A fixed cost's amount, as it stands this period and from the next.
///
/// A change made after this period's payment went out starts with the
/// next one, so for a month the two differ - "₹2,000 this month · ₹3,000
/// from next" - and saying only one of them would be wrong about the other.
class CommitmentAmount extends StatelessWidget {
  const CommitmentAmount({super.key, required this.commitment, this.fontSize = 12.8});

  final FixedCommitment commitment;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    if (!commitment.changesNextPeriod) {
      return Text(
        formatMoney(commitment.amountMinor),
        style: kNum.copyWith(fontSize: fontSize, color: c.ink70),
      );
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text(
          '${formatMoneyShort(commitment.thisPeriodAmountMinor)} this month',
          style: kNum.copyWith(fontSize: fontSize, color: c.ink70),
        ),
        Text(
          '${formatMoneyShort(commitment.amountMinor)} from next',
          style: TextStyle(fontSize: fontSize - 1.8, color: c.muted),
        ),
      ],
    );
  }
}
