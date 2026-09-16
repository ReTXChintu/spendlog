import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import '../config.dart';
import 'api_client.dart';

/// Reading a coupon off a picture.
///
/// The model runs on your own server, on its processor, so this takes
/// tens of seconds rather than the moment an API would. What comes back
/// fills the form in; nothing is saved until you save it.
///
/// The picture is shrunk before it leaves the phone. A vision model turns
/// an image into tiles and the count grows with the area, so a full phone
/// photo costs minutes on CPU cores where a 1024px one costs seconds — and
/// a coupon is large text on a plain background, which survives it
/// completely. image_picker does the shrinking itself, so there is no
/// decoding to do here.

/// Longest side, in pixels. Comfortably enough to read a coupon.
const double _maxEdge = 1024;

class PerkDraft {
  final String kind;
  final String title;
  final List<String> merchants;
  final double? percent;
  final int? flatMinor;
  final int? maxDiscountMinor;
  final int? minSpendMinor;
  final DateTime? expiresOn;
  final String? code;
  final String? notes;
  final String? accountId;

  /// What it said the card was, kept even when nothing matched, so the
  /// sheet can say "it says HDFC Regalia, which you have not added".
  final String? cardNamed;

  /// Fields it could not find, so a blank reads as deliberate.
  final List<String> missing;

  PerkDraft({
    required this.kind,
    required this.title,
    required this.merchants,
    this.percent,
    this.flatMinor,
    this.maxDiscountMinor,
    this.minSpendMinor,
    this.expiresOn,
    this.code,
    this.notes,
    this.accountId,
    this.cardNamed,
    this.missing = const [],
  });

  factory PerkDraft.fromJson(Map<String, dynamic> json) => PerkDraft(
        kind: json['kind'] as String? ?? 'COUPON',
        title: json['title'] as String? ?? '',
        merchants: ((json['merchants'] as List?) ?? const [])
            .map((one) => one.toString())
            .toList(),
        percent: (json['percent'] as num?)?.toDouble(),
        flatMinor: (json['flatMinor'] as num?)?.toInt(),
        maxDiscountMinor: (json['maxDiscountMinor'] as num?)?.toInt(),
        minSpendMinor: (json['minSpendMinor'] as num?)?.toInt(),
        expiresOn: DateTime.tryParse((json['expiresOn'] as String?) ?? ''),
        code: json['code'] as String?,
        notes: json['notes'] as String?,
        accountId: json['accountId'] as String?,
        cardNamed: json['cardNamed'] as String?,
        missing: ((json['missing'] as List?) ?? const [])
            .map((one) => one.toString())
            .toList(),
      );
}

class PerkReader {
  PerkReader._();
  static final PerkReader instance = PerkReader._();

  final ImagePicker _picker = ImagePicker();

  /// Whether this server has a model to read with. Asked before the button
  /// is drawn: a deployment without one hides it rather than offering
  /// something that fails.
  Future<bool> available() async {
    try {
      final json = await ApiClient.instance.get('/perks/reader') as Map<String, dynamic>;
      return json['available'] as bool? ?? false;
    } catch (_) {
      return false;
    }
  }

  /// A picture from the camera or the gallery, already shrunk.
  Future<XFile?> pick({required bool fromCamera}) => _picker.pickImage(
        source: fromCamera ? ImageSource.camera : ImageSource.gallery,
        maxWidth: _maxEdge,
        maxHeight: _maxEdge,
        // High on purpose: the artefacts of a hard compression land on
        // exactly the small print this is trying to read.
        imageQuality: 90,
      );

  /// Send it, and wait. Uses its own request rather than ApiClient's,
  /// because this posts bytes rather than JSON and waits far longer than
  /// anything else in the app.
  Future<PerkDraft> read(XFile picture) async {
    final token = await ApiClient.getToken();
    final bytes = await picture.readAsBytes();

    final response = await http
        .post(
          Uri.parse('$apiBaseUrl/perks/read'),
          headers: {
            'Content-Type': _mimeOf(picture.path),
            if (token != null) 'Authorization': 'Bearer $token',
          },
          body: bytes,
        )
        .timeout(const Duration(minutes: 3));

    if (response.statusCode >= 400) {
      String message = 'That picture could not be read.';
      try {
        message = (jsonDecode(response.body) as Map)['error']?.toString() ?? message;
      } catch (_) {}
      throw ApiException(response.statusCode, message);
    }

    return PerkDraft.fromJson(jsonDecode(response.body) as Map<String, dynamic>);
  }

  /// The server only accepts the three it can decode, and image_picker
  /// hands back whatever the camera produced.
  String _mimeOf(String path) {
    final lower = path.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
  }
}
