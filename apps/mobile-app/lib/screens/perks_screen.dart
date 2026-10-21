import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../utils/format.dart';

import '../services/perk_import_watcher.dart';
import '../services/perk_reader.dart';
import '../services/reminder_service.dart';
import '../widgets/perk_sheet.dart';
import '../widgets/state_block.dart';

/// "I am at Gucci. Do I have anything?"
///
/// The search is the whole point of the screen, so it holds focus from the
/// moment it opens — this is the one place in the app you use standing up,
/// with a queue behind you.
class PerksScreen extends StatefulWidget {
  const PerksScreen({super.key});

  @override
  State<PerksScreen> createState() => _PerksScreenState();
}

class _PerksScreenState extends State<PerksScreen> {
  final _query = TextEditingController();
  final _amount = TextEditingController();

  PerkLookup? _answer;
  bool _asking = false;

  List<Perk> _perks = [];
  List<Account> _accounts = [];
  List<Category> _categories = [];

  /// Whether this server has a model to read a picture with.
  bool _canRead = false;

  /// Only while the screenshots are being uploaded - a second or two. The
  /// reading itself happens in the background (see PerkImportWatcher).
  bool _sending = false;

  /// Show only perks from this app or bank; null shows all.
  String? _sourceFilter;

  /// Whether the watched batch was still going last time we looked, so its
  /// finishing can reload the list.
  bool _jobWasRunning = false;

  final _watcher = PerkImportWatcher.instance;

  /// How many perks a model wrote that nobody has confirmed.
  int get _unreviewed => _perks.where((perk) => perk.needsReview).length;

  /// Every app or bank named on a perk, for the filter chips.
  List<String> get _sources {
    final seen = <String>{};
    for (final perk in _perks) {
      final source = perk.source?.trim();
      if (source != null && source.isNotEmpty) seen.add(source);
    }
    return seen.toList()..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
  }

  List<Perk> get _shown => _sourceFilter == null
      ? _perks
      : _perks.where((perk) => perk.source?.trim() == _sourceFilter).toList();

  @override
  void initState() {
    super.initState();
    _jobWasRunning = _watcher.job?.isRunning ?? false;
    _watcher.addListener(_onJobChanged);
    _load();
    PerkReader.instance.available().then((can) {
      if (!mounted) return;
      setState(() => _canRead = can);

      // Pick up a batch that was already going - from another phone, or
      // from before the watcher knew about it. The job lives on the
      // server, so closing the app does not lose it.
      if (can) {
        PerkReader.instance.newestImport().then((job) {
          if (job != null) _watcher.adoptIfRunning(job);
        }).catchError((_) => null);
      }
    });
  }

  void _onJobChanged() {
    if (!mounted) return;
    final running = _watcher.job?.isRunning ?? false;
    // The perks it wrote are new rows; the list has to go and get them.
    if (_jobWasRunning && !running) _load();
    _jobWasRunning = running;
    setState(() {});
  }

  @override
  void dispose() {
    _watcher.removeListener(_onJobChanged);
    _query.dispose();
    _amount.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/perks'),
        ApiClient.instance.get('/accounts'),
        ApiClient.instance.get('/categories'),
      ]);
      if (!mounted) return;
      setState(() {
        _perks = (results[0] as List<dynamic>).map((p) => Perk.fromJson(p as Map<String, dynamic>)).toList();
        // A filter on a source nothing has any more would show an empty list.
        if (!_sources.contains(_sourceFilter)) _sourceFilter = null;
        _accounts =
            (results[1] as List<dynamic>).map((a) => Account.fromJson(a as Map<String, dynamic>)).toList();
        _categories =
            (results[2] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList();
      });
    } catch (_) {
      // The list is not the point of the screen; the search still works.
    }
  }

  Future<void> _ask() async {
    final query = _query.text.trim();
    if (query.isEmpty) return;

    FocusScope.of(context).unfocus();
    setState(() => _asking = true);

    try {
      final rupees = double.tryParse(_amount.text.trim());
      final params = <String, String>{'q': query};
      if (rupees != null && rupees > 0) params['amountMinor'] = (rupees * 100).round().toString();

      final result = await ApiClient.instance.get('/perks/lookup?${Uri(queryParameters: params).query}');
      if (!mounted) return;
      setState(() => _answer = PerkLookup.fromJson(result as Map<String, dynamic>));
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("Couldn't check just now.")),
        );
      }
    } finally {
      if (mounted) setState(() => _asking = false);
    }
  }

  Future<void> _setUsed(Perk perk, bool used) async {
    await ApiClient.instance.post('/perks/${perk.id}/used', {'used': used}).catchError((_) => null);
    if (!mounted) return;

    // The answer on screen is now out of date about this one.
    final answer = _answer;
    if (answer != null && used) {
      setState(() {
        _answer = PerkLookup(
          query: answer.query,
          matches: answer.matches.where((match) => match.id != perk.id).toList(),
          floatAlternative: answer.floatAlternative,
          verdict: answer.verdict,
        );
      });
    }
    await _load();
  }

  Future<void> _edit(Perk? perk, {PerkDraft? draft}) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      builder: (_) => PerkSheet(
        perk: perk,
        draft: draft,
        accounts: _accounts,
        categories: _categories,
      ),
    );
    if (saved == true) await _load();
  }

  /// Screenshots from the gallery (one or many) or a photo. Asked rather
  /// than assumed: a coupon is as often a screenshot already on the phone
  /// as a thing in front of you.
  Future<void> _offerToRead() async {
    final fromCamera = await showModalBottomSheet<bool>(
      context: context,
      builder: (_) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const DsDragHandle(),
              const DsSheetHeader(title: 'Read coupons from pictures', icon: DsIcons.upload),
              const SizedBox(height: 8),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const DsIconTile(Icons.photo_library_outlined),
                title: const Text('Choose screenshots'),
                subtitle: const Text('One or several'),
                onTap: () => Navigator.of(context).pop(false),
              ),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const DsIconTile(Icons.photo_camera_outlined),
                title: const Text('Take a photo'),
                onTap: () => Navigator.of(context).pop(true),
              ),
            ],
          ),
        ),
      ),
    );
    if (fromCamera == null || !mounted) return;

    final List<XFile> pictures;
    if (fromCamera) {
      final photo = await PerkReader.instance.pick(fromCamera: true);
      pictures = photo == null ? const [] : [photo];
    } else {
      pictures = await PerkReader.instance.pickMany();
    }
    if (pictures.isEmpty || !mounted) return;
    await _import(pictures);
  }

  /// Hand the pictures to the server and give the screen straight back.
  ///
  /// Reading is ~30 s a picture, so even a single one goes through the
  /// background import: waiting on a spinner for that long is the
  /// complaint this replaces. PerkImportWatcher says when it is done.
  Future<void> _import(List<XFile> pictures) async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _sending = true);
    try {
      final job = await PerkReader.instance.startImport(pictures);
      await _watcher.watch(job);
      final n = pictures.length;
      messenger.showSnackBar(
        SnackBar(
          duration: const Duration(seconds: 6),
          content: Text(
            'Reading ${n == 1 ? 'your screenshot' : '$n screenshots'} in the background — about '
            '30 s each. ${n == 1 ? 'It will appear' : 'They will appear'} here for review and '
            'you will get a notification when it is done.',
          ),
        ),
      );
      // The first notification on Android 13+ needs the permission.
      ReminderService.instance.requestPermission().catchError((_) => false);
    } catch (error) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(error is ApiException ? error.message : 'Those could not be sent.'),
        ),
      );
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// How a batch is getting on, or what it did: the processing card.
  Widget _importCard(PerkImportJob job) {
    final c = context.c;
    final running = job.isRunning;
    final failed = job.status == 'FAILED';

    return DsCard(
      borderColor: running ? c.acLine : c.ln,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (running)
                const Padding(
                  padding: EdgeInsets.only(top: 2, right: 12),
                  child: DsSpinner(size: 24),
                )
              else
                Padding(
                  padding: const EdgeInsets.only(right: 12),
                  child: DsIconTile(
                    failed ? DsIcons.alertTriangle : DsIcons.check,
                    tone: failed ? DsTone.crit : DsTone.good,
                    size: 36,
                  ),
                ),
              Expanded(
                child: Text(
                  running
                      ? 'Reading your screenshots — ${job.read} of ${job.total} done.'
                      : failed
                          ? (job.problem ?? 'That batch did not finish.')
                          : job.summary,
                  style: TextStyle(
                    fontSize: 15,
                    height: 20 / 15,
                    fontWeight: FontWeight.w600,
                    color: failed ? c.crit : c.tx,
                    fontFeatures: Ds.tabular,
                  ),
                ),
              ),
              if (!running)
                IconButton(
                  tooltip: 'Dismiss',
                  icon: const DsIcon(DsIcons.x, size: 18),
                  onPressed: _watcher.dismiss,
                ),
            ],
          ),
          if (job.total > 0) ...[
            const SizedBox(height: 12),
            DsMeter(value: job.read / job.total, color: running ? c.ac : c.good),
          ],
          if (running) ...[
            const SizedBox(height: 8),
            Text(
              'About 30 s a picture. Carry on with anything else, or close the app — you will '
              'get a notification when they are ready to review.',
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
          ],
          for (final failure in job.failures) ...[
            const SizedBox(height: 8),
            // A file that couldn't be read sits on a critical tint.
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(color: c.critSoft, borderRadius: BorderRadius.circular(Ds.rMd)),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    failure.fileName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: kMono.copyWith(fontSize: 13, color: c.tx),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    failure.problem ?? 'could not be read',
                    style: TextStyle(fontSize: 12, height: 16 / 12, color: c.crit),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// Where screenshots go in: a dashed drop area with one action.
  Widget _dropzone() {
    final c = context.c;
    return DsDashedBorder(
      radius: Ds.rXl,
      strokeWidth: 1.5,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            const DsIconTile(DsIcons.upload, tone: DsTone.ac, iconSize: 24),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Read coupons from screenshots',
                    style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'About 30 s a picture. You will get a notification when they are ready.',
                    style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            OutlinedButton(
              onPressed: _sending ? null : _offerToRead,
              child: const Text('Choose'),
            ),
          ],
        ),
      ),
    );
  }


  /// The ones a model wrote that nobody has confirmed. They count for
  /// everything meanwhile - this is a prompt to glance, not a gate.
  Future<void> _confirmAll() async {
    await ApiClient.instance.post('/perks/reviewed', {}).catchError((_) => null);
    await _load();
  }


  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final coupons = _perks.where((perk) => perk.isCoupon).length;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Perks'),
        actions: [
          // Only where the server has a model. Without one this hides
          // rather than offering a button that fails - reading a picture
          // is an extra way to add a coupon and never the only one.
          if (_canRead)
            IconButton(
              tooltip: 'Read coupons from screenshots',
              onPressed: _sending ? null : _offerToRead,
              icon: _sending ? const DsSpinner(size: 18) : const DsIcon(DsIcons.upload),
            ),
          const SizedBox(width: 4),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        tooltip: 'Add a perk',
        onPressed: () => _edit(null),
        child: const DsIcon(DsIcons.plus, size: 24),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
        children: [
          TextField(
            controller: _query,
            autofocus: true,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _ask(),
            style: TextStyle(color: c.tx, fontSize: 15),
            decoration: InputDecoration(
              hintText: 'Where are you?',
              prefixIcon: Padding(
                padding: const EdgeInsets.only(left: 14, right: 10),
                child: DsIcon(DsIcons.search, size: 20, color: c.tx3),
              ),
              prefixIconConstraints: const BoxConstraints(minWidth: 44, minHeight: 52),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _amount,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  style: TextStyle(color: c.tx, fontSize: 15, fontFeatures: Ds.tabular),
                  decoration: const InputDecoration(
                    hintText: 'About to spend (optional)',
                    prefixText: '₹ ',
                  ),
                ),
              ),
              const SizedBox(width: 8),
              SizedBox(
                height: 52,
                child: FilledButton(
                  onPressed: _asking ? null : _ask,
                  child: Text(_asking ? '…' : 'Ask'),
                ),
              ),
            ],
          ),

          if (_answer != null) ...[
            const SizedBox(height: 16),
            _Answer(answer: _answer!, onUsed: (perk) => _setUsed(perk, true)),
          ],

          // A batch being read on the server, or one that just finished.
          if (_watcher.job != null) ...[
            const SizedBox(height: 16),
            _importCard(_watcher.job!),
          ] else if (_canRead) ...[
            const SizedBox(height: 16),
            _dropzone(),
          ],

          // The ones a model wrote that nobody has looked at. Offered for
          // a glance rather than held back - they count meanwhile.
          if (_unreviewed > 0) ...[
            const SizedBox(height: 12),
            DsCallout(
              tone: DsTone.ac,
              icon: DsIcons.sparkles,
              title: '$_unreviewed ${_unreviewed == 1 ? 'perk was' : 'perks were'} read off a '
                  'picture. Nobody has checked the figures yet — open any that look off.',
              action: Padding(
                padding: const EdgeInsets.only(top: 4),
                child: OutlinedButton(
                  onPressed: _confirmAll,
                  style: OutlinedButton.styleFrom(minimumSize: const Size(64, 36)),
                  child: const Text('All look right'),
                ),
              ),
            ),
          ],

          const SizedBox(height: 24),
          DsSectionHeader(
            "Everything you're holding",
            badge: _perks.isEmpty
                ? null
                : DsBadge('$coupons ${coupons == 1 ? 'coupon' : 'coupons'}'),
          ),
          const SizedBox(height: 12),

          // Which app or bank they came from, built from what is saved, so
          // "what do I have on CRED?" is one tap.
          if (_sources.isNotEmpty) ...[
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final source in [null, ..._sources])
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ChoiceChip(
                        label: Text(source ?? 'All'),
                        selected: _sourceFilter == source,
                        onSelected: (_) => setState(() => _sourceFilter = source),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
          ],

          if (_perks.isEmpty)
            StateBlock(
              icon: Icons.local_offer_outlined,
              title: 'Nothing saved yet',
              body: 'Add the cashback your cards give at particular shops, and any coupon codes you are '
                  'sitting on. Then you can ask this screen before you pay for anything.',
              actionLabel: 'Add the first one',
              onAction: () => _edit(null),
            )
          else
            for (final perk in _shown)
              Padding(
                padding: const EdgeInsets.only(bottom: kCardGap),
                child: _PerkRow(
                  perk: perk,
                  onEdit: () => _edit(perk),
                  onUsed: () => _setUsed(perk, perk.usedAt == null),
                  onRemove: () async {
                    await ApiClient.instance.delete('/perks/${perk.id}').catchError((_) => null);
                    await _load();
                  },
                ),
              ),
        ],
      ),
    );
  }
}

/// A coupon code in Plex Mono on a sunk strip, with a Copy action.
class _CodeStrip extends StatelessWidget {
  final String code;

  const _CodeStrip({required this.code});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    // Tappable because the next thing after reading a code is typing it
    // somewhere else.
    return Material(
      color: c.sunk,
      borderRadius: BorderRadius.circular(Ds.rMd),
      child: InkWell(
        borderRadius: BorderRadius.circular(Ds.rMd),
        onTap: () {
          Clipboard.setData(ClipboardData(text: code));
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Copied $code')),
          );
        },
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  code,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: kMono.copyWith(fontSize: 14, fontWeight: FontWeight.w500, color: c.tx),
                ),
              ),
              const SizedBox(width: 8),
              Container(
                height: 32,
                padding: const EdgeInsets.symmetric(horizontal: 10),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: c.sf,
                  border: Border.all(color: c.ln2),
                  borderRadius: BorderRadius.circular(Ds.rMd),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.copy, size: 14, color: c.tx2),
                    const SizedBox(width: 6),
                    Text('Copy', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.tx)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The answer, with the cashback first and the float underneath.
///
/// Settled deliberately: money back is certain and immediate, float is
/// timing. Both numbers stay in view and the decision is yours.
class _Answer extends StatelessWidget {
  final PerkLookup answer;
  final void Function(Perk) onUsed;

  const _Answer({required this.answer, required this.onUsed});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return DsCard(
      padding: EdgeInsets.zero,
      clip: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            color: c.acSoft,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 1),
                  child: DsIcon(DsIcons.tag, size: 20, color: c.ac),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    answer.verdict,
                    style: TextStyle(fontSize: 15, height: 22 / 15, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                ),
              ],
            ),
          ),
          for (final match in answer.matches) _MatchRow(match: match, onUsed: () => onUsed(match)),
          if (answer.floatAlternative != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(color: c.sf2, border: Border(top: BorderSide(color: c.ln))),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  DsIcon(DsIcons.creditCard, size: 18, color: c.tx3),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'Longest to pay: ${answer.floatAlternative!.name}, '
                      '${answer.floatAlternative!.floatDays} days'
                      '${answer.matches.isNotEmpty ? ' — but no offer here.' : '.'}',
                      style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _MatchRow extends StatelessWidget {
  final PerkMatch match;
  final VoidCallback onUsed;

  const _MatchRow({required this.match, required this.onUsed});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    final detail = <String>[
      if (match.valueMinor != null && match.valueMinor! > 0) '${formatMoney(match.valueMinor!)} back',
      if (match.minSpendMinor != null) 'over ${formatMoneyShort(match.minSpendMinor!)}',
      if (match.maxDiscountMinor != null) 'up to ${formatMoneyShort(match.maxDiscountMinor!)}',
      if (match.card?.floatDays != null) '${match.card!.floatDays} days to pay',
      if (match.daysLeft != null && match.daysLeft! <= 10)
        'expires in ${match.daysLeft} ${match.daysLeft == 1 ? 'day' : 'days'}',
    ];

    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: c.ln))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(
                          text: match.title,
                          style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                        ),
                        if (match.card != null)
                          TextSpan(
                            text: '  on ${match.card!.name}',
                            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: c.tx3),
                          ),
                        if (match.reach == 'ANYWHERE')
                          TextSpan(
                            text: '  everywhere',
                            style: TextStyle(fontSize: 12, color: c.tx3),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
              if (match.isCoupon) TextButton(onPressed: onUsed, child: const Text('Used it')),
            ],
          ),
          if (detail.isNotEmpty) ...[
            const SizedBox(height: 2),
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Text(
                '${detail.join(' · ')}.',
                style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2, fontFeatures: Ds.tabular),
              ),
            ),
          ],
          if (match.code != null) ...[
            const SizedBox(height: 10),
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: _CodeStrip(code: match.code!),
            ),
          ],
        ],
      ),
    );
  }
}

class _PerkRow extends StatefulWidget {
  final Perk perk;
  final VoidCallback onEdit;
  final VoidCallback onUsed;
  final VoidCallback onRemove;

  const _PerkRow({
    required this.perk,
    required this.onEdit,
    required this.onUsed,
    required this.onRemove,
  });

  @override
  State<_PerkRow> createState() => _PerkRowState();
}

/// Which of the two folds under a perk is open, if any.
enum _Fold { terms, text }

class _PerkRowState extends State<_PerkRow> {
  _Fold? _open;

  void _toggle(_Fold fold) => setState(() => _open = _open == fold ? null : fold);

  /// "from Google Pay", then the T&C and the screenshot text, each closed
  /// until asked for - they are long and only sometimes wanted.
  Widget _extras(DsColors c) {
    final perk = widget.perk;
    final source = perk.source?.trim() ?? '';
    final terms = perk.terms?.trim() ?? '';
    final text = perk.extractedText?.trim() ?? '';
    if (source.isEmpty && terms.isEmpty && text.isEmpty) return const SizedBox.shrink();

    Widget toggle(_Fold fold, String label) => InkWell(
          onTap: () => _toggle(fold),
          borderRadius: BorderRadius.circular(Ds.rMd),
          child: Container(
            constraints: const BoxConstraints(minHeight: 32),
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(label, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.ac)),
                const SizedBox(width: 2),
                DsIcon(_open == fold ? DsIcons.chevronUp : DsIcons.chevronDown, size: 16, color: c.ac),
              ],
            ),
          ),
        );

    final body = switch (_open) {
      _Fold.terms => terms,
      _Fold.text => text,
      null => '',
    };

    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 4,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (source.isNotEmpty) DsBadge('from $source'),
              if (terms.isNotEmpty) toggle(_Fold.terms, 'T&C'),
              if (text.isNotEmpty) toggle(_Fold.text, 'Text read from the screenshot'),
            ],
          ),
          if (body.isNotEmpty) ...[
            const SizedBox(height: 6),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: c.sf2,
                border: Border.all(color: c.ln),
                borderRadius: BorderRadius.circular(Ds.rMd),
              ),
              // Selectable so a code or a line of small print can be copied.
              child: SelectableText(body, style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx2)),
            ),
          ],
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final perk = widget.perk;
    final onEdit = widget.onEdit;
    final onUsed = widget.onUsed;
    final onRemove = widget.onRemove;

    final sub = <String>[
      perk.merchants.isNotEmpty ? perk.merchants.join(', ') : 'anywhere',
      if (perk.cardName != null) perk.cardName!,
      if (perk.code != null) perk.code!,
      if (perk.usedAt != null)
        'used'
      else if (perk.daysLeft != null)
        perk.daysLeft! < 0 ? 'expired' : '${perk.daysLeft} ${perk.daysLeft == 1 ? 'day' : 'days'} left',
      // Which of them a machine wrote, so the count in the banner above
      // is findable rather than just a number.
      if (perk.needsReview) 'read from a picture',
    ];
    final name = perk.merchants.isNotEmpty ? perk.merchants.first : perk.title;

    return Dismissible(
      key: ValueKey(perk.id),
      direction: DismissDirection.endToStart,
      onDismissed: (_) => onRemove(),
      background: Container(
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 20),
        decoration: BoxDecoration(color: c.critSoft, borderRadius: BorderRadius.circular(Ds.rXl)),
        child: DsIcon(DsIcons.trash, size: 20, color: c.crit),
      ),
      child: Opacity(
        opacity: perk.isLive ? 1 : 0.5,
        child: DsCard(
          onTap: onEdit,
          // One a machine wrote carries an accent edge, so it is visible
          // without reading the line under it.
          color: perk.needsReview ? c.acSoft : null,
          borderColor: perk.needsReview ? c.acLine : null,
          padding: const EdgeInsets.fromLTRB(16, 14, 8, 14),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DsMonogram(
                name,
                tone: perk.isCoupon ? DsTone.good : DsTone.ac,
                onTinted: perk.needsReview,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            perk.title,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 15,
                              height: 20 / 15,
                              fontWeight: FontWeight.w600,
                              color: c.tx,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        DsBadge(
                          perk.isCoupon ? 'Coupon' : 'Offer',
                          tone: perk.isCoupon ? DsTone.good : DsTone.ac,
                          onTinted: perk.needsReview,
                        ),
                      ],
                    ),
                    if (perk.worth.isNotEmpty) ...[
                      const SizedBox(height: 2),
                      Text(
                        perk.worth,
                        style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                      ),
                    ],
                    const SizedBox(height: 2),
                    Text(
                      sub.join(' · '),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                    ),
                    _extras(c),
                  ],
                ),
              ),
              if (perk.isCoupon)
                TextButton(
                  onPressed: onUsed,
                  style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 8)),
                  child: Text(perk.usedAt != null ? 'Unuse' : 'Used'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
