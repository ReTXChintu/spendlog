import 'package:flutter/material.dart';

/// Design tokens from the approved mockup (design/spendlog-mobile.html).
/// The web app uses the same values as CSS custom properties, so the two
/// platforms stay in step.
class T {
  const T._();

  static const ink = Color(0xFF0F172A);
  static const ink70 = Color(0xFF334155);
  static const brand = Color(0xFF3D6BF5);
  static const brandDark = Color(0xFF2F53C9);
  static const brand50 = Color(0xFFEEF2FF);
  static const brand100 = Color(0xFFE0E7FF);
  static const debit = Color(0xFFDC2626);
  static const debit50 = Color(0xFFFEF2F2);
  static const credit = Color(0xFF16A34A);
  static const credit50 = Color(0xFFF0FDF4);
  static const muted = Color(0xFF64748B);
  static const mutedLight = Color(0xFF94A3B8);

  /// The warm off-white the whole app sits on — not pure white.
  static const paper = Color(0xFFF5F5F2);
  static const surface = Color(0xFFFFFFFF);
  static const line = Color(0xFFE4E4DF);
  static const lineStrong = Color(0xFFD6D6D0);
  static const transfer = Color(0xFF94A3B8);
  static const warn = Color(0xFFB45309);
  static const warnBg = Color(0xFFFFFBEB);

  static const rSm = 8.0;
  static const rMd = 14.0;
  static const rLg = 20.0;
}

/// Amounts and anything else that lines up in a column are set in a
/// monospaced face with tabular figures, as in the design.
const List<String> kMonoFallback = ['Roboto Mono', 'SF Mono', 'Consolas', 'monospace'];

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
Color parseHexColor(String? hex, {Color fallback = T.muted}) {
  if (hex == null) return fallback;
  final cleaned = hex.replaceFirst('#', '');
  if (cleaned.length != 6) return fallback;
  final value = int.tryParse(cleaned, radix: 16);
  return value == null ? fallback : Color(0xFF000000 | value);
}

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: T.brand, surface: T.surface);

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: T.paper,
    fontFamily: 'Roboto',
    appBarTheme: const AppBarTheme(
      backgroundColor: T.surface,
      surfaceTintColor: Colors.transparent,
      foregroundColor: T.ink,
      elevation: 0,
      centerTitle: false,
    ),
    dividerTheme: const DividerThemeData(color: T.line, thickness: 1, space: 1),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: T.surface,
      surfaceTintColor: Colors.transparent,
      indicatorColor: T.brand50,
      elevation: 0,
      height: 62,
      labelTextStyle: WidgetStateProperty.resolveWith(
        (states) => TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
          color: states.contains(WidgetState.selected) ? T.brandDark : T.muted,
        ),
      ),
      iconTheme: WidgetStateProperty.resolveWith(
        (states) => IconThemeData(
          size: 22,
          color: states.contains(WidgetState.selected) ? T.brand : T.muted,
        ),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: T.brand,
        foregroundColor: Colors.white,
        textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(T.rSm)),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: T.ink,
        side: const BorderSide(color: T.lineStrong),
        textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(T.rSm)),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      ),
    ),
  );
}
