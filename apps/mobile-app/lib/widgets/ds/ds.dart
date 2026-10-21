/// The SpendLog design-system widgets (docs/design-system.md §7, §9.4).
///
/// Import this one file: it re-exports the icon set and the tokens.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme.dart';
import '../../utils/format.dart';
import 'ds_icon.dart';

export '../../theme.dart';
export 'ds_icon.dart';

// ---------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------

/// The semantic tints: soft fill + strong text/icon.
enum DsTone { ac, good, warn, crit, neutral }

extension DsToneColors on DsColors {
  /// Soft background of a tone.
  Color soft(DsTone t) => switch (t) {
        DsTone.ac => acSoft,
        DsTone.good => goodSoft,
        DsTone.warn => warnSoft,
        DsTone.crit => critSoft,
        DsTone.neutral => sunk,
      };

  /// Strong text / icon colour of a tone.
  Color strong(DsTone t) => switch (t) {
        DsTone.ac => ac,
        DsTone.good => good,
        DsTone.warn => warn,
        DsTone.crit => crit,
        DsTone.neutral => tx2,
      };

  /// Bright fill of a tone, for dots and bars.
  Color fill(DsTone t) => switch (t) {
        DsTone.ac => ac,
        DsTone.good => good,
        DsTone.warn => warnFill,
        DsTone.crit => critFill,
        DsTone.neutral => tx3,
      };
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/// Phone page padding: 16 at the sides, a little more at the bottom.
const EdgeInsets kPagePad = EdgeInsets.fromLTRB(16, 16, 16, 32);

/// Gap between cards on a phone.
const double kCardGap = 12;

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/// How an amount reads (§3.2).
enum MoneyKind {
  /// Counted spend: ink, with a true minus (U+2212).
  out,

  /// Money in: green, with a plus.
  inflow,

  /// Not counted (own transfer, card bill, earmarked): tx3, no sign.
  neutral,

  /// Just the figure in ink, no sign (balances, budgets).
  plain,
}

/// "−₹486", "+₹3,420" or "₹10,000". [short] drops the paise.
String moneyText(int amountMinor, MoneyKind kind, {bool short = true}) {
  final body = short ? formatMoneyShort(amountMinor.abs()) : formatMoney(amountMinor.abs());
  return switch (kind) {
    MoneyKind.out => '−$body',
    MoneyKind.inflow => '+$body',
    MoneyKind.neutral || MoneyKind.plain => amountMinor < 0 ? '−$body' : body,
  };
}

Color moneyColor(DsColors c, MoneyKind kind) => switch (kind) {
      MoneyKind.out => c.moneyOut,
      MoneyKind.inflow => c.moneyIn,
      MoneyKind.neutral => c.moneyNeutral,
      MoneyKind.plain => c.tx,
    };

/// An amount, signed and coloured per §3.2, in tabular figures.
class DsMoney extends StatelessWidget {
  const DsMoney(
    this.amountMinor, {
    super.key,
    this.kind = MoneyKind.plain,
    this.style,
    this.short = true,
    this.color,
    this.textAlign,
  });

  final int amountMinor;
  final MoneyKind kind;
  final TextStyle? style;
  final bool short;
  final Color? color;
  final TextAlign? textAlign;

  @override
  Widget build(BuildContext context) {
    final base = style ?? const TextStyle(fontSize: 15, fontWeight: FontWeight.w600);
    return Text(
      moneyText(amountMinor, kind, short: short),
      maxLines: 1,
      softWrap: false,
      textAlign: textAlign,
      style: base.copyWith(color: color ?? moneyColor(context.c, kind), fontFeatures: Ds.tabular),
    );
  }
}

// ---------------------------------------------------------------------------
// Cards and surfaces
// ---------------------------------------------------------------------------

/// A section card: `sf`, 1 px `ln` border, radius 14, no shadow. Phone
/// padding is 16 (§6.3).
class DsCard extends StatelessWidget {
  const DsCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.color,
    this.borderColor,
    this.radius = Ds.rXl,
    this.onTap,
    this.dashed = false,
    this.margin,
    this.clip = false,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color? color;
  final Color? borderColor;
  final double radius;
  final VoidCallback? onTap;

  /// A dashed `ln2` outline: placeholders, "not set up", "add".
  final bool dashed;
  final EdgeInsetsGeometry? margin;
  final bool clip;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(radius),
      side: dashed ? BorderSide.none : BorderSide(color: borderColor ?? c.ln),
    );
    Widget body = Padding(padding: padding, child: child);
    if (onTap != null) {
      body = InkWell(onTap: onTap, customBorder: shape, child: body);
    }
    Widget card = Material(
      color: color ?? c.sf,
      shape: shape,
      clipBehavior: clip || onTap != null ? Clip.antiAlias : Clip.none,
      child: body,
    );
    if (dashed) {
      card = DsDashedBorder(radius: radius, color: borderColor ?? c.ln2, child: card);
    }
    if (margin != null) card = Padding(padding: margin!, child: card);
    return card;
  }
}

/// A dashed rounded outline around [child].
class DsDashedBorder extends StatelessWidget {
  const DsDashedBorder({
    super.key,
    required this.child,
    this.radius = Ds.rXl,
    this.color,
    this.strokeWidth = 1,
    this.dash = 4,
    this.gap = 3,
  });

  final Widget child;
  final double radius;
  final Color? color;
  final double strokeWidth;
  final double dash;
  final double gap;

  @override
  Widget build(BuildContext context) => CustomPaint(
        foregroundPainter: _DashedPainter(
          color: color ?? context.c.ln2,
          radius: radius,
          strokeWidth: strokeWidth,
          dash: dash,
          gap: gap,
        ),
        child: child,
      );
}

class _DashedPainter extends CustomPainter {
  _DashedPainter({
    required this.color,
    required this.radius,
    required this.strokeWidth,
    required this.dash,
    required this.gap,
  });

  final Color color;
  final double radius, strokeWidth, dash, gap;

  @override
  void paint(Canvas canvas, Size size) {
    final inset = strokeWidth / 2;
    final rrect = RRect.fromRectAndRadius(
      Rect.fromLTWH(inset, inset, size.width - strokeWidth, size.height - strokeWidth),
      Radius.circular(radius),
    );
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth;
    final path = Path()..addRRect(rrect);
    for (final metric in path.computeMetrics()) {
      var d = 0.0;
      while (d < metric.length) {
        canvas.drawPath(metric.extractPath(d, math.min(d + dash, metric.length)), paint);
        d += dash + gap;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedPainter old) =>
      old.color != color || old.radius != radius || old.strokeWidth != strokeWidth;
}

/// A card's header row: `17/24 600` title, optional meta and trailing links.
class DsSectionHeader extends StatelessWidget {
  const DsSectionHeader(this.title, {super.key, this.meta, this.trailing, this.badge, this.padding});

  final String title;
  final String? meta;
  final Widget? badge;
  final Widget? trailing;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: padding ?? EdgeInsets.zero,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Flexible(
            child: Text(
              title,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
            ),
          ),
          if (badge != null) ...[const SizedBox(width: 8), badge!],
          const Spacer(),
          if (meta != null)
            Flexible(
              child: Text(
                meta!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.end,
                style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
              ),
            ),
          if (trailing != null) ...[const SizedBox(width: 8), trailing!],
        ],
      ),
    );
  }
}

/// An eyebrow / field label: `12/16 600 +.02em tx2`.
class DsLabel extends StatelessWidget {
  const DsLabel(this.text, {super.key, this.color, this.padding = EdgeInsets.zero});

  final String text;
  final Color? color;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) => Padding(
        padding: padding,
        child: Text(
          text,
          style: TextStyle(
            fontSize: 12,
            height: 16 / 12,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.24,
            color: color ?? context.c.tx2,
          ),
        ),
      );
}

/// A label above a field, with the spec's 6 px gap.
class DsField extends StatelessWidget {
  const DsField({super.key, required this.label, required this.child, this.help, this.error});

  final String label;
  final Widget child;
  final String? help;
  final String? error;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final note = error ?? help;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        DsLabel(label),
        const SizedBox(height: 6),
        child,
        if (note != null) ...[
          const SizedBox(height: 6),
          Text(note, style: TextStyle(fontSize: 12, height: 16 / 12, color: error != null ? c.crit : c.tx3)),
        ],
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Icon tiles, monograms, avatars
// ---------------------------------------------------------------------------

/// The universal leading element: a rounded-10 square in a soft tint with
/// the icon in the strong tint. [icon] is a [DsGlyph] or an [IconData].
class DsIconTile extends StatelessWidget {
  const DsIconTile(
    this.icon, {
    super.key,
    this.tone = DsTone.neutral,
    this.size = 40,
    this.onTinted = false,
    this.iconSize,
    this.color,
    this.background,
  });

  final Object icon;
  final DsTone tone;
  final double size;

  /// On a tinted row: `sf` fill with the strong colour.
  final bool onTinted;
  final double? iconSize;

  /// Overrides for a category's own colour.
  final Color? color;
  final Color? background;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final fg = color ?? c.strong(tone);
    final bg = background ?? (onTinted ? c.sf : c.soft(tone));
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(Ds.rMd)),
      child: dsIconOf(icon, size: iconSize ?? (size >= 36 ? 20 : size * 0.55), color: fg),
    );
  }
}

/// Two-letter initials of a name: "Third Wave Coffee" → "TW".
String initialsOf(String name) {
  final words = name
      .replaceAll(RegExp(r'[^A-Za-z0-9 ]'), ' ')
      .split(' ')
      .where((w) => w.isNotEmpty)
      .toList();
  if (words.isEmpty) return '?';
  if (words.length == 1) {
    final w = words.first;
    return (w.length >= 2 ? w.substring(0, 2) : w).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/// A merchant monogram: 36/40 square radius 10, initials 13/600 in a tint.
class DsMonogram extends StatelessWidget {
  const DsMonogram(this.name, {super.key, this.tone = DsTone.neutral, this.size = 40, this.onTinted = false});

  final String name;
  final DsTone tone;
  final double size;
  final bool onTinted;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: onTinted ? c.sf : c.soft(tone),
        borderRadius: BorderRadius.circular(Ds.rMd),
      ),
      child: Text(
        initialsOf(name),
        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.strong(tone), height: 1),
      ),
    );
  }
}

/// A person: a circle with initials. [ink] is the header avatar (tx fill).
class DsAvatar extends StatelessWidget {
  const DsAvatar(this.name, {super.key, this.size = 36, this.tone = DsTone.ac, this.ink = false});

  final String name;
  final double size;
  final DsTone tone;
  final bool ink;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: ink ? c.tx : c.soft(tone), shape: BoxShape.circle),
      child: Text(
        initialsOf(name),
        style: TextStyle(
          fontSize: size >= 40 ? 14 : 13,
          fontWeight: FontWeight.w600,
          height: 1,
          color: ink ? c.bg : c.strong(tone),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Badges, chips, dots
// ---------------------------------------------------------------------------

/// A status tag: 24 h, radius 6, `12/600`, soft fill + strong text.
class DsBadge extends StatelessWidget {
  const DsBadge(
    this.label, {
    super.key,
    this.tone = DsTone.neutral,
    this.icon,
    this.outline = false,
    this.onTinted = false,
  });

  final String label;
  final DsTone tone;
  final Object? icon;

  /// Transparent with an inset `ln2` ring ("Edited").
  final bool outline;

  /// `sf` fill on a tinted row.
  final bool onTinted;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final fg = outline ? c.tx2 : c.strong(tone);
    final bg = outline ? Colors.transparent : (onTinted ? c.sf : c.soft(tone));
    return Container(
      constraints: const BoxConstraints(minHeight: 24),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(Ds.rSm),
        border: outline ? Border.all(color: c.ln2) : null,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[dsIconOf(icon!, size: 14, color: fg), const SizedBox(width: 4)],
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: fg),
            ),
          ),
        ],
      ),
    );
  }
}

/// A count badge: 20 h, `critFill` with white 11/600 text.
class DsCountBadge extends StatelessWidget {
  const DsCountBadge(this.count, {super.key});

  final int count;

  @override
  Widget build(BuildContext context) => Container(
        constraints: const BoxConstraints(minWidth: 22, minHeight: 20),
        padding: const EdgeInsets.symmetric(horizontal: 6),
        alignment: Alignment.center,
        decoration: BoxDecoration(color: context.c.critFill, borderRadius: BorderRadius.circular(10)),
        child: Text(
          '$count',
          style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w600, height: 1),
        ),
      );
}

/// An 8 px status dot.
class DsDot extends StatelessWidget {
  const DsDot({super.key, this.color, this.size = 8});

  final Color? color;
  final double size;

  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: color ?? context.c.critFill, shape: BoxShape.circle),
      );
}

/// A filter / choice chip: 36 h pill, `ln2` border; selected is ink-filled
/// with a leading check.
class DsChip extends StatelessWidget {
  const DsChip({
    super.key,
    required this.label,
    this.selected = false,
    this.onTap,
    this.count,
    this.icon,
    this.dropdown = false,
    this.height = 36,
    this.showCheck = true,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;

  /// Shown after the label in `600 warn`.
  final int? count;
  final Object? icon;
  final bool dropdown;
  final double height;
  final bool showCheck;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final fg = selected ? c.bg : c.tx;
    final shape = StadiumBorder(side: BorderSide(color: selected ? c.tx : c.ln2));
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected ? c.tx : c.sf,
        shape: shape,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Container(
            height: height,
            padding: EdgeInsets.only(left: height >= 36 ? 14 : 12, right: dropdown ? 10 : (height >= 36 ? 14 : 12)),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (selected && showCheck) ...[DsIcon(DsIcons.check, size: 14, color: fg), const SizedBox(width: 6)],
                if (icon != null && !(selected && showCheck)) ...[
                  dsIconOf(icon!, size: 16, color: selected ? fg : c.tx2),
                  const SizedBox(width: 6),
                ],
                Flexible(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w500, color: fg),
                  ),
                ),
                if (count != null) ...[
                  const SizedBox(width: 6),
                  Text(
                    '$count',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: selected ? fg : c.warn,
                      fontFeatures: Ds.tabular,
                    ),
                  ),
                ],
                if (dropdown) ...[const SizedBox(width: 4), DsIcon(DsIcons.chevronDown, size: 16, color: fg)],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Callouts, alerts, empty states
// ---------------------------------------------------------------------------

/// A banner inside a card: radius 12, 20 px icon. Tones: warn, ac (info),
/// neutral (stale data), crit (inline error), good.
class DsCallout extends StatelessWidget {
  const DsCallout({
    super.key,
    required this.title,
    this.detail,
    this.tone = DsTone.ac,
    this.icon,
    this.action,
    this.padding,
  });

  final String title;
  final String? detail;
  final DsTone tone;
  final Object? icon;

  /// A trailing link or button.
  final Widget? action;
  final EdgeInsetsGeometry? padding;

  static DsGlyph defaultIcon(DsTone tone) => switch (tone) {
        DsTone.warn || DsTone.crit => DsIcons.alertTriangle,
        DsTone.good => DsIcons.check,
        DsTone.neutral => DsIcons.info,
        DsTone.ac => DsIcons.info,
      };

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final strong = c.strong(tone);
    // Info callouts keep their title in ink; the others in their own colour.
    final titleColor = tone == DsTone.ac ? c.tx : (tone == DsTone.neutral ? c.tx2 : strong);
    return Container(
      padding: padding ?? const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(color: c.soft(tone), borderRadius: BorderRadius.circular(Ds.rLg)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: dsIconOf(icon ?? defaultIcon(tone), size: 20, color: strong),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: titleColor),
                ),
                if (detail != null) ...[
                  const SizedBox(height: 2),
                  Text(detail!, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx2)),
                ],
                if (action != null) ...[const SizedBox(height: 4), action!],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A blocking error: `critSoft`, radius 14, a 36 icon tile on `sf`, title
/// in `crit`, body in `tx2`, an optional action.
class DsAlertCard extends StatelessWidget {
  const DsAlertCard({super.key, required this.title, this.body, this.icon, this.action});

  final String title;
  final String? body;
  final Object? icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Semantics(
      liveRegion: true,
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: c.critSoft, borderRadius: BorderRadius.circular(Ds.rXl)),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            DsIconTile(icon ?? DsIcons.alertTriangle, tone: DsTone.crit, onTinted: true, size: 36),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.crit),
                  ),
                  if (body != null) ...[
                    const SizedBox(height: 4),
                    Text(body!, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2)),
                  ],
                  if (action != null) ...[const SizedBox(height: 12), action!],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Empty inside a card: a dashed box with a 40 icon tile, one sentence and
/// one ghost action.
class DsEmpty extends StatelessWidget {
  const DsEmpty({
    super.key,
    required this.message,
    this.icon = DsIcons.info,
    this.actionLabel,
    this.onAction,
    this.dashed = true,
  });

  final String message;
  final Object icon;
  final String? actionLabel;
  final VoidCallback? onAction;
  final bool dashed;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final body = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          DsIconTile(icon, tone: DsTone.neutral, color: c.tx3),
          const SizedBox(height: 8),
          Text(
            message,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
          ),
          if (actionLabel != null && onAction != null) ...[
            const SizedBox(height: 4),
            TextButton(
              onPressed: onAction,
              style: TextButton.styleFrom(textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 13, fontWeight: FontWeight.w600)),
              child: Text(actionLabel!),
            ),
          ],
        ],
      ),
    );
    final box = SizedBox(width: double.infinity, child: body);
    if (!dashed) return box;
    return DsDashedBorder(radius: Ds.rLg, child: box);
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/// A "More" link row: 48 min height, icon 20 `tx2`, label 14 `tx`, value
/// 13 `tx3`, chevron 18.
class DsLinkRow extends StatelessWidget {
  const DsLinkRow({
    super.key,
    required this.label,
    this.icon,
    this.value,
    this.onTap,
    this.divider = true,
    this.trailing,
    this.labelColor,
  });

  final String label;
  final Object? icon;
  final String? value;
  final VoidCallback? onTap;
  final bool divider;
  final Widget? trailing;
  final Color? labelColor;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 48),
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(border: divider ? Border(bottom: BorderSide(color: c.ln)) : null),
        child: Row(
          children: [
            if (icon != null) ...[dsIconOf(icon!, size: 20, color: c.tx2), const SizedBox(width: 12)],
            Expanded(
              child: Text(label, style: TextStyle(fontSize: 14, height: 20 / 14, color: labelColor ?? c.tx)),
            ),
            if (value != null) ...[
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  value!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.end,
                  style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                ),
              ),
            ],
            if (trailing != null) ...[const SizedBox(width: 8), trailing!],
            if (onTap != null && trailing == null) ...[
              const SizedBox(width: 6),
              DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3),
            ],
          ],
        ),
      ),
    );
  }
}

/// A sticky-style day header strip: `sf2`, 12/600 `tx2`, net on the right.
class DsDayHeader extends StatelessWidget {
  const DsDayHeader({super.key, required this.label, this.trailing, this.padding});

  final String label;
  final Widget? trailing;
  final EdgeInsetsGeometry? padding;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: padding ?? const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      decoration: BoxDecoration(color: c.sf2, border: Border(bottom: BorderSide(color: c.ln))),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.tx2),
            ),
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/// A stat tile: `sf`, radius 14, padding 16; label, a 22/28 value, footnote.
class DsStatTile extends StatelessWidget {
  const DsStatTile({
    super.key,
    required this.label,
    required this.value,
    this.foot,
    this.valueColor,
    this.icon,
    this.badge,
    this.onTap,
    this.footColor,
  });

  final String label;
  final String value;
  final String? foot;
  final Color? valueColor;
  final Object? icon;
  final Widget? badge;
  final VoidCallback? onTap;
  final Color? footColor;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return DsCard(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              if (icon != null) ...[dsIconOf(icon!, size: 16, color: c.tx2), const SizedBox(width: 8)],
              Expanded(child: DsLabel(label)),
            ],
          ),
          const SizedBox(height: 6),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              style: TextStyle(
                fontSize: 22,
                height: 28 / 22,
                fontWeight: FontWeight.w600,
                color: valueColor ?? c.tx,
                fontFeatures: Ds.tabular,
              ),
            ),
          ),
          if (foot != null) ...[
            const SizedBox(height: 6),
            Text(foot!, style: TextStyle(fontSize: 12, height: 16 / 12, color: footColor ?? c.tx3)),
          ],
          if (badge != null) ...[const SizedBox(height: 8), badge!],
        ],
      ),
    );
  }
}

/// Label over value: `12/600 tx2` then `17/600` tabular.
class DsInlineStat extends StatelessWidget {
  const DsInlineStat({
    super.key,
    required this.label,
    required this.value,
    this.unit,
    this.valueColor,
    this.compact = false,
    this.crossAxisAlignment = CrossAxisAlignment.start,
  });

  final String label;
  final String value;
  final String? unit;
  final Color? valueColor;

  /// 15/600 instead of 17/600, for tighter rows.
  final bool compact;
  final CrossAxisAlignment crossAxisAlignment;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: crossAxisAlignment,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label, style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.tx2)),
        const SizedBox(height: 2),
        Text.rich(
          TextSpan(
            text: value,
            style: TextStyle(
              fontSize: compact ? 15 : 17,
              height: (compact ? 20 : 24) / (compact ? 15 : 17),
              fontWeight: FontWeight.w600,
              color: valueColor ?? c.tx,
              fontFeatures: Ds.tabular,
            ),
            children: [
              if (unit != null)
                TextSpan(
                  text: unit,
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: c.tx3),
                ),
            ],
          ),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Pace bar, meters, hatching
// ---------------------------------------------------------------------------

/// Paints the "promised / committed" hatching: 2 px stripes every 6 px at
/// 135°.
void paintHatch(Canvas canvas, Rect rect, Color color, {Color? background}) {
  if (rect.width <= 0 || rect.height <= 0) return;
  canvas.save();
  canvas.clipRect(rect);
  if (background != null) canvas.drawRect(rect, Paint()..color = background);
  final paint = Paint()
    ..color = color
    ..strokeWidth = 2
    ..isAntiAlias = true;
  // 6 px between stripes measured across them is 6·√2 along the x axis.
  const step = 6 * math.sqrt2;
  final h = rect.height;
  for (var x = rect.left - h; x < rect.right + h; x += step) {
    canvas.drawLine(Offset(x, rect.bottom), Offset(x + h, rect.top), paint);
  }
  canvas.restore();
}

/// The signature pace bar (§2.3, §7.8): ink for spent, hatching for
/// promised, the sunk track for free, and a thin cobalt "today" tick.
///
/// Values are fractions of the whole bar, 0..1.
class DsPaceBar extends StatelessWidget {
  const DsPaceBar({
    super.key,
    required this.spent,
    this.promised = 0,
    this.today,
    this.todayLabel,
    this.height = 14,
    this.spentColor,
    this.semanticsLabel,
  });

  final double spent;
  final double promised;

  /// Where "today" should be, 0..1; null hides the tick.
  final double? today;
  final String? todayLabel;
  final double height;

  /// Overrides the ink, e.g. `critFill` once the budget is gone.
  final Color? spentColor;
  final String? semanticsLabel;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final hasLabel = today != null && todayLabel != null;
    final t = today?.clamp(0.0, 1.0);
    final bar = SizedBox(
      height: height + 10,
      child: CustomPaint(
        size: Size.infinite,
        painter: _PacePainter(
          spent: spent.clamp(0.0, 1.0),
          promised: promised.clamp(0.0, 1.0),
          today: t,
          height: height,
          track: c.sunk,
          ink: spentColor ?? c.tx,
          hatch: c.hatch,
          tick: c.ac,
        ),
      ),
    );
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (hasLabel)
          Align(
            // Keeps the label over the tick but inside the bar's width.
            alignment: Alignment(-1 + 2 * t!, 0),
            child: Text(
              todayLabel!,
              maxLines: 1,
              style: TextStyle(
                fontSize: 11,
                height: 14 / 11,
                fontWeight: FontWeight.w600,
                color: c.ac,
                fontFeatures: Ds.tabular,
              ),
            ),
          ),
        bar,
      ],
    );
    return Semantics(label: semanticsLabel, child: ExcludeSemantics(excluding: semanticsLabel != null, child: body));
  }
}

class _PacePainter extends CustomPainter {
  _PacePainter({
    required this.spent,
    required this.promised,
    required this.today,
    required this.height,
    required this.track,
    required this.ink,
    required this.hatch,
    required this.tick,
  });

  final double spent, promised, height;
  final double? today;
  final Color track, ink, hatch, tick;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    const top = 5.0;
    final barRect = Rect.fromLTWH(0, top, w, height);
    final rr = RRect.fromRectAndRadius(barRect, Radius.circular(height / 2));
    canvas.drawRRect(rr, Paint()..color = track);
    canvas.save();
    canvas.clipRRect(rr);
    final spentW = w * spent;
    if (spentW > 0) canvas.drawRect(Rect.fromLTWH(0, top, spentW, height), Paint()..color = ink);
    final promisedW = math.min(w - spentW, w * promised);
    if (promisedW > 0) paintHatch(canvas, Rect.fromLTWH(spentW, top, promisedW, height), hatch);
    canvas.restore();
    if (today != null) {
      final x = (w * today!).clamp(1.0, w - 1.0);
      canvas.drawRRect(
        RRect.fromRectAndRadius(Rect.fromLTWH(x - 1, 0, 2, height + 10), const Radius.circular(1)),
        Paint()..color = tick,
      );
    }
  }

  @override
  bool shouldRepaint(_PacePainter old) =>
      old.spent != spent ||
      old.promised != promised ||
      old.today != today ||
      old.ink != ink ||
      old.track != track ||
      old.hatch != hatch ||
      old.tick != tick ||
      old.height != height;
}

/// One entry under a pace bar: a 12×12 swatch, a label and a figure.
enum DsSwatch { spent, promised, free, today, custom }

class DsLegendItem extends StatelessWidget {
  const DsLegendItem({super.key, required this.swatch, required this.label, this.value, this.color, this.note});

  final DsSwatch swatch;
  final String label;
  final String? value;

  /// For [DsSwatch.custom]: the swatch fill.
  final Color? color;

  /// A trailing `tx3` note, e.g. "rent, EMIs, SIPs".
  final String? note;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final Widget mark = switch (swatch) {
      DsSwatch.today => Container(
          width: 2,
          height: 14,
          decoration: BoxDecoration(color: c.ac, borderRadius: BorderRadius.circular(1)),
        ),
      DsSwatch.promised => Container(
          width: 12,
          height: 12,
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(3), border: Border.all(color: c.ln2)),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(2),
            child: CustomPaint(painter: _HatchSwatchPainter(c.hatch)),
          ),
        ),
      DsSwatch.free => Container(
          width: 12,
          height: 12,
          decoration: BoxDecoration(
            color: c.sunk,
            borderRadius: BorderRadius.circular(3),
            border: Border.all(color: c.ln2),
          ),
        ),
      DsSwatch.spent => Container(
          width: 12,
          height: 12,
          decoration: BoxDecoration(color: c.tx, borderRadius: BorderRadius.circular(3)),
        ),
      DsSwatch.custom => Container(
          width: 12,
          height: 12,
          decoration: BoxDecoration(color: color ?? c.tx, borderRadius: BorderRadius.circular(3)),
        ),
    };
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        mark,
        const SizedBox(width: 8),
        Flexible(
          child: Text.rich(
            TextSpan(
              style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2, fontFeatures: Ds.tabular),
              children: [
                TextSpan(text: label),
                if (value != null)
                  TextSpan(text: '  $value', style: TextStyle(fontWeight: FontWeight.w600, color: c.tx)),
                if (note != null) TextSpan(text: '  $note', style: TextStyle(color: c.tx3)),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _HatchSwatchPainter extends CustomPainter {
  _HatchSwatchPainter(this.color);
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1.5;
    for (var x = -size.height; x < size.width + size.height; x += 4) {
      canvas.drawLine(Offset(x, size.height), Offset(x + size.height, 0), paint);
    }
  }

  @override
  bool shouldRepaint(_HatchSwatchPainter old) => old.color != color;
}

/// A limit bar or thin meter: a `sunk` track (radius h/2) with a fill, an
/// optional hatched "promised" part and an optional today tick.
class DsMeter extends StatelessWidget {
  const DsMeter({
    super.key,
    required this.value,
    this.promised = 0,
    this.color,
    this.height = 6,
    this.today,
    this.trackColor,
    this.allHatched = false,
  });

  /// 0..1 filled.
  final double value;

  /// 0..1 hatched after the fill.
  final double promised;
  final Color? color;
  final double height;
  final double? today;
  final Color? trackColor;

  /// A fully promised limit: the whole bar hatched over `sunk`.
  final bool allHatched;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final tick = today != null;
    return SizedBox(
      height: tick ? height + 10 : height,
      child: CustomPaint(
        size: Size.infinite,
        painter: _MeterPainter(
          value: value.isNaN ? 0 : value.clamp(0.0, 1.0),
          promised: promised.isNaN ? 0 : promised.clamp(0.0, 1.0),
          height: height,
          top: tick ? 5 : 0,
          fill: color ?? c.tx,
          track: trackColor ?? c.sunk,
          hatch: c.hatch,
          today: today?.clamp(0.0, 1.0),
          tick: c.ac,
          allHatched: allHatched,
        ),
      ),
    );
  }
}

class _MeterPainter extends CustomPainter {
  _MeterPainter({
    required this.value,
    required this.promised,
    required this.height,
    required this.top,
    required this.fill,
    required this.track,
    required this.hatch,
    required this.today,
    required this.tick,
    required this.allHatched,
  });

  final double value, promised, height, top;
  final Color fill, track, hatch, tick;
  final double? today;
  final bool allHatched;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final rect = Rect.fromLTWH(0, top, w, height);
    final rr = RRect.fromRectAndRadius(rect, Radius.circular(height / 2));
    canvas.drawRRect(rr, Paint()..color = track);
    canvas.save();
    canvas.clipRRect(rr);
    if (allHatched) {
      paintHatch(canvas, rect, hatch);
    } else {
      final fw = w * value;
      if (fw > 0) {
        canvas.drawRRect(
          RRect.fromRectAndRadius(Rect.fromLTWH(0, top, fw, height), Radius.circular(height / 2)),
          Paint()..color = fill,
        );
      }
      final pw = math.min(w - fw, w * promised);
      if (pw > 0) paintHatch(canvas, Rect.fromLTWH(fw, top, pw, height), hatch);
    }
    canvas.restore();
    if (today != null) {
      final x = (w * today!).clamp(1.0, w - 1.0);
      canvas.drawRRect(
        RRect.fromRectAndRadius(Rect.fromLTWH(x - 1, top - 5, 2, height + 10), const Radius.circular(1)),
        Paint()..color = tick,
      );
    }
  }

  @override
  bool shouldRepaint(_MeterPainter old) =>
      old.value != value ||
      old.promised != promised ||
      old.fill != fill ||
      old.track != track ||
      old.today != today ||
      old.allHatched != allHatched ||
      old.hatch != hatch;
}

/// A step indicator: equal 4 h segments, done in `ac`, to-do in `sunk`.
class DsSteps extends StatelessWidget {
  const DsSteps({super.key, required this.count, required this.done});

  final int count;
  final int done;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Row(
      children: [
        for (var i = 0; i < count; i++) ...[
          if (i > 0) const SizedBox(width: 4),
          Expanded(
            child: Container(
              height: 4,
              decoration: BoxDecoration(color: i < done ? c.ac : c.sunk, borderRadius: BorderRadius.circular(2)),
            ),
          ),
        ],
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

/// The only tab style in the system: a `sunk` track, radius 12, padding 4,
/// equal columns, and an `sf` thumb with a small shadow that slides.
class DsSegmented<T> extends StatelessWidget {
  const DsSegmented({
    super.key,
    required this.segments,
    required this.selected,
    required this.onChanged,
    this.height = 36,
  });

  /// Value and label for each segment, in order.
  final List<(T, String)> segments;
  final T selected;
  final ValueChanged<T>? onChanged;

  /// Segment height: 32 in card headers, 36 in forms, 40 in settings.
  final double height;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final index = math.max(0, segments.indexWhere((s) => s.$1 == selected));
    final n = segments.length;
    final reduce = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(color: c.sunk, borderRadius: BorderRadius.circular(Ds.rLg)),
      child: SizedBox(
        height: height,
        child: LayoutBuilder(
          builder: (context, constraints) {
            final segW = (constraints.maxWidth - 4 * (n - 1)) / n;
            return Stack(
              children: [
                AnimatedPositioned(
                  duration: reduce ? Duration.zero : Ds.dur,
                  curve: Ds.ease,
                  left: index * (segW + 4),
                  top: 0,
                  bottom: 0,
                  width: segW,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: c.sf,
                      borderRadius: BorderRadius.circular(9),
                      boxShadow: c.shadow,
                    ),
                  ),
                ),
                Row(
                  children: [
                    for (var i = 0; i < n; i++) ...[
                      if (i > 0) const SizedBox(width: 4),
                      Expanded(
                        child: Semantics(
                          selected: i == index,
                          button: true,
                          child: InkWell(
                            borderRadius: BorderRadius.circular(9),
                            onTap: onChanged == null ? null : () => onChanged!(segments[i].$1),
                            child: Center(
                              child: Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 4),
                                child: Text(
                                  segments[i].$2,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    fontSize: height <= 32 ? 13 : 14,
                                    fontWeight: i == index ? FontWeight.w600 : FontWeight.w500,
                                    color: i == index ? c.tx : c.tx2,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/// The eye button every password, PIN and key field carries. [noun] names
/// the thing: "password", "key", "PIN".
class DsEyeButton extends StatelessWidget {
  const DsEyeButton({super.key, required this.obscured, required this.onPressed, this.noun = 'password', this.color});

  final bool obscured;
  final VoidCallback onPressed;
  final String noun;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final label = obscured ? 'Show $noun' : 'Hide $noun';
    return Semantics(
      button: true,
      toggled: !obscured,
      label: label,
      excludeSemantics: true,
      child: IconButton(
        tooltip: label,
        onPressed: onPressed,
        icon: DsIcon(obscured ? DsIcons.eye : DsIcons.eyeOff, size: 20, color: color ?? context.c.tx2),
      ),
    );
  }
}

/// A password / secret field with the eye toggle. When revealed the value
/// switches to Plex Mono so ambiguous characters are clear.
class DsPasswordField extends StatefulWidget {
  const DsPasswordField({
    super.key,
    this.controller,
    this.noun = 'password',
    this.hintText,
    this.labelText,
    this.helperText,
    this.errorText,
    this.validator,
    this.onChanged,
    this.onSubmitted,
    this.keyboardType,
    this.textInputAction,
    this.autofillHints,
    this.autofocus = false,
    this.enabled = true,
    this.pin = false,
    this.maxLength,
    this.inputFormatters,
    this.focusNode,
    this.decoration,
  });

  final TextEditingController? controller;
  final String noun;
  final String? hintText;
  final String? labelText;
  final String? helperText;
  final String? errorText;
  final FormFieldValidator<String>? validator;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final Iterable<String>? autofillHints;
  final bool autofocus;
  final bool enabled;

  /// A PIN: numeric, 22 px with wide tracking.
  final bool pin;
  final int? maxLength;
  final List<TextInputFormatter>? inputFormatters;
  final FocusNode? focusNode;

  /// Merged over the defaults; its suffixIcon is always the eye.
  final InputDecoration? decoration;

  @override
  State<DsPasswordField> createState() => _DsPasswordFieldState();
}

class _DsPasswordFieldState extends State<DsPasswordField> {
  bool _obscured = true;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final base = widget.decoration ?? const InputDecoration();
    final style = widget.pin
        ? TextStyle(fontSize: 22, letterSpacing: 22 * 0.4, color: c.tx, fontFeatures: Ds.tabular)
        : (_obscured ? TextStyle(fontSize: 15, color: c.tx) : kMono.copyWith(fontSize: 15, color: c.tx));
    return TextFormField(
      controller: widget.controller,
      focusNode: widget.focusNode,
      obscureText: _obscured,
      enableSuggestions: false,
      autocorrect: false,
      autofocus: widget.autofocus,
      enabled: widget.enabled,
      maxLength: widget.maxLength,
      inputFormatters: widget.inputFormatters,
      keyboardType: widget.pin ? TextInputType.number : widget.keyboardType,
      textInputAction: widget.textInputAction,
      autofillHints: widget.autofillHints,
      validator: widget.validator,
      onChanged: widget.onChanged,
      onFieldSubmitted: widget.onSubmitted,
      style: style,
      decoration: base.copyWith(
        hintText: widget.hintText ?? base.hintText,
        labelText: widget.labelText ?? base.labelText,
        helperText: widget.helperText ?? base.helperText,
        errorText: widget.errorText ?? base.errorText,
        suffixIcon: Padding(
          padding: const EdgeInsets.only(right: 2),
          child: DsEyeButton(
            obscured: _obscured,
            noun: widget.noun,
            onPressed: () => setState(() => _obscured = !_obscured),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Sheets, loading, logo
// ---------------------------------------------------------------------------

/// A bottom sheet's drag handle: 36×4, radius 2, `ln2`, 8 px from the top.
class DsDragHandle extends StatelessWidget {
  const DsDragHandle({super.key});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 8, bottom: 8),
        child: Center(
          child: Container(
            width: 36,
            height: 4,
            decoration: BoxDecoration(color: context.c.ln2, borderRadius: BorderRadius.circular(2)),
          ),
        ),
      );
}

/// A sheet or dialog title row: optional 40 icon tile, `19/24 600` title,
/// optional sub-line and a close button.
class DsSheetHeader extends StatelessWidget {
  const DsSheetHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.icon,
    this.tone = DsTone.ac,
    this.onClose,
    this.trailing,
  });

  final String title;
  final String? subtitle;
  final Object? icon;
  final DsTone tone;
  final VoidCallback? onClose;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        if (icon != null) ...[DsIconTile(icon!, tone: tone), const SizedBox(width: 12)],
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(title, style: TextStyle(fontSize: 19, height: 24 / 19, fontWeight: FontWeight.w600, color: c.tx)),
              if (subtitle != null) ...[
                const SizedBox(height: 2),
                Text(subtitle!, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3)),
              ],
            ],
          ),
        ),
        if (trailing != null) trailing!,
        if (onClose != null)
          IconButton(
            tooltip: 'Close',
            onPressed: onClose,
            icon: DsIcon(DsIcons.x, size: 20, color: c.tx2),
          ),
      ],
    );
  }
}

/// A `sunk` skeleton block.
class DsSkeleton extends StatelessWidget {
  const DsSkeleton({super.key, this.width, this.height = 12, this.radius = 6});

  final double? width;
  final double height;
  final double radius;

  @override
  Widget build(BuildContext context) => Container(
        width: width,
        height: height,
        decoration: BoxDecoration(color: context.c.sunk, borderRadius: BorderRadius.circular(radius)),
      );
}

/// A few skeleton list rows: a 36 square, two lines and an amount stub.
class DsSkeletonRows extends StatelessWidget {
  const DsSkeletonRows({super.key, this.count = 4, this.caption});

  final int count;
  final String? caption;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: caption ?? 'Loading',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (caption != null) ...[DsLabel(caption!), const SizedBox(height: 12)],
          for (var i = 0; i < count; i++)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: LayoutBuilder(
                builder: (context, cons) {
                  final w = cons.maxWidth;
                  return Row(
                    children: [
                      const DsSkeleton(width: 36, height: 36, radius: 10),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            DsSkeleton(width: w * (i.isEven ? 0.4 : 0.32), height: 12),
                            const SizedBox(height: 8),
                            DsSkeleton(width: w * (i.isEven ? 0.24 : 0.2), height: 10, radius: 5),
                          ],
                        ),
                      ),
                      const DsSkeleton(width: 72, height: 12),
                    ],
                  );
                },
              ),
            ),
        ],
      ),
    );
  }
}

/// A centred spinner in the system's colours: a `sunk` ring with an `ac` arc.
class DsSpinner extends StatelessWidget {
  const DsSpinner({super.key, this.size = 28});

  final double size;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: size,
        height: size,
        child: CircularProgressIndicator(
          strokeWidth: size >= 24 ? 3 : 2,
          color: context.c.ac,
          backgroundColor: context.c.sunk,
          strokeCap: StrokeCap.round,
        ),
      );
}

/// The SpendLog mark: a rounded `ac` square with two ledger lines and a
/// cursor in `acTx` (§7.16). Drawn, so it follows the theme.
class DsLogoMark extends StatelessWidget {
  const DsLogoMark({super.key, this.size = 28});

  final double size;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Semantics(
      label: 'SpendLog',
      image: true,
      child: CustomPaint(size: Size.square(size), painter: _LogoPainter(c.ac, c.acTx)),
    );
  }
}

class _LogoPainter extends CustomPainter {
  _LogoPainter(this.fill, this.ink);
  final Color fill, ink;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.width / 28;
    canvas.drawRRect(
      RRect.fromRectAndRadius(Offset.zero & size, Radius.circular(8 * s)),
      Paint()..color = fill,
    );
    final p = Paint()
      ..color = ink
      ..strokeWidth = 2.2 * s
      ..strokeCap = StrokeCap.round;
    canvas.drawLine(Offset(7 * s, 10.5 * s), Offset(21 * s, 10.5 * s), p);
    canvas.drawLine(Offset(7 * s, 17.5 * s), Offset(15 * s, 17.5 * s), p);
    canvas.drawLine(Offset(18.5 * s, 14 * s), Offset(18.5 * s, 21 * s), p);
  }

  @override
  bool shouldRepaint(_LogoPainter old) => old.fill != fill || old.ink != ink;
}

/// The mark plus the "SpendLog" wordmark (18/700 −.01em).
class DsLogo extends StatelessWidget {
  const DsLogo({super.key, this.size = 28, this.showWordmark = true});

  final double size;
  final bool showWordmark;

  @override
  Widget build(BuildContext context) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          DsLogoMark(size: size),
          if (showWordmark) ...[
            const SizedBox(width: 10),
            Text(
              'SpendLog',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, letterSpacing: -0.18, color: context.c.tx),
            ),
          ],
        ],
      );
}

/// An inverse toast with an optional underlined action (§7.12).
void showDsToast(
  BuildContext context,
  String message, {
  Object? icon,
  String? actionLabel,
  VoidCallback? onAction,
}) {
  final c = context.c;
  final messenger = ScaffoldMessenger.of(context);
  messenger.hideCurrentSnackBar();
  messenger.showSnackBar(
    SnackBar(
      duration: Duration(seconds: actionLabel != null ? 10 : 6),
      content: Row(
        children: [
          if (icon != null) ...[dsIconOf(icon, size: 20, color: c.bg), const SizedBox(width: 12)],
          Expanded(child: Text(message, style: TextStyle(fontSize: 14, height: 20 / 14, color: c.bg))),
        ],
      ),
      action: actionLabel == null
          ? null
          : SnackBarAction(label: actionLabel, textColor: c.bg, onPressed: onAction ?? () {}),
    ),
  );
}
