import 'package:flutter/material.dart';
import '../ds/ds.dart';

/// One entry in a [HomeGrid]: a half-width tile, or one spanning both columns.
class GridItem {
  const GridItem(this.child, {this.span = 1});

  final Widget child;

  /// 1 = half the width, 2 = the whole row.
  final int span;
}

/// Two compact tiles to a row, with a tile spanning both when its content
/// needs the room.
///
/// Paired tiles are made the same height (the taller one wins) and never
/// shorter than most of their width, so a row reads as two squares rather
/// than two ragged boxes. A half tile left without a partner takes the whole
/// row instead of leaving a hole beside it.
class HomeGrid extends StatelessWidget {
  const HomeGrid({super.key, required this.items, this.gap = kCardGap, this.squareness = 0.8});

  final List<GridItem> items;
  final double gap;

  /// Minimum tile height as a share of its width; 0 lets short tiles stay short.
  final double squareness;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final half = (constraints.maxWidth - gap) / 2;
        final rows = <Widget>[];
        GridItem? waiting;

        void add(Widget row) {
          if (rows.isNotEmpty) rows.add(SizedBox(height: gap));
          rows.add(row);
        }

        for (final item in items) {
          if (item.span >= 2) {
            if (waiting != null) {
              add(waiting.child);
              waiting = null;
            }
            add(item.child);
          } else if (waiting == null) {
            waiting = item;
          } else {
            final left = waiting;
            add(IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(child: ConstrainedBox(constraints: BoxConstraints(minHeight: half * squareness), child: left.child)),
                  SizedBox(width: gap),
                  Expanded(child: ConstrainedBox(constraints: BoxConstraints(minHeight: half * squareness), child: item.child)),
                ],
              ),
            ));
            waiting = null;
          }
        }
        if (waiting != null) add(waiting.child);

        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
      },
    );
  }
}

/// The frame every Home tile shares: a stat-tile card (§7.5) with a
/// sentence-case label, then the content.
class HomeTile extends StatelessWidget {
  const HomeTile({
    super.key,
    required this.label,
    required this.child,
    this.icon,
    this.onTap,
    this.background,
    this.accent,
  });

  final String label;
  final Widget child;

  /// A [DsGlyph] or a Material [IconData].
  final Object? icon;
  final VoidCallback? onTap;

  /// A tint for tiles that need attention; the plain surface otherwise.
  final Color? background;
  final Color? accent;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final labelColour = accent ?? c.tx2;

    return DsCard(
      onTap: onTap,
      color: background,
      borderColor: background == null ? null : Colors.transparent,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (icon != null) ...[
                dsIconOf(icon!, size: 16, color: labelColour),
                const SizedBox(width: 8),
              ],
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    height: 16 / 12,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.24,
                    color: labelColour,
                  ),
                ),
              ),
              if (onTap != null) DsIcon(DsIcons.chevronRight, size: 16, color: c.tx3),
            ],
          ),
          const SizedBox(height: 8),
          child,
        ],
      ),
    );
  }
}

/// A big figure that shrinks to fit a half-width tile rather than wrapping:
/// the stat-tile value, 22/28 600 in tabular figures.
class TileFigure extends StatelessWidget {
  const TileFigure(this.text, {super.key, this.color, this.size = 22});

  final String text;
  final Color? color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return FittedBox(
      fit: BoxFit.scaleDown,
      alignment: Alignment.centerLeft,
      child: Text(
        text,
        maxLines: 1,
        style: kNum.copyWith(
          fontSize: size,
          height: 28 / 22,
          fontWeight: FontWeight.w600,
          letterSpacing: size >= 26 ? -0.02 * size : 0,
          color: color ?? context.c.tx,
        ),
      ),
    );
  }
}
