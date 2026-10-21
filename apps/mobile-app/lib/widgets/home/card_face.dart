import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../models/models.dart';
import '../../services/api_client.dart';
import '../../services/vault_session.dart';
import '../ds/ds.dart';
import '../../utils/format.dart';
import '../card_vault_panel.dart';

/// A credit card is 85.60 × 53.98 mm, everywhere.
const double kCardAspect = 1.586;

/// The size every face is laid out at before being scaled to fit. Drawn at
/// one size, so the chip, the number and the bar keep their proportions on
/// any phone and nothing can wrap into the next line.
const double _designWidth = 328;
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
    // The four the design draws (§3.4); the rest are close to the plastic.
    'hdfc': [0xFF0B2554, 0xFF1C4F9C],
    'icici': [0xFF7A1717, 0xFFC2522A],
    'sbi': [0xFF0D4A8F, 0xFF2B8AD3],
    'axis': [0xFF5E0F31, 0xFFA41E55],
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
    // Neutral graphite for an issuer the design has no gradient for.
    _ => const [Color(0xFF2A2B30), Color(0xFF4C4D53)],
  };
}

/// The revealed side: the same card, darker (HDFC's #0B2554 → #071733).
List<Color> revealedGradient(List<Color> gradient) => [
      Color.lerp(gradient.first, Colors.black, 0.36)!,
      Color.lerp(gradient.last, Colors.black, 0.3)!,
    ];

/// White on a dark card, ink on a pale one someone picked.
Color _inkOn(List<Color> gradient) {
  final mid = Color.lerp(gradient.first, gradient.last, 0.5)!;
  return mid.computeLuminance() > 0.5 ? const Color(0xFF111827) : Colors.white;
}

/// The bar along the bottom of a face, coloured by where the card stands
/// against whatever the bar measures: mint, amber, coral (§3.4). Bright
/// enough to read on any card.
Color cardStateTint(String state) => switch (state) {
      'over' => const Color(0xFFFF9A90),
      'close' => const Color(0xFFFFCB70),
      'ok' => const Color(0xFF7EE2AE),
      _ => const Color(0xD9FFFFFF),
    };

/// How much of the bank's credit line can go before the bar changes
/// colour: fine below 70%, close from 70%, over from 90% - and over past
/// the limit itself. Later than a lender's comfort zone on purpose: the bar
/// is about running out, not about a credit score. The server works the
/// same state out (cards.status.ts); this is for a face it sent none for.
const double kCreditCloseAt = 0.70;
const double kCreditOverAt = 0.90;

/// ok | close | over, for [usedMinor] of a [limitMinor] credit line;
/// unset when there is no limit to measure against.
String creditUtilisationState(int usedMinor, int limitMinor) {
  if (limitMinor <= 0) return 'unset';
  final share = usedMinor / limitMinor;
  if (share >= kCreditOverAt) return 'over';
  if (share >= kCreditCloseAt) return 'close';
  return 'ok';
}

/// What a card's bar is measuring.
enum CardBarBasis {
  /// Credit used against the bank's limit: the bill still unpaid plus
  /// everything charged since.
  creditLimit,

  /// No credit limit known, or no billing cycle to say what is owed: an
  /// empty track, and an offer to set whichever is missing.
  none,
}

/// The bar along the bottom of a face: what it measures, how full it is,
/// and the state that colours it (ok | close | over | unset).
typedef CardBar = ({CardBarBasis basis, double fraction, String state});

/// What the limit has lost, by the best figure there is.
int creditUsedMinor(CardFace card) => card.usedMinor > 0 ? card.usedMinor : (card.outstandingMinor ?? 0);

/// Every card's bar is credit used against its credit limit, coloured by
/// the server's state. With no limit, or no cycle to count from, an empty
/// track.
CardBar cardBar(CardFace card) {
  final limit = card.creditLimitMinor;
  if (card.cycleKnown && limit != null && limit > 0) {
    final used = creditUsedMinor(card);
    return (
      basis: CardBarBasis.creditLimit,
      fraction: (used / limit).clamp(0.0, 1.0),
      state: card.state != 'unset' ? card.state : creditUtilisationState(used, limit),
    );
  }
  return (basis: CardBarBasis.none, fraction: 0.0, state: 'unset');
}

/// How much of the bar is filled.
double cardBarFraction(CardFace card) => cardBar(card).fraction;

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
/// To that it adds what the plastic cannot - what has been charged since the
/// last statement, when the bill is due, and a bar along the bottom for how
/// much of the credit limit is gone (see [cardBar]). All of it on the
/// card's own billing cycle.
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
                  gradient: revealedGradient(gradient),
                  semanticLabel: 'Card details. Tap to hide.',
                  onTap: _turnBack,
                  child: _Back(
                    details: details,
                    network: card.network,
                    ink: ink,
                    secondsLeft: _secondsLeft,
                    totalSeconds: widget.showFor.inSeconds,
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

/// The plastic (§7.9): a 135° issuer gradient, radius 16, and the small
/// lift card faces are allowed. White text on top.
class _Surface extends StatelessWidget {
  const _Surface({required this.gradient, required this.child, this.onTap, required this.semanticLabel});

  final List<Color> gradient;
  final Widget child;
  final VoidCallback? onTap;
  final String semanticLabel;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(Ds.r2xl);
    return Semantics(
      button: onTap != null,
      label: semanticLabel,
      child: DecoratedBox(
        decoration: BoxDecoration(borderRadius: radius, boxShadow: context.c.shadow),
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
                // The whole card scales as one, so the phone's text size
                // grows it with everything else rather than pushing the
                // number off the bottom.
                child: FittedBox(
                  fit: BoxFit.contain,
                  child: MediaQuery.withNoTextScaling(
                    child: SizedBox(width: _designWidth, height: _designHeight, child: child),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Plex Mono for the card number, as printed: tabular, widely tracked.
TextStyle _cardNumberStyle(double size, double tracking, Color ink) => kMono.copyWith(
      fontSize: size,
      letterSpacing: size * tracking,
      fontWeight: FontWeight.w500,
      color: ink,
      height: 1.2,
    );

class _Front extends StatelessWidget {
  const _Front({required this.card, required this.ink, required this.busy, this.onReveal, this.onAddDetails});

  final CardFace card;
  final Color ink;
  final bool busy;
  final VoidCallback? onReveal;
  final VoidCallback? onAddDetails;

  @override
  Widget build(BuildContext context) {
    final title = card.bankName.isNotEmpty ? card.bankName : card.name;
    final subtitle = card.name != title ? card.name : null;
    final bar = cardBar(card);
    final days = card.daysToDue;
    final dueSoon = days != null && days <= 7 && (card.nextDueOn ?? '').isNotEmpty;
    final due = _dueLabel(card);

    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Bank · product, and the network's wordmark.
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Text(
                  subtitle == null ? title : '$title · $subtitle',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: ink),
                ),
              ),
              const SizedBox(width: 8),
              NetworkMark(network: card.network, color: ink),
            ],
          ),
          const Spacer(),
          // Chip, the last four, and the eye.
          Row(
            children: [
              const _Chip(),
              const SizedBox(width: 12),
              Expanded(
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(
                    maskedCardNumber(card.last4),
                    maxLines: 1,
                    style: _cardNumberStyle(17, .12, ink),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              if (onReveal != null)
                busy
                    ? SizedBox(
                        width: 40,
                        height: 40,
                        child: Center(
                          child: SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2, color: ink),
                          ),
                        ),
                      )
                    : Material(
                        color: Colors.white.withValues(alpha: .14),
                        shape: const CircleBorder(),
                        child: IconButton(
                          onPressed: onReveal,
                          tooltip: 'Show card details',
                          constraints: const BoxConstraints.tightFor(width: 40, height: 40),
                          padding: EdgeInsets.zero,
                          icon: DsIcon(DsIcons.eye, color: ink, size: 20),
                        ),
                      ),
            ],
          ),
          // Not set up: the white button gets its own line, so the number
          // keeps its size beside the chip.
          if (onReveal == null && onAddDetails != null) ...[
            const SizedBox(height: 10),
            _AddDetailsButton(label: 'Add card details', ink: ink, onTap: onAddDetails!),
          ],
          const Spacer(),
          // How much of the limit is gone, then the bill and the cycle.
          _Bar(fraction: bar.fraction, tint: cardStateTint(bar.state), ink: ink),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: Text(
                  due == '—' ? 'No due date' : 'Bill due $due',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: kNum.copyWith(
                    fontSize: 12,
                    height: 16 / 12,
                    fontWeight: dueSoon ? FontWeight.w600 : FontWeight.w400,
                    color: ink,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Opacity(
                opacity: .85,
                child: Text(
                  // No billing date, no cycle: nothing to put here that
                  // would not be a guess.
                  'This cycle ${card.unbilledMinor == null ? '—' : formatMoneyShort(card.unbilledMinor!)}',
                  maxLines: 1,
                  style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: ink),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// "14 Oct", for a date the server sent: a plain YYYY-MM-DD as it is, an
/// instant by the day it falls on in IST. A due date stored as midnight in
/// Delhi is the evening before in UTC, and read as UTC it named the wrong
/// day.
String formatCardDate(String? iso) {
  if (iso == null || iso.isEmpty) return '';
  final parsed = DateTime.tryParse(iso);
  if (parsed == null) return '';
  return iso.length <= 10 ? formatIsoShortDate(iso) : formatShortDate(parsed);
}

/// "14 Oct", with how soon when it is close.
String _dueLabel(CardFace card) {
  final date = formatCardDate(card.nextDueOn);
  if (date.isEmpty) return '—';
  final days = card.daysToDue;
  if (days == null || days > 7) return date;
  if (days < 0) return '$date · late';
  if (days == 0) return '$date · today';
  return '$date · ${days}d';
}

/// The revealed side (§7.9): a magnetic stripe, the full number in Mono,
/// valid thru and the name, and a ring counting down to turning back.
class _Back extends StatelessWidget {
  const _Back({
    required this.details,
    required this.network,
    required this.ink,
    required this.secondsLeft,
    required this.totalSeconds,
    required this.onCopy,
  });

  final VaultDetails details;
  final String? network;
  final Color ink;
  final int secondsLeft;
  final int totalSeconds;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    final soft = ink.withValues(alpha: .75);
    final note = details.note?.trim();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 18),
        // The magnetic stripe. There is no signature panel and no CVV:
        // the CVV is never stored, so there is nothing to put there.
        Container(height: 36, color: const Color(0x8C000000)),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Card number · hold to copy', style: _label(soft)),
                const SizedBox(height: 2),
                GestureDetector(
                  onLongPress: onCopy,
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(spacedCardNumber(details.number), style: _cardNumberStyle(19, .1, ink)),
                  ),
                ),
                const SizedBox(height: 8),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _Field(label: 'Valid thru', value: details.expiry ?? '—', ink: ink, mono: true),
                    const SizedBox(width: 20),
                    Expanded(
                      child: _Field(label: 'Name on card', value: (details.nameOnCard ?? '—').toUpperCase(), ink: ink),
                    ),
                  ],
                ),
                if (note != null && note.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(note, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: soft)),
                ],
                const Spacer(),
                Row(
                  children: [
                    _CountdownRing(fraction: totalSeconds <= 0 ? 0 : secondsLeft / totalSeconds),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Hides in $secondsLeft s · tap to turn over',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: kNum.copyWith(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w500, color: soft),
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

TextStyle _label(Color color) => TextStyle(fontSize: 11, height: 14 / 11, fontWeight: FontWeight.w400, color: color);

/// A small label over a value, the way "Valid thru" sits on a card. The
/// name keeps its printed capitals and spacing.
class _Field extends StatelessWidget {
  const _Field({required this.label, required this.value, required this.ink, this.mono = false});

  final String label;
  final String value;
  final Color ink;
  final bool mono;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label, style: _label(ink.withValues(alpha: .75))),
          const SizedBox(height: 2),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: mono
                ? _cardNumberStyle(14, .04, ink)
                : TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, letterSpacing: 13 * .08, color: ink),
          ),
        ],
      );
}

/// The 20 px countdown ring: a faint track and a white arc that shrinks.
class _CountdownRing extends StatelessWidget {
  const _CountdownRing({required this.fraction});

  final double fraction;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: 20,
        height: 20,
        child: CustomPaint(painter: _RingPainter(fraction.clamp(0.0, 1.0))),
      );
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.fraction);
  final double fraction;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = (Offset.zero & size).deflate(1.25);
    final track = Paint()
      ..color = const Color(0x40FFFFFF)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.5;
    final arc = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2.5
      ..strokeCap = StrokeCap.round;
    canvas.drawOval(rect, track);
    if (fraction > 0) canvas.drawArc(rect, -math.pi / 2, 2 * math.pi * fraction, false, arc);
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.fraction != fraction;
}

/// The in-card utilisation meter: 6 h on a translucent white track.
class _Bar extends StatelessWidget {
  const _Bar({required this.fraction, required this.tint, required this.ink});

  final double fraction;
  final Color tint;
  final Color ink;

  @override
  Widget build(BuildContext context) => ClipRRect(
        borderRadius: BorderRadius.circular(3),
        child: SizedBox(
          height: 6,
          child: Stack(
            fit: StackFit.expand,
            children: [
              ColoredBox(color: ink.withValues(alpha: .22)),
              FractionallySizedBox(
                alignment: Alignment.centerLeft,
                widthFactor: fraction,
                child: DecoratedBox(
                  decoration: BoxDecoration(color: tint, borderRadius: BorderRadius.circular(3)),
                ),
              ),
            ],
          ),
        ),
      );
}

/// The "not set up" action on a face: a white button, issuer-coloured text.
class _AddDetailsButton extends StatelessWidget {
  const _AddDetailsButton({required this.label, required this.ink, required this.onTap});

  final String label;
  final Color ink;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    // On a pale card someone picked, ink is dark: the button inverts.
    final light = ink == Colors.white;
    final fill = light ? Colors.white : ink;
    final text = light ? const Color(0xFF18191D) : Colors.white;
    return Material(
      color: fill,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          height: 32,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              DsIcon(DsIcons.plus, size: 14, color: text),
              const SizedBox(width: 4),
              Text(label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: text)),
            ],
          ),
        ),
      ),
    );
  }
}

/// The EMV chip: 38×28, radius 6, gold, with two contact lines.
class _Chip extends StatelessWidget {
  const _Chip();

  @override
  Widget build(BuildContext context) => Container(
        width: 38,
        height: 28,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(6),
          gradient: const LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [Color(0xFFE8D7A6), Color(0xFFB8995A)],
          ),
        ),
        child: CustomPaint(painter: _ChipLines()),
      );
}

class _ChipLines extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0x40000000)
      ..strokeWidth = 1;
    canvas.drawLine(const Offset(0, 9.5), Offset(size.width, 9.5), paint);
    canvas.drawLine(const Offset(0, 18.5), Offset(size.width, 18.5), paint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// The network's name, set as text the way it is printed on the card
/// (§7.9: wordmarks, not logos).
class NetworkMark extends StatelessWidget {
  const NetworkMark({super.key, required this.network, required this.color, this.scale = 1});

  final String? network;
  final Color color;
  final double scale;

  @override
  Widget build(BuildContext context) {
    final s = scale;
    TextStyle mark(double size, {bool italic = false, double tracking = 0, FontWeight weight = FontWeight.w700}) =>
        TextStyle(
          fontSize: size * s,
          fontWeight: weight,
          fontStyle: italic ? FontStyle.italic : FontStyle.normal,
          letterSpacing: size * s * tracking,
          color: color,
          height: 1,
        );
    switch (network) {
      case 'VISA':
        return Text('VISA', style: mark(18, italic: true, tracking: .04, weight: FontWeight.w800));
      case 'MASTERCARD':
        return Text('Mastercard', style: mark(14));
      case 'RUPAY':
        return Text('RuPay', style: mark(15, italic: true, weight: FontWeight.w800));
      case 'AMEX':
        return Container(
          padding: EdgeInsets.symmetric(horizontal: 5 * s, vertical: 2 * s),
          decoration: BoxDecoration(
            border: Border.all(color: color, width: 1.2 * s),
            borderRadius: BorderRadius.circular(3 * s),
          ),
          child: Text('AMEX', style: mark(12, tracking: .08)),
        );
      case 'DINERS':
        return Text('Diners Club', style: mark(13, italic: true));
      default:
        return const SizedBox.shrink();
    }
  }
}
