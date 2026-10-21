import 'package:flutter/material.dart';

/// The SpendLog design system (docs/design-system.md, Oct 2026 redesign).
///
/// Token names mirror the CSS custom properties so design and code read the
/// same: `bg` is `--bg`, `tx2` is `--tx2`, `acSoft` is `--ac-soft`. Widgets
/// read them with `context.c`, so light and dark are one code path.
///
/// The rules the tokens encode:
/// - spending is drawn in ink (`tx`), never red; money in is `good`;
///   transfers, card bills and anything not counted are `tx3`;
/// - red (`crit`) only marks a problem: over a limit, a mismatch, a
///   connection that stopped;
/// - cards are flat: `sf` with a 1 px `ln` border and no shadow.
@immutable
class DsColors extends ThemeExtension<DsColors> {
  const DsColors({
    required this.canvas,
    required this.bg,
    required this.sf,
    required this.sf2,
    required this.sunk,
    required this.ln,
    required this.ln2,
    required this.tx,
    required this.tx2,
    required this.tx3,
    required this.ac,
    required this.acTx,
    required this.acSoft,
    required this.acLine,
    required this.good,
    required this.goodSoft,
    required this.warn,
    required this.warnFill,
    required this.warnSoft,
    required this.crit,
    required this.critFill,
    required this.critSoft,
    required this.hatch,
    required this.scrim,
    required this.chart,
  });

  /// Outermost backdrop (letterbox behind the app).
  final Color canvas;

  /// Page / scaffold background and the app bar.
  final Color bg;

  /// Surface: cards, sheets, inputs, dialogs.
  final Color sf;

  /// Raised-subtle surface: inner tiles, day-header strips, footers,
  /// read-only inputs.
  final Color sf2;

  /// Recessed: bar tracks, segmented track, skeletons, neutral tiles and badges.
  final Color sunk;

  /// Hairline: card borders and row dividers.
  final Color ln;

  /// Strong line: input, chip and secondary-button borders, dashed
  /// placeholders, disabled icons.
  final Color ln2;

  /// Primary ink: headings, figures, money out, spent segments, selected chips.
  final Color tx;

  /// Secondary text: labels, body copy.
  final Color tx2;

  /// Tertiary text: meta lines, hints, placeholders, not-counted amounts.
  final Color tx3;

  /// Cobalt accent: primary buttons, links, active nav, focus, "today".
  final Color ac;

  /// Text and icons on [ac].
  final Color acTx;

  /// Accent tint: active nav, info callouts, selected rows, accent tiles.
  final Color acSoft;

  /// Accent hairline: the inset ring on a selected list item.
  final Color acLine;

  final Color good, goodSoft;

  /// Attention text (readable amber-brown); [warnFill] is for dots and bars.
  final Color warn, warnFill, warnSoft;

  /// Critical text; [critFill] is for count badges, over-limit bars, dots.
  final Color crit, critFill, critSoft;

  /// Stripe colour of the "promised / committed" hatching.
  final Color hatch;

  /// Modal backdrop.
  final Color scrim;

  /// Chart palette in series order: c1..c5, then "other" (always last).
  final List<Color> chart;

  Color get moneyOut => tx;
  Color get moneyIn => good;
  Color get moneyNeutral => tx3;

  bool get isDark => bg.computeLuminance() < 0.2;

  static const light = DsColors(
    canvas: Color(0xFFE4E1D8),
    bg: Color(0xFFF4F2EC),
    sf: Color(0xFFFFFFFF),
    sf2: Color(0xFFFAF9F5),
    sunk: Color(0xFFECE9E1),
    ln: Color(0xFFE2DED4),
    ln2: Color(0xFFC7C2B5),
    tx: Color(0xFF18191D),
    tx2: Color(0xFF4C4D53),
    tx3: Color(0xFF67686E),
    ac: Color(0xFF2C4FCB),
    acTx: Color(0xFFFFFFFF),
    acSoft: Color(0xFFE6EBFB),
    acLine: Color(0xFFB9C6F2),
    good: Color(0xFF15724A),
    goodSoft: Color(0xFFE1F0E6),
    warn: Color(0xFF8F5200),
    warnFill: Color(0xFFE39A2E),
    warnSoft: Color(0xFFFBEED6),
    crit: Color(0xFFB3302A),
    critFill: Color(0xFFD9473E),
    critSoft: Color(0xFFFBE5E2),
    hatch: Color(0xFFC7C2B5),
    scrim: Color(0x6B18191D), // rgba(24,25,29,.42)
    chart: [
      Color(0xFF2C4FCB),
      Color(0xFFC7792B),
      Color(0xFF2F8A7A),
      Color(0xFFB04A6F),
      Color(0xFF6A7A2F),
      Color(0xFF8A8780),
    ],
  );

  static const dark = DsColors(
    canvas: Color(0xFF08090A),
    bg: Color(0xFF111214),
    sf: Color(0xFF1A1B1E),
    sf2: Color(0xFF202125),
    sunk: Color(0xFF0C0D0F),
    ln: Color(0xFF2B2D32),
    ln2: Color(0xFF3D3F46),
    tx: Color(0xFFEDEBE6),
    tx2: Color(0xFFBEBCB6),
    tx3: Color(0xFF9A9893),
    ac: Color(0xFF93A8FF),
    acTx: Color(0xFF0D1430),
    acSoft: Color(0xFF1D2544),
    acLine: Color(0xFF34407A),
    good: Color(0xFF56C892),
    goodSoft: Color(0xFF12291D),
    warn: Color(0xFFF2B661),
    warnFill: Color(0xFFE9A240),
    warnSoft: Color(0xFF2E2312),
    crit: Color(0xFFFF8C80),
    critFill: Color(0xFFE45B50),
    critSoft: Color(0xFF341A19),
    hatch: Color(0xFF4A4C53),
    scrim: Color(0x99000000), // rgba(0,0,0,.6)
    // c1 swaps to the dark accent: #2C4FCB is only 2.5:1 on the dark surface.
    chart: [
      Color(0xFF93A8FF),
      Color(0xFFC7792B),
      Color(0xFF2F8A7A),
      Color(0xFFB04A6F),
      Color(0xFF6A7A2F),
      Color(0xFF8A8780),
    ],
  );

  /// Small lift: segmented thumb, card faces. In dark it is a faint hairline.
  List<BoxShadow> get shadow => isDark
      ? const [BoxShadow(color: Color(0x05FFFFFF), spreadRadius: 1)]
      : const [
          BoxShadow(color: Color(0x0F18191D), offset: Offset(0, 1), blurRadius: 2),
          BoxShadow(color: Color(0x0D18191D), offset: Offset(0, 2), blurRadius: 8),
        ];

  /// Floating: toast, dialog, menus.
  List<BoxShadow> get shadow2 => isDark
      ? const [BoxShadow(color: Color(0x99000000), offset: Offset(0, 16), blurRadius: 40)]
      : const [BoxShadow(color: Color(0x2E18191D), offset: Offset(0, 16), blurRadius: 40)];

  @override
  DsColors copyWith({Color? ac, Color? acTx, Color? acSoft, Color? acLine, List<Color>? chart}) => DsColors(
        canvas: canvas,
        bg: bg,
        sf: sf,
        sf2: sf2,
        sunk: sunk,
        ln: ln,
        ln2: ln2,
        tx: tx,
        tx2: tx2,
        tx3: tx3,
        ac: ac ?? this.ac,
        acTx: acTx ?? this.acTx,
        acSoft: acSoft ?? this.acSoft,
        acLine: acLine ?? this.acLine,
        good: good,
        goodSoft: goodSoft,
        warn: warn,
        warnFill: warnFill,
        warnSoft: warnSoft,
        crit: crit,
        critFill: critFill,
        critSoft: critSoft,
        hatch: hatch,
        scrim: scrim,
        chart: chart ?? this.chart,
      );

  @override
  DsColors lerp(ThemeExtension<DsColors>? other, double t) {
    if (other is! DsColors) return this;
    Color l(Color a, Color b) => Color.lerp(a, b, t)!;
    return DsColors(
      canvas: l(canvas, other.canvas),
      bg: l(bg, other.bg),
      sf: l(sf, other.sf),
      sf2: l(sf2, other.sf2),
      sunk: l(sunk, other.sunk),
      ln: l(ln, other.ln),
      ln2: l(ln2, other.ln2),
      tx: l(tx, other.tx),
      tx2: l(tx2, other.tx2),
      tx3: l(tx3, other.tx3),
      ac: l(ac, other.ac),
      acTx: l(acTx, other.acTx),
      acSoft: l(acSoft, other.acSoft),
      acLine: l(acLine, other.acLine),
      good: l(good, other.good),
      goodSoft: l(goodSoft, other.goodSoft),
      warn: l(warn, other.warn),
      warnFill: l(warnFill, other.warnFill),
      warnSoft: l(warnSoft, other.warnSoft),
      crit: l(crit, other.crit),
      critFill: l(critFill, other.critFill),
      critSoft: l(critSoft, other.critSoft),
      hatch: l(hatch, other.hatch),
      scrim: l(scrim, other.scrim),
      chart: [for (var i = 0; i < chart.length; i++) l(chart[i], other.chart[i])],
    );
  }
}

extension SpendTheme on BuildContext {
  /// The active palette. Widgets use `context.c.tx` and so on.
  DsColors get c => Theme.of(this).extension<DsColors>() ?? DsColors.light;
}

/// Spacing, radii and durations, which don't vary by theme.
abstract final class Ds {
  static const s2 = 2.0, s4 = 4.0, s6 = 6.0, s8 = 8.0, s10 = 10.0, s12 = 12.0;
  static const s14 = 14.0, s16 = 16.0, s20 = 20.0, s24 = 24.0, s32 = 32.0;

  /// 6 px meters (3), badges (6), inputs and icon tiles (10), buttons and
  /// callouts (12), cards (14), card faces (16), dialogs and sheets (20).
  static const rXs = 3.0, rSm = 6.0, rMd = 10.0, rLg = 12.0, rXl = 14.0, r2xl = 16.0, r3xl = 20.0;

  /// Phones get 16 px side padding; content always spans the width.
  static const pagePadPhone = 16.0, pagePadTablet = 24.0, pagePadDesktop = 32.0;

  static const durFast = Duration(milliseconds: 120);
  static const dur = Duration(milliseconds: 200);
  static const durSlow = Duration(milliseconds: 280);
  static const ease = Cubic(.2, 0, 0, 1);

  /// Tabular lining figures: every number in the app.
  static const tabular = [FontFeature.tabularFigures(), FontFeature.liningFigures()];

  static const sans = 'IBM Plex Sans';
  static const mono = 'IBM Plex Mono';
}

/// Amounts and anything else that lines up in a column: tabular lining
/// figures in the UI face (Plex Sans). Not monospace — that is [kMono].
const TextStyle kNum = TextStyle(fontFamily: Ds.sans, fontFeatures: Ds.tabular);

/// Machine strings only: card numbers, UPI refs, raw bank merchant strings,
/// revealed passwords and keys, file names.
const TextStyle kMono = TextStyle(
  fontFamily: Ds.mono,
  fontFamilyFallback: ['monospace'],
  fontFeatures: Ds.tabular,
);

/// Category appearance is defined once on the server; both clients read
/// `category.icon`. The web resolves these ids against an SVG sprite, so
/// this maps the same ids onto Material icons (the design set has no
/// food, car or basket glyphs).
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
    case 'ic-people':
      return Icons.people_outline;
    case 'ic-dots':
      return Icons.more_horiz;
    default:
      return Icons.label_outline;
  }
}

/// Parses the "#RRGGBB" the server stores for each category.
Color parseHexColor(String? hex, {Color fallback = const Color(0xFF8A8780)}) {
  if (hex == null) return fallback;
  final cleaned = hex.replaceFirst('#', '');
  if (cleaned.length != 6) return fallback;
  final value = int.tryParse(cleaned, radix: 16);
  return value == null ? fallback : Color(0xFF000000 | value);
}

/// The type scale (§4.2). Every style carries tabular figures, so a number
/// lines up wherever it lands.
TextTheme dsTextTheme(Color tx, Color tx2) {
  TextStyle s(double size, double lh, FontWeight w, {double em = 0, Color? c}) => TextStyle(
        fontFamily: Ds.sans,
        fontSize: size,
        height: lh / size,
        fontWeight: w,
        letterSpacing: em * size,
        color: c ?? tx,
        fontFeatures: Ds.tabular,
      );
  return TextTheme(
    displayLarge: s(44, 52, FontWeight.w600, em: -0.02), // hero money
    displayMedium: s(40, 48, FontWeight.w600, em: -0.02),
    displaySmall: s(34, 40, FontWeight.w600, em: -0.02), // big figure; phone hero
    headlineLarge: s(28, 34, FontWeight.w600, em: -0.02),
    headlineMedium: s(26, 32, FontWeight.w600, em: -0.02),
    headlineSmall: s(22, 28, FontWeight.w600), // page title, stat value
    titleLarge: s(19, 26, FontWeight.w600), // dialog / recommendation
    titleMedium: s(17, 24, FontWeight.w600), // section header
    titleSmall: s(15, 20, FontWeight.w600), // card / row title
    bodyLarge: s(15, 22, FontWeight.w400),
    bodyMedium: s(14, 20, FontWeight.w400),
    bodySmall: s(13, 18, FontWeight.w400, c: tx2),
    labelLarge: s(15, 20, FontWeight.w600), // buttons
    labelMedium: s(12, 16, FontWeight.w600, em: 0.02, c: tx2), // field labels, eyebrows
    labelSmall: s(11, 14, FontWeight.w600, c: tx2),
  );
}

ThemeData buildTheme(Brightness brightness) =>
    dsTheme(brightness == Brightness.dark ? DsColors.dark : DsColors.light, brightness);

ThemeData dsTheme(DsColors c, Brightness b) {
  final scheme = ColorScheme(
    brightness: b,
    primary: c.ac,
    onPrimary: c.acTx,
    primaryContainer: c.acSoft,
    onPrimaryContainer: c.ac,
    secondary: c.tx,
    onSecondary: c.bg,
    secondaryContainer: c.sunk,
    onSecondaryContainer: c.tx,
    tertiary: c.good,
    onTertiary: c.sf,
    tertiaryContainer: c.goodSoft,
    onTertiaryContainer: c.good,
    error: c.crit,
    onError: c.sf,
    errorContainer: c.critSoft,
    onErrorContainer: c.crit,
    surface: c.sf,
    onSurface: c.tx,
    onSurfaceVariant: c.tx2,
    surfaceContainerLowest: c.sf,
    surfaceContainerLow: c.sf2,
    surfaceContainer: c.sf2,
    surfaceContainerHigh: c.sf2,
    surfaceContainerHighest: c.sunk,
    outline: c.ln2,
    outlineVariant: c.ln,
    inverseSurface: c.tx,
    onInverseSurface: c.bg,
    inversePrimary: b == Brightness.light ? const Color(0xFF93A8FF) : const Color(0xFF2C4FCB),
    shadow: const Color(0xFF18191D),
    scrim: c.scrim,
    surfaceTint: Colors.transparent,
  );
  final text = dsTextTheme(c.tx, c.tx2);
  final r10 = BorderRadius.circular(Ds.rMd);
  final r12 = BorderRadius.circular(Ds.rLg);
  final r14 = BorderRadius.circular(Ds.rXl);
  OutlineInputBorder ob(Color col, double w) =>
      OutlineInputBorder(borderRadius: r10, borderSide: BorderSide(color: col, width: w));
  final buttonText = text.labelLarge!.copyWith(fontSize: 14);

  return ThemeData(
    useMaterial3: true,
    brightness: b,
    colorScheme: scheme,
    scaffoldBackgroundColor: c.bg,
    canvasColor: c.bg,
    fontFamily: Ds.sans,
    textTheme: text,
    primaryTextTheme: text,
    extensions: <ThemeExtension<dynamic>>[c],
    splashFactory: InkRipple.splashFactory,
    dividerTheme: DividerThemeData(color: c.ln, thickness: 1, space: 1),
    textSelectionTheme: TextSelectionThemeData(
      cursorColor: c.ac,
      selectionColor: c.acLine,
      selectionHandleColor: c.ac,
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: c.bg,
      foregroundColor: c.tx,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleSpacing: Ds.pagePadPhone,
      titleTextStyle: text.headlineSmall,
      iconTheme: IconThemeData(color: c.tx2, size: 22),
      actionsIconTheme: IconThemeData(color: c.tx2, size: 22),
      shape: Border(bottom: BorderSide(color: c.ln)),
    ),
    cardTheme: CardThemeData(
      color: c.sf,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: r14, side: BorderSide(color: c.ln)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: c.ac,
        foregroundColor: c.acTx,
        disabledBackgroundColor: c.sunk,
        disabledForegroundColor: c.tx3,
        minimumSize: const Size(64, 48),
        padding: const EdgeInsets.symmetric(horizontal: 20),
        shape: RoundedRectangleBorder(borderRadius: r12),
        textStyle: text.labelLarge,
        elevation: 0,
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: c.ac,
        foregroundColor: c.acTx,
        disabledBackgroundColor: c.sunk,
        disabledForegroundColor: c.tx3,
        minimumSize: const Size(64, 48),
        padding: const EdgeInsets.symmetric(horizontal: 20),
        shape: RoundedRectangleBorder(borderRadius: r12),
        textStyle: text.labelLarge,
        elevation: 0,
        shadowColor: Colors.transparent,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        backgroundColor: c.sf,
        foregroundColor: c.tx,
        disabledForegroundColor: c.tx3,
        side: BorderSide(color: c.ln2),
        minimumSize: const Size(64, 44),
        padding: const EdgeInsets.symmetric(horizontal: 16),
        shape: RoundedRectangleBorder(borderRadius: r12),
        textStyle: buttonText,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: c.ac,
        disabledForegroundColor: c.tx3,
        minimumSize: const Size(40, 40),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        shape: RoundedRectangleBorder(borderRadius: r12),
        textStyle: buttonText,
      ),
    ),
    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(
        foregroundColor: c.tx2,
        disabledForegroundColor: c.ln2,
        shape: const CircleBorder(),
      ),
    ),
    iconTheme: IconThemeData(color: c.tx2, size: 20),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: c.sf,
      isDense: false,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 15),
      hintStyle: text.bodyLarge!.copyWith(color: c.tx3),
      labelStyle: text.bodyLarge!.copyWith(color: c.tx2),
      floatingLabelStyle: text.labelMedium!.copyWith(color: c.ac),
      helperStyle: text.bodySmall!.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
      errorStyle: text.bodySmall!.copyWith(fontSize: 12, height: 16 / 12, color: c.crit),
      prefixStyle: text.bodyLarge!.copyWith(color: c.tx2),
      suffixStyle: text.bodyMedium!.copyWith(color: c.tx3),
      border: ob(c.ln2, 1),
      enabledBorder: ob(c.ln2, 1),
      focusedBorder: ob(c.ac, 2),
      errorBorder: ob(c.crit, 2),
      focusedErrorBorder: ob(c.crit, 2),
      disabledBorder: ob(c.ln, 1),
      suffixIconColor: c.tx2,
      prefixIconColor: c.tx3,
    ),
    chipTheme: ChipThemeData(
      backgroundColor: c.sf,
      selectedColor: c.tx,
      disabledColor: c.sunk,
      labelStyle: text.bodySmall!.copyWith(
        fontWeight: FontWeight.w500,
        color: WidgetStateColor.resolveWith((s) => s.contains(WidgetState.selected) ? c.bg : c.tx),
      ),
      secondaryLabelStyle: text.bodySmall!.copyWith(fontWeight: FontWeight.w500, color: c.bg),
      side: WidgetStateBorderSide.resolveWith(
        (s) => BorderSide(color: s.contains(WidgetState.selected) ? c.tx : c.ln2),
      ),
      shape: const StadiumBorder(),
      showCheckmark: true,
      checkmarkColor: c.bg,
      iconTheme: IconThemeData(color: c.tx2, size: 16),
      padding: const EdgeInsets.symmetric(horizontal: 6),
      labelPadding: const EdgeInsets.symmetric(horizontal: 6),
      elevation: 0,
      pressElevation: 0,
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: SegmentedButton.styleFrom(
        backgroundColor: c.sunk,
        selectedBackgroundColor: c.sf,
        foregroundColor: c.tx2,
        selectedForegroundColor: c.tx,
        side: BorderSide(color: c.sunk, width: 2),
        shape: RoundedRectangleBorder(borderRadius: r12),
        textStyle: text.bodyMedium!.copyWith(fontWeight: FontWeight.w600),
      ),
    ),
    switchTheme: SwitchThemeData(
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.ac : c.ln2),
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.acTx : c.sf),
      trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
      thumbIcon: const WidgetStatePropertyAll(null),
    ),
    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.ac : c.sf),
      checkColor: WidgetStatePropertyAll(c.acTx),
      side: BorderSide(color: c.ln2, width: 1.5),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
    ),
    radioTheme: RadioThemeData(
      fillColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.ac : c.ln2),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: c.sf,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shadowColor: Colors.transparent,
      barrierColor: c.scrim,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.r3xl)),
      titleTextStyle: text.titleLarge!.copyWith(height: 24 / 19),
      contentTextStyle: text.bodyLarge!.copyWith(color: c.tx2),
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
    ),
    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: c.sf,
      modalBackgroundColor: c.sf,
      surfaceTintColor: Colors.transparent,
      modalBarrierColor: c.scrim,
      elevation: 0,
      modalElevation: 0,
      dragHandleColor: c.ln2,
      dragHandleSize: const Size(36, 4),
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl))),
    ),
    snackBarTheme: SnackBarThemeData(
      backgroundColor: c.tx,
      contentTextStyle: text.bodyMedium!.copyWith(color: c.bg),
      actionTextColor: c.bg,
      behavior: SnackBarBehavior.floating,
      insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      shape: RoundedRectangleBorder(borderRadius: r12),
      elevation: 0,
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.sf,
      indicatorColor: c.acSoft,
      indicatorShape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      height: 64,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
      labelTextStyle: WidgetStateProperty.resolveWith(
        (s) => text.labelMedium!.copyWith(letterSpacing: 0, color: s.contains(WidgetState.selected) ? c.ac : c.tx2),
      ),
      iconTheme: WidgetStateProperty.resolveWith(
        (s) => IconThemeData(size: 24, color: s.contains(WidgetState.selected) ? c.ac : c.tx2),
      ),
    ),
    tabBarTheme: TabBarThemeData(
      labelColor: c.tx,
      unselectedLabelColor: c.tx2,
      indicatorColor: c.ac,
      dividerColor: c.ln,
      labelStyle: text.bodyMedium!.copyWith(fontWeight: FontWeight.w600),
      unselectedLabelStyle: text.bodyMedium!.copyWith(fontWeight: FontWeight.w500),
    ),
    listTileTheme: ListTileThemeData(
      iconColor: c.tx2,
      textColor: c.tx,
      titleTextStyle: text.bodyLarge!.copyWith(fontWeight: FontWeight.w500, height: 20 / 15),
      subtitleTextStyle: text.bodySmall!.copyWith(color: c.tx3),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: c.ac,
      linearTrackColor: c.sunk,
      circularTrackColor: c.sunk,
      linearMinHeight: 6,
      borderRadius: BorderRadius.circular(3),
    ),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(color: c.tx, borderRadius: BorderRadius.circular(Ds.rMd)),
      textStyle: text.bodySmall!.copyWith(color: c.bg),
    ),
    popupMenuTheme: PopupMenuThemeData(
      color: c.sf,
      surfaceTintColor: Colors.transparent,
      elevation: 6,
      shadowColor: const Color(0x6618191D),
      shape: RoundedRectangleBorder(borderRadius: r12, side: BorderSide(color: c.ln)),
      textStyle: text.bodyMedium,
    ),
    menuTheme: MenuThemeData(
      style: MenuStyle(
        backgroundColor: WidgetStatePropertyAll(c.sf),
        surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        shape: WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius: r12, side: BorderSide(color: c.ln))),
      ),
    ),
    dropdownMenuTheme: DropdownMenuThemeData(
      textStyle: text.bodyLarge,
      menuStyle: MenuStyle(
        backgroundColor: WidgetStatePropertyAll(c.sf),
        surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        shape: WidgetStatePropertyAll(RoundedRectangleBorder(borderRadius: r12, side: BorderSide(color: c.ln))),
      ),
    ),
    datePickerTheme: DatePickerThemeData(
      backgroundColor: c.sf,
      surfaceTintColor: Colors.transparent,
      headerBackgroundColor: c.sf,
      headerForegroundColor: c.tx,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.r3xl)),
      todayBorder: BorderSide(color: c.ac, width: 2),
    ),
    timePickerTheme: TimePickerThemeData(
      backgroundColor: c.sf,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.r3xl)),
    ),
    floatingActionButtonTheme: FloatingActionButtonThemeData(
      backgroundColor: c.ac,
      foregroundColor: c.acTx,
      elevation: 0,
      focusElevation: 0,
      hoverElevation: 0,
      highlightElevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.r2xl)),
      extendedTextStyle: text.labelLarge,
    ),
    expansionTileTheme: ExpansionTileThemeData(
      iconColor: c.tx2,
      collapsedIconColor: c.tx2,
      textColor: c.tx,
      collapsedTextColor: c.tx,
      shape: const Border(),
      collapsedShape: const Border(),
    ),
  );
}
