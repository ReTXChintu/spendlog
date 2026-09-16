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

/// A pile of screenshots being read on the server.
class PerkImportJob {
  final String id;
  final String status;
  final String? problem;
  final int total;
  final int done;
  final int failed;
  final int added;
  final int duplicates;
  final List<({String fileName, String? problem})> failures;

  PerkImportJob({
    required this.id,
    required this.status,
    this.problem,
    required this.total,
    required this.done,
    required this.failed,
    required this.added,
    required this.duplicates,
    this.failures = const [],
  });

  bool get isRunning => status != 'DONE' && status != 'FAILED';

  /// How many have been looked at, finished or failed.
  int get read => done + failed;

  factory PerkImportJob.fromJson(Map<String, dynamic> json) {
    final counts = (json['counts'] as Map<String, dynamic>?) ?? const {};
    return PerkImportJob(
      id: json['id'] as String,
      status: json['status'] as String? ?? 'QUEUED',
      problem: json['problem'] as String?,
      total: json['total'] as int? ?? 0,
      done: counts['done'] as int? ?? 0,
      failed: counts['failed'] as int? ?? 0,
      added: json['added'] as int? ?? 0,
      duplicates: json['duplicates'] as int? ?? 0,
      failures: ((json['failures'] as List?) ?? const [])
          .map((one) => (
                fileName: (one as Map<String, dynamic>)['fileName'] as String? ?? 'A picture',
                problem: one['problem'] as String?,
              ))
          .toList(),
    );
  }

  /// What happened, in the order somebody would ask.
  String get summary {
    final parts = ['$added added'];
    if (duplicates > 0) parts.add('$duplicates you already had');
    if (failed > 0) parts.add('$failed could not be read');
    return '${parts.join(', ')}. Check them over below.';
  }
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

  /// Several at once, already shrunk.
  Future<List<XFile>> pickMany() => _picker.pickMultiImage(
        maxWidth: _maxEdge,
        maxHeight: _maxEdge,
        imageQuality: 90,
      );

  /// Send the pile and get a job back. Returns as soon as the bytes are on
  /// the server — the reading is tens of seconds a picture and carries on
  /// without the phone.
  Future<PerkImportJob> startImport(List<XFile> pictures) async {
    final images = <Map<String, String>>[];
    for (final picture in pictures) {
      images.add({
        'name': picture.name,
        'base64': base64Encode(await picture.readAsBytes()),
      });
    }

    final json = await ApiClient.instance.post('/perks/import', {'images': images});
    return PerkImportJob.fromJson(json as Map<String, dynamic>);
  }

  /// How the newest batch is getting on, or null if there has never been
  /// one. Asked on load as well as while polling, so leaving the screen
  /// and coming back picks the job up rather than losing it.
  Future<PerkImportJob?> newestImport() async {
    final json = await ApiClient.instance.get('/perks/import');
    return json == null ? null : PerkImportJob.fromJson(json as Map<String, dynamic>);
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
