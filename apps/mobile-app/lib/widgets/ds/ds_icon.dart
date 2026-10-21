import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../../theme.dart';

part 'ds_glyphs.g.dart';

/// One icon from the design's own set (docs/design-assets/icons): a list of
/// SVG path strings on a 24 grid, stroked, never filled.
@immutable
class DsGlyph {
  const DsGlyph(this.name, this.paths);

  final String name;
  final List<String> paths;

  static final Map<String, String> _svgCache = {};

  /// The glyph as SVG markup, stroked in black; [DsIcon] tints it.
  String svg(double strokeWidth) => _svgCache.putIfAbsent(
        '$name@$strokeWidth',
        () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
            'stroke="#000000" stroke-width="$strokeWidth" stroke-linecap="round" '
            'stroke-linejoin="round">${paths.map((d) => '<path d="$d"/>').join()}</svg>',
      );

  @override
  bool operator ==(Object other) => other is DsGlyph && other.name == name;

  @override
  int get hashCode => name.hashCode;

  @override
  String toString() => 'DsGlyph($name)';
}

/// Draws a [DsGlyph]. Like [Icon], it takes its size and colour from the
/// ambient [IconTheme] when not given them, so it drops into an
/// [IconButton], a [NavigationDestination] or a [ListTile] unchanged.
///
/// Stroke follows the spec: 1.75 on the 24 grid, 2 at 12–14 px, and 3 for
/// the "more" dots so they read as dots.
class DsIcon extends StatelessWidget {
  const DsIcon(this.glyph, {super.key, this.size, this.color, this.semanticLabel});

  final DsGlyph glyph;
  final double? size;
  final Color? color;

  /// Icons next to text stay out of the semantics tree; an icon that
  /// carries meaning on its own gets a label.
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final theme = IconTheme.of(context);
    final s = size ?? theme.size ?? 20;
    final base = color ?? theme.color ?? context.c.tx2;
    final opacity = theme.opacity ?? 1;
    final tint = opacity < 1 ? base.withValues(alpha: base.a * opacity) : base;
    final stroke = glyph == DsIcons.moreVertical ? 3.0 : (s <= 14 ? 2.0 : 1.75);

    final picture = SizedBox(
      width: s,
      height: s,
      child: SvgPicture.string(
        glyph.svg(stroke),
        width: s,
        height: s,
        colorFilter: ColorFilter.mode(tint, BlendMode.srcIn),
        excludeFromSemantics: true,
      ),
    );
    if (semanticLabel == null) return ExcludeSemantics(child: picture);
    return Semantics(label: semanticLabel, image: true, child: picture);
  }
}

/// Either kind of icon: a design [DsGlyph] or a Material [IconData] (kept
/// where the design set has no equivalent, e.g. category icons).
Widget dsIconOf(Object icon, {double? size, Color? color}) {
  if (icon is DsGlyph) return DsIcon(icon, size: size, color: color);
  if (icon is IconData) return Icon(icon, size: size, color: color);
  if (icon is Widget) return icon;
  throw ArgumentError.value(icon, 'icon', 'Expected a DsGlyph, IconData or Widget');
}
