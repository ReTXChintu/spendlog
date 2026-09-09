import 'package:flutter/material.dart';

/// Design tokens from the approved mockup, mirroring the CSS custom
/// properties in apps/frontend/src/index.css so the two platforms stay in
/// step.
///
/// These are a ThemeExtension rather than plain constants because the
/// colours change with the theme: widgets read them from the context with
/// `context.c`, so light and dark are one code path.
@immutable
class SpendColors extends ThemeExtension<SpendColors> {
  final Color ink;
  final Color ink70;
  final Color brand;
  final Color brandDark;
  final Color brand50;
  final Color brand100;
  final Color debit;
  final Color debit50;
  final Color credit;
  final Color credit50;
  final Color muted;
  final Color mutedLight;
  final Color paper;
  final Color surface;
  final Color line;
  final Color lineStrong;
  final Color transfer;
  final Color warn;
  final Color warnBg;

  /// Neutral chip fill, e.g. the "not counted" transfer badge.
  final Color chipNeutral;

  /// Track behind the category bars on Analytics.
  final Color track;

  /// A panel that stays dark in both themes — the sign-in hero and the
  /// original-message block.
  final Color darkPanel;
  final Color darkPanelText;

  const SpendColors({
    required this.ink,
    required this.ink70,
    required this.brand,
    required this.brandDark,
    required this.brand50,
    required this.brand100,
    required this.debit,
    required this.debit50,
    required this.credit,
    required this.credit50,
    required this.muted,
    required this.mutedLight,
    required this.paper,
    required this.surface,
    required this.line,
    required this.lineStrong,
    required this.transfer,
    required this.warn,
    required this.warnBg,
    required this.chipNeutral,
    required this.track,
    required this.darkPanel,
    required this.darkPanelText,
  });

  static const light = SpendColors(
    ink: Color(0xFF0F172A),
    ink70: Color(0xFF334155),
    brand: Color(0xFF3D6BF5),
    brandDark: Color(0xFF2F53C9),
    brand50: Color(0xFFEEF2FF),
    brand100: Color(0xFFE0E7FF),
    debit: Color(0xFFDC2626),
    debit50: Color(0xFFFEF2F2),
    credit: Color(0xFF16A34A),
    credit50: Color(0xFFF0FDF4),
    muted: Color(0xFF64748B),
    mutedLight: Color(0xFF94A3B8),
    paper: Color(0xFFF5F5F2),
    surface: Color(0xFFFFFFFF),
    line: Color(0xFFE4E4DF),
    lineStrong: Color(0xFFD6D6D0),
    transfer: Color(0xFF94A3B8),
    warn: Color(0xFFB45309),
    warnBg: Color(0xFFFFFBEB),
    chipNeutral: Color(0xFFF1F5F9),
    track: Color(0xFFEFEFEA),
    darkPanel: Color(0xFF0F172A),
    darkPanelText: Color(0xFFD9E2F5),
  );

  /// Same values as the web's dark palette.
  static const dark = SpendColors(
    ink: Color(0xFFE9ECF3),
    ink70: Color(0xFFB7C0D0),
    brand: Color(0xFF7B9BFF),
    brandDark: Color(0xFFA6BCFF),
    brand50: Color(0xFF1A2440),
    brand100: Color(0xFF26355C),
    debit: Color(0xFFFF8A93),
    debit50: Color(0xFF2B1519),
    credit: Color(0xFF4FD39B),
    credit50: Color(0xFF12281F),
    muted: Color(0xFF98A3B8),
    mutedLight: Color(0xFF6E7889),
    paper: Color(0xFF0E1119),
    surface: Color(0xFF161A24),
    line: Color(0xFF262B36),
    lineStrong: Color(0xFF333A47),
    transfer: Color(0xFF8B95A8),
    warn: Color(0xFFE0A94A),
    warnBg: Color(0xFF2A2113),
    chipNeutral: Color(0xFF232936),
    track: Color(0xFF232936),
    darkPanel: Color(0xFF0B0F18),
    darkPanelText: Color(0xFFC3CDE2),
  );

  @override
  SpendColors copyWith() => this;

  @override
  SpendColors lerp(ThemeExtension<SpendColors>? other, double t) {
    // Snap rather than blend: the palettes are discrete and a half-way
    // interpolation is never a state we want on screen.
    if (other is! SpendColors) return this;
    return t < 0.5 ? this : other;
  }
}

extension SpendTheme on BuildContext {
  /// The active palette. Widgets use `context.c.ink` and so on.
  SpendColors get c => Theme.of(this).extension<SpendColors>() ?? SpendColors.light;
}

/// Corner radii, which don't vary by theme.
class T {
  const T._();
  static const rSm = 8.0;
  static const rMd = 14.0;
  static const rLg = 20.0;
}

const List<String> kMonoFallback = ['Roboto Mono', 'SF Mono', 'Consolas', 'monospace'];

/// Amounts and anything else that lines up in a column.
const TextStyle kNum = TextStyle(
  fontFamily: 'monospace',
  fontFamilyFallback: kMonoFallback,
  fontFeatures: [FontFeature.tabularFigures()],
);

/// Category appearance is defined once on the server; both clients read
/// `category.icon`. The web resolves these ids against an SVG sprite, so
/// this maps the same ids onto Material icons.
IconData categoryIcon(String? id) {
  switch (id) {
    case 'ic-food':
      return Icons.restaurant_outlined;
    case 'ic-basket':
      return Icons.shopping_basket_outlined;
    case 'ic-car':
      return Icons.directions_car_outlined;
    case 'ic-bag':
      return Icons.shopping_bag_outlined;
    case 'ic-bolt':
      return Icons.bolt_outlined;
    case 'ic-play':
      return Icons.play_circle_outline;
    case 'ic-health':
      return Icons.favorite_border;
    case 'ic-home':
      return Icons.home_outlined;
    case 'ic-percent':
      return Icons.percent_outlined;
    case 'ic-trend':
      return Icons.trending_up;
    case 'ic-wallet':
      return Icons.account_balance_wallet_outlined;
    case 'ic-dots':
      return Icons.more_horiz;
    default:
      return Icons.label_outline;
  }
}

/// Parses the "#RRGGBB" the server stores for each category.
Color parseHexColor(String? hex, {Color fallback = const Color(0xFF64748B)}) {
  if (hex == null) return fallback;
  final cleaned = hex.replaceFirst('#', '');
  if (cleaned.length != 6) return fallback;
  final value = int.tryParse(cleaned, radix: 16);
  return value == null ? fallback : Color(0xFF000000 | value);
}

ThemeData buildTheme(Brightness brightness) {
  final c = brightness == Brightness.dark ? SpendColors.dark : SpendColors.light;

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: ColorScheme.fromSeed(
      seedColor: c.brand,
      brightness: brightness,
      surface: c.surface,
    ),
    extensions: <ThemeExtension<dynamic>>[c],
    scaffoldBackgroundColor: c.paper,
    fontFamily: 'Roboto',
    appBarTheme: AppBarTheme(
      backgroundColor: c.surface,
      surfaceTintColor: Colors.transparent,
      foregroundColor: c.ink,
      elevation: 0,
      centerTitle: false,
    ),
    dividerTheme: DividerThemeData(color: c.line, thickness: 1, space: 1),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.surface,
      surfaceTintColor: Colors.transparent,
      indicatorColor: c.brand50,
      elevation: 0,
      height: 62,
      labelTextStyle: WidgetStateProperty.resolveWith(
        (states) => TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
          color: states.contains(WidgetState.selected) ? c.brandDark : c.muted,
        ),
      ),
      iconTheme: WidgetStateProperty.resolveWith(
        (states) => IconThemeData(
          size: 22,
          color: states.contains(WidgetState.selected) ? c.brand : c.muted,
        ),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: c.brand,
        foregroundColor: brightness == Brightness.dark ? c.paper : Colors.white,
        textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(T.rSm)),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: c.ink,
        side: BorderSide(color: c.lineStrong),
        textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(T.rSm)),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      ),
    ),
  );
}
