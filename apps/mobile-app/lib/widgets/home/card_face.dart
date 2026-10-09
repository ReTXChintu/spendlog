import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../models/models.dart';
import '../../services/api_client.dart';
import '../../services/vault_session.dart';
import '../../theme.dart';
import '../../utils/format.dart';
import '../card_vault_panel.dart';

/// A credit card is 85.60 × 53.98 mm, everywhere.
const double kCardAspect = 1.586;

/// The size every face is laid out at before being scaled to fit. Drawn at
/// one size, so the chip, the number and the bar keep their proportions on
/// any phone and nothing can wrap into the next line.
const double _designWidth = 340;
const double _designHeight = _designWidth / kCardAspect;

/// The two ends of a card's gradient: the colour picked for the account
/// when there is one, else something close to what that bank's cards look
/// like, else the network's, else the app's own graphite.
List<Color> cardGradient({String? color, String bankName = '', String? issuer, String? network}) {
  if (color != null) {
    final base = parseHexColor(color);
    final hsl = HSLColor.fromColor(base);
    return [
      hsl.withLightness((hsl.lightness - 0.16).clamp(0.04, 1.0)).toColor(),
      hsl.withLightness((hsl.lightness + 0.06).clamp(0.0, 0.92)).toColor(),
    ];
  }

  final who = '${issuer ?? ''} $bankName'.toLowerCase();
  const banks = <String, List<int>>{
    'hdfc': [0xFF0B2A5B, 0xFF1D4E9E],
    'icici': [0xFF6E1A1A, 0xFFC2410C],
    'sbi': [0xFF0E3A7A, 0xFF1F8FD1],
    'axis': [0xFF5B0F2E, 0xFF97144D],
    'kotak': [0xFF7F1D1D, 0xFFD3302F],
    'american express': [0xFF0F5E8C, 0xFF6FA8C9],
    'amex': [0xFF0F5E8C, 0xFF6FA8C9],
    'idfc': [0xFF5E1726, 0xFF9C2A3C],
    'yes': [0xFF0C3B7A, 0xFF1565C0],
    'indusind': [0xFF3F2614, 0xFF8B5A2B],
    'rbl': [0xFF0F2C4C, 0xFF21558A],
    'hsbc': [0xFF262626, 0xFF9F1C1C],
    'standard chartered': [0xFF0B5D3B, 0xFF1F7AB8],
    'federal': [0xFF0D2F6E, 0xFF2E5AA8],
    'onecard': [0xFF0D0D0D, 0xFF3A3A3A],
    'au small': [0xFF4C1D6B, 0xFF8E3FB5],
    'bob': [0xFF8A3A0F, 0xFFE0701B],
    'bank of baroda': [0xFF8A3A0F, 0xFFE0701B],
  };
  for (final entry in banks.entries) {
    if (who.contains(entry.key)) return [Color(entry.value[0]), Color(entry.value[1])];
  }

  return switch (network) {
    'VISA' => const [Color(0xFF141A5E), Color(0xFF3949AB)],
    'MASTERCARD' => const [Color(0xFF1B2128), Color(0xFF4F5B66)],
    'RUPAY' => const [Color(0xFF0B4F4A), Color(0xFF138A72)],
    'AMEX' => const [Color(0xFF0F5E8C), Color(0xFF6FA8C9)],
    'DINERS' => const [Color(0xFF263238), Color(0xFF607D8B)],
    _ => const [Color(0xFF2F3540), Color(0xFF55606E)],
  };
}

/// White on a dark card, ink on a pale one someone picked.
Color _inkOn(List<Color> gradient) {
  final mid = Color.lerp(gradient.first, gradient.last, 0.5)!;
  return mid.computeLuminance() > 0.5 ? const Color(0xFF111827) : Colors.white;
}

/// The bar along the bottom of a face, coloured by where the card stands
/// against the limit you set for it. Bright enough to read on any card.
Color cardStateTint(String state) => switch (state) {
      'over' => const Color(0xFFFF6B6B),
      'close' => const Color(0xFFFFC145),
      'ok' => const Color(0xFF5EE6A6),
      _ => const Color(0xD9FFFFFF),
    };

/// How much of the bar is filled: the bank's limit when there is one,
/// your own cycle limit when that is all there is.
double cardBarFraction(CardFace card) {
  final limit = card.creditLimitMinor;
  if (limit != null && limit > 0) return (card.usedMinor / limit).clamp(0.0, 1.0);
  final own = card.spendLimitMinor;
  if (own != null && own > 0) return (card.cycleSpentMinor / own).clamp(0.0, 1.0);
  return 0;
}

/// "•••• •••• •••• 1234" - the only part of the number a face ever shows.
String maskedCardNumber(String? last4) => '•••• •••• •••• ${last4 ?? '••••'}';

/// Groups of four, which is how a card number is read aloud.
String spacedCardNumber(String number) {
  final digits = number.replaceAll(RegExp(r'\s+'), '');
  return digits.replaceAllMapped(RegExp(r'.{4}'), (match) => '${match.group(0)} ').trim();
}

/// Fetches one card's details for its back. Swappable for tests.
typedef CardRevealer = Future<VaultDetails> Function(String accountId, String pin);

/// Asks for the PIN. Swappable for tests.
typedef PinAsker = Future<String?> Function(BuildContext context);

Future<VaultDetails> _revealFromServer(String accountId, String pin) async => VaultDetails.fromJson(
      await ApiClient.instance.post('/vault/cards/$accountId/reveal', {'pin': pin}) as Map<String, dynamic>,
    );

/// One credit card, drawn as the card itself.
///
/// The front is what anyone looking over your shoulder could see on the
/// plastic anyway: the bank, the chip, the last four digits, the network.
/// To that it adds what the plastic cannot - this cycle's spend, when the
/// bill is due, and a bar along the bottom for how much of the limit is
/// gone, coloured by how close the card is to the limit you set for it.
///
/// The eye turns it over. The back is fetched for that one card after the
/// vault PIN, held in this widget's memory and nowhere else - never in
/// storage, never in the vault session - and it turns itself face up again
/// after a minute, on a tap, or the moment the app goes to the background.
class CardFaceView extends StatefulWidget {
  const CardFaceView({
    super.key,
    required this.card,
    this.onOpen,
    this.onAddDetails,
    this.reveal,
    this.askPin,
    this.showFor = const Duration(seconds: 60),
  });

  final CardFace card;

  /// A tap on the front: this card's transactions, this statement cycle.
  final VoidCallback? onOpen;

  /// Where card details are added, for a card that has none stored.
  final VoidCallback? onAddDetails;
  final CardRevealer? reveal;
  final PinAsker? askPin;

  /// How long the back stays up before it turns over by itself.
  final Duration showFor;

  @override
  State<CardFaceView> createState() => _CardFaceViewState();
}

class _CardFaceViewState extends State<CardFaceView> with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final AnimationController _flip = AnimationController(vsync: this, duration: const Duration(milliseconds: 560));

  VaultDetails? _details;
  Timer? _countdown;
  int _secondsLeft = 0;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didUpdateWidget(covariant CardFaceView old) {
    super.didUpdateWidget(old);
    // A refresh that hands this slot another card must not keep showing
    // the first one's number.
    if (old.card.accountId != widget.card.accountId) _forgetNow();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) _forgetNow();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _countdown?.cancel();
    _flip.dispose();
    super.dispose();
  }

  void _say(String message, {SnackBarAction? action}) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(message), action: action));
  }

  Future<void> _turnOver() async {
    if (_busy) return;

    // The vault already open elsewhere - one PIN, a few minutes - means
    // the PIN was just typed, so it is not asked for again.
    var details = VaultSession.instance.detailsFor(widget.card.accountId);
    if (details == null) {
      final ask = widget.askPin ?? askVaultPin;
      final pin = await ask(context);
      if (pin == null || pin.isEmpty || !mounted) return;

      setState(() => _busy = true);
      try {
        details = await (widget.reveal ?? _revealFromServer)(widget.card.accountId, pin);
      } on ApiException catch (error) {
        if (!mounted) return;
        final addDetails = widget.onAddDetails;
        _say(
          switch (error.statusCode) {
            400 => 'Set a vault PIN first - it is on the account page.',
            404 => 'No details are stored for this card yet.',
            _ => error.message,
          },
          action: (error.statusCode == 400 || error.statusCode == 404) && addDetails != null
              ? SnackBarAction(label: 'Open', onPressed: addDetails)
              : null,
        );
      } catch (_) {
        if (mounted) _say("Couldn't reach the server to check the PIN.");
      } finally {
        if (mounted) setState(() => _busy = false);
      }
    }
    if (details == null || !mounted) return;

    setState(() {
      _details = details;
      _secondsLeft = widget.showFor.inSeconds;
    });
    _countdown?.cancel();
    _countdown = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      if (_secondsLeft <= 1) {
        _turnBack();
      } else {
        setState(() => _secondsLeft--);
      }
    });
    await _flip.forward();
  }

  /// Face up again, and the details dropped once it is.
  Future<void> _turnBack() async {
    _countdown?.cancel();
    _countdown = null;
    await _flip.reverse();
    if (mounted) setState(() => _details = null);
  }

  void _forgetNow() {
    _countdown?.cancel();
    _countdown = null;
    _flip.value = 0;
    if (_details != null && mounted) setState(() => _details = null);
  }

  void _copyNumber(VaultDetails details) {
    Clipboard.setData(ClipboardData(text: details.number.replaceAll(RegExp(r'\s+'), '')));
    _say('Card number copied.');
  }

  @override
  Widget build(BuildContext context) {
    final card = widget.card;
    final gradient = cardGradient(color: card.color, bankName: card.bankName, issuer: card.issuer, network: card.network);
    final ink = _inkOn(gradient);
    final reduceMotion = MediaQuery.maybeDisableAnimationsOf(context) ?? false;

    final front = _Surface(
      gradient: gradient,
      semanticLabel: '${card.name}, card ending ${card.last4 ?? 'unknown'}. Opens its transactions.',
      onTap: widget.onOpen,
      child: _Front(
        card: card,
        ink: ink,
        busy: _busy,
        onReveal: card.hasCardDetails ? _turnOver : null,
        onAddDetails: card.hasCardDetails ? null : widget.onAddDetails,
      ),
    );

    return AspectRatio(
      aspectRatio: kCardAspect,
      child: AnimatedBuilder(
        animation: _flip,
        builder: (context, _) {
          final details = _details;
          final t = Curves.easeInOutCubic.transform(_flip.value);
          final back = details == null
              ? null
              : _Surface(
                  gradient: [gradient.first, Color.lerp(gradient.first, gradient.last, 0.55)!],
                  semanticLabel: 'Card details. Tap to hide.',
                  onTap: _turnBack,
                  child: _Back(
                    details: details,
                    network: card.network,
                    ink: ink,
                    secondsLeft: _secondsLeft,
                    onCopy: () => _copyNumber(details),
                  ),
                );

          // Reduced motion: no turning in space, the two sides simply
          // trade places.
          if (reduceMotion || back == null) {
            if (back == null) return front;
            return Stack(
              fit: StackFit.expand,
              children: [
                IgnorePointer(ignoring: t >= 0.5, child: Opacity(opacity: 1 - t, child: front)),
                IgnorePointer(ignoring: t < 0.5, child: Opacity(opacity: t, child: back)),
              ],
            );
          }

          // Turned about its upright axis with a little perspective, the
          // back swapped in at the halfway point - edge on, when neither
          // side can be seen - and itself turned so it does not read
          // mirror-image.
          final angle = t * math.pi;
          final showingBack = angle > math.pi / 2;
          return Transform(
            alignment: Alignment.center,
            transform: Matrix4.identity()
              ..setEntry(3, 2, 0.0012)
              ..rotateY(angle),
            child: showingBack
                ? Transform(alignment: Alignment.center, transform: Matrix4.rotationY(math.pi), child: back)
                : front,
          );
        },
      ),
    );
  }
}

/// The plastic: gradient, rounded corners, a soft shadow and a sheen.
class _Surface extends StatelessWidget {
  const _Surface({required this.gradient, required this.child, this.onTap, required this.semanticLabel});

  final List<Color> gradient;
  final Widget child;
  final VoidCallback? onTap;
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(16);
    return Semantics(
      button: onTap != null,
      label: semanticLabel,
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: radius,
          boxShadow: [
            BoxShadow(color: gradient.first.withValues(alpha: .35), blurRadius: 18, offset: const Offset(0, 8)),
          ],
        ),
        child: ClipRRect(
          borderRadius: radius,
          child: Material(
            color: Colors.transparent,
            child: Ink(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: gradient,
                ),
              ),
              child: InkWell(
                onTap: onTap,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    // Two faint rings and a diagonal sheen, the way printed
                    // plastic catches the light.
                    const Positioned(right: -70, top: -90, child: _Ring(size: 240)),
                    const Positioned(left: -60, bottom: -120, child: _Ring(size: 220)),
                    DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: const Alignment(-1, -1),
                          end: const Alignment(1, 1),
                          colors: [
                            Colors.white.withValues(alpha: .14),
                            Colors.white.withValues(alpha: 0),
                            Colors.white.withValues(alpha: .05),
                          ],
                          stops: const [0, 0.45, 1],
                        ),
                      ),
                    ),
                    // The whole card scales as one, so the phone's text size
                    // grows it with everything else rather than pushing the
                    // number off the bottom.
                    FittedBox(
                      fit: BoxFit.contain,
                      child: MediaQuery.withNoTextScaling(
                        child: SizedBox(width: _designWidth, height: _designHeight, child: child),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Ring extends StatelessWidget {
  const _Ring({required this.size});

  final double size;

  @override
  Widget build(BuildContext context) => IgnorePointer(
        child: Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: Colors.white.withValues(alpha: .07), width: 26),
          ),
        ),
      );
}

class _Front extends StatelessWidget {
  const _Front({required this.card, required this.ink, required this.busy, this.onReveal, this.onAddDetails});

  final CardFace card;
  final Color ink;
  final bool busy;
  final VoidCallback? onReveal;
  final VoidCallback? onAddDetails;

  @override
  Widget build(BuildContext context) {
    final soft = ink.withValues(alpha: .72);
    final title = card.bankName.isNotEmpty ? card.bankName : card.name;
    final subtitle = card.name != title ? card.name : null;

    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 12, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title.toUpperCase(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, letterSpacing: 1.1, color: ink),
                      ),
                      if (subtitle != null)
                        Text(
                          subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w500, color: soft),
                        ),
                    ],
                  ),
                ),
              ),
              if (onReveal != null)
                busy
                    ? Padding(
                        padding: const EdgeInsets.all(11),
                        child: SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2, color: ink),
                        ),
                      )
                    : IconButton(
                        onPressed: onReveal,
                        tooltip: 'Show card details',
                        constraints: const BoxConstraints.tightFor(width: 40, height: 40),
                        padding: EdgeInsets.zero,
                        icon: Icon(Icons.visibility_outlined, color: ink, size: 21),
                      )
              else if (onAddDetails != null)
                Padding(
                  padding: const EdgeInsets.only(top: 2, right: 4),
                  child: _Pill(label: 'Add card details', ink: ink, onTap: onAddDetails!),
                ),
            ],
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              const _Chip(),
              const SizedBox(width: 10),
              Icon(Icons.contactless_outlined, size: 22, color: soft),
            ],
          ),
          const Spacer(),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              maskedCardNumber(card.last4),
              maxLines: 1,
              style: kNum.copyWith(fontSize: 19, letterSpacing: 2.2, fontWeight: FontWeight.w600, color: ink),
            ),
          ),
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Flexible(
                        child: _Field(label: 'THIS CYCLE', value: formatMoneyShort(card.cycleSpentMinor), ink: ink),
                      ),
                      const SizedBox(width: 22),
                      Flexible(child: _Field(label: 'BILL DUE', value: _dueLabel(card), ink: ink)),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                NetworkMark(network: card.network, color: ink),
              ],
            ),
          ),
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: _Bar(fraction: cardBarFraction(card), tint: cardStateTint(card.state), ink: ink),
          ),
        ],
      ),
    );
  }
}

/// "14 Oct", with how soon when it is close.
String _dueLabel(CardFace card) {
  final date = formatIsoShortDate(card.nextDueOn ?? '');
  if (date.isEmpty) return '—';
  final days = card.daysToDue;
  if (days == null || days > 7) return date;
  if (days < 0) return '$date · late';
  if (days == 0) return '$date · today';
  return '$date · ${days}d';
}

class _Back extends StatelessWidget {
  const _Back({
    required this.details,
    required this.network,
    required this.ink,
    required this.secondsLeft,
    required this.onCopy,
  });

  final VaultDetails details;
  final String? network;
  final Color ink;
  final int secondsLeft;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    final soft = ink.withValues(alpha: .72);
    final note = details.note?.trim();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 18),
        // The magnetic stripe. There is no signature panel and no CVV:
        // the CVV is never stored, so there is nothing to put there.
        Container(height: 34, color: const Color(0xE6111111)),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('CARD NUMBER · HOLD TO COPY', style: _label(soft)),
                const SizedBox(height: 3),
                GestureDetector(
                  onLongPress: onCopy,
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(
                      spacedCardNumber(details.number),
                      style: kNum.copyWith(fontSize: 20, letterSpacing: 1.8, fontWeight: FontWeight.w700, color: ink),
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _Field(label: 'VALID THRU', value: details.expiry ?? '—', ink: ink),
                    const SizedBox(width: 22),
                    Expanded(
                      child: _Field(label: 'NAME ON CARD', value: (details.nameOnCard ?? '—').toUpperCase(), ink: ink),
                    ),
                  ],
                ),
                if (note != null && note.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(note, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 10.5, color: soft)),
                ],
                const Spacer(),
                Row(
                  children: [
                    Icon(Icons.timer_outlined, size: 13, color: soft),
                    const SizedBox(width: 4),
                    Expanded(
                      child: Text(
                        'Hides in ${secondsLeft}s · tap to turn over',
                        style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: soft),
                      ),
                    ),
                    NetworkMark(network: network, color: ink),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

TextStyle _label(Color color) =>
    TextStyle(fontSize: 7.5, fontWeight: FontWeight.w800, letterSpacing: 1.1, color: color);

/// A small caps label over a value, the way "VALID THRU" sits on a card.
class _Field extends StatelessWidget {
  const _Field({required this.label, required this.value, required this.ink});

  final String label;
  final String value;
  final Color ink;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label, style: _label(ink.withValues(alpha: .66))),
          const SizedBox(height: 2),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: kNum.copyWith(fontSize: 13, fontWeight: FontWeight.w700, color: ink),
          ),
        ],
      );
}

class _Bar extends StatelessWidget {
  const _Bar({required this.fraction, required this.tint, required this.ink});

  final double fraction;
  final Color tint;
  final Color ink;

  @override
  Widget build(BuildContext context) => ClipRRect(
        borderRadius: BorderRadius.circular(100),
        child: SizedBox(
          height: 5,
          child: Stack(
            fit: StackFit.expand,
            children: [
              ColoredBox(color: ink.withValues(alpha: .22)),
              FractionallySizedBox(
                alignment: Alignment.centerLeft,
                widthFactor: fraction,
                child: ColoredBox(color: tint),
              ),
            ],
          ),
        ),
      );
}

class _Pill extends StatelessWidget {
  const _Pill({required this.label, required this.ink, required this.onTap});

  final String label;
  final Color ink;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
        color: ink.withValues(alpha: .16),
        borderRadius: BorderRadius.circular(100),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(100),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.add, size: 13, color: ink),
                const SizedBox(width: 3),
                Text(label, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: ink)),
              ],
            ),
          ),
        ),
      );
}

/// The EMV chip: gold, with its contact pads.
class _Chip extends StatelessWidget {
  const _Chip();

  @override
  Widget build(BuildContext context) => Container(
        width: 42,
        height: 32,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(6),
          gradient: const LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color(0xFFF3E2A9), Color(0xFFC9A24A), Color(0xFFE9D08A)],
          ),
          border: Border.all(color: const Color(0x66000000), width: 0.6),
        ),
        child: CustomPaint(painter: _ChipPads()),
      );
}

class _ChipPads extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0x55000000)
      ..strokeWidth = 0.8
      ..style = PaintingStyle.stroke;
    final w = size.width;
    final h = size.height;
    canvas.drawLine(Offset(0, h * .34), Offset(w * .34, h * .34), paint);
    canvas.drawLine(Offset(0, h * .66), Offset(w * .34, h * .66), paint);
    canvas.drawLine(Offset(w * .66, h * .34), Offset(w, h * .34), paint);
    canvas.drawLine(Offset(w * .66, h * .66), Offset(w, h * .66), paint);
    canvas.drawLine(Offset(w * .5, 0), Offset(w * .5, h * .22), paint);
    canvas.drawLine(Offset(w * .5, h * .78), Offset(w * .5, h), paint);
    canvas.drawRRect(
      RRect.fromRectAndRadius(Rect.fromLTRB(w * .34, h * .22, w * .66, h * .78), const Radius.circular(3)),
      paint,
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// The network's name, set the way it is printed on the card.
class NetworkMark extends StatelessWidget {
  const NetworkMark({super.key, required this.network, required this.color, this.scale = 1});

  final String? network;
  final Color color;
  final double scale;

  @override
  Widget build(BuildContext context) {
    final s = scale;
    switch (network) {
      case 'VISA':
        return Text(
          'VISA',
          style: TextStyle(
            fontSize: 22 * s,
            fontWeight: FontWeight.w900,
            fontStyle: FontStyle.italic,
            letterSpacing: 0.5 * s,
            color: color,
            height: 1,
          ),
        );
      case 'MASTERCARD':
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 30 * s,
              height: 19 * s,
              child: Stack(
                children: [
                  _dot(const Color(0xFFEB001B), 0, s),
                  _dot(const Color(0xDDF79E1B), 11 * s, s),
                ],
              ),
            ),
            SizedBox(width: 4 * s),
            Text(
              'mastercard',
              style: TextStyle(fontSize: 12 * s, fontWeight: FontWeight.w700, letterSpacing: -0.2, color: color),
            ),
          ],
        );
      case 'RUPAY':
        return Text.rich(
          TextSpan(children: [
            const TextSpan(text: 'Ru'),
            TextSpan(text: 'Pay', style: TextStyle(color: color.withValues(alpha: .8))),
          ]),
          style: TextStyle(
            fontSize: 19 * s,
            fontWeight: FontWeight.w900,
            fontStyle: FontStyle.italic,
            color: color,
            height: 1,
          ),
        );
      case 'AMEX':
        return Container(
          padding: EdgeInsets.symmetric(horizontal: 5 * s, vertical: 2 * s),
          decoration: BoxDecoration(border: Border.all(color: color, width: 1.4 * s)),
          child: Text(
            'AMEX',
            style: TextStyle(fontSize: 13 * s, fontWeight: FontWeight.w900, letterSpacing: 1.6 * s, color: color),
          ),
        );
      case 'DINERS':
        return Text(
          'Diners Club',
          style: TextStyle(fontSize: 13 * s, fontWeight: FontWeight.w700, fontStyle: FontStyle.italic, color: color),
        );
      default:
        return const SizedBox.shrink();
    }
  }

  Widget _dot(Color colour, double left, double s) => Positioned(
        left: left,
        top: 0,
        child: Container(
          width: 19 * s,
          height: 19 * s,
          decoration: BoxDecoration(color: colour, shape: BoxShape.circle),
        ),
      );
}
