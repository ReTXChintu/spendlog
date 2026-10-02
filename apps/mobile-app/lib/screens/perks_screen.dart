import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
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
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text('Read coupons from pictures',
                  style: TextStyle(fontWeight: FontWeight.w700)),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Choose screenshots'),
              subtitle: const Text('One or several'),
              onTap: () => Navigator.of(context).pop(false),
            ),
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Take a photo'),
              onTap: () => Navigator.of(context).pop(true),
            ),
          ],
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

  /// How a batch is getting on, or what it did.
  Widget _importCard(PerkImportJob job) {
    final c = context.c;
    final running = job.isRunning;

    return Container(
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: c.paper,
        border: Border.all(color: running ? c.brand : c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  running
                      ? 'Reading your screenshots — ${job.read} of ${job.total} done.'
                      : job.status == 'FAILED'
                          ? (job.problem ?? 'That batch did not finish.')
                          : job.summary,
                  style: TextStyle(fontSize: 12.5, height: 1.45, color: c.ink),
                ),
              ),
              if (!running)
                IconButton(
                  icon: const Icon(Icons.close, size: 17),
                  onPressed: _watcher.dismiss,
                ),
            ],
          ),
          if (job.total > 0) ...[
            const SizedBox(height: 9),
            ClipRRect(
              borderRadius: BorderRadius.circular(100),
              child: LinearProgressIndicator(
                value: job.read / job.total,
                minHeight: 6,
                backgroundColor: c.track,
                valueColor: AlwaysStoppedAnimation(running ? c.brand : c.credit),
              ),
            ),
          ],
          if (running) ...[
            const SizedBox(height: 8),
            Text(
              'About 30 s a picture. Carry on with anything else, or close the app — you will '
              'get a notification when they are ready to review.',
              style: TextStyle(fontSize: 11.5, height: 1.45, color: c.muted),
            ),
          ],
          for (final failure in job.failures) ...[
            const SizedBox(height: 6),
            Text(
              '${failure.fileName} — ${failure.problem ?? 'could not be read'}',
              style: TextStyle(fontSize: 11, color: c.muted),
            ),
          ],
        ],
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

    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: const Text('Perks'),
        shape: Border(bottom: BorderSide(color: c.line)),
        actions: [
          // Only where the server has a model. Without one this hides
          // rather than offering a button that fails - reading a picture
          // is an extra way to add a coupon and never the only one.
          if (_canRead)
            IconButton(
              tooltip: 'Read coupons from screenshots',
              onPressed: _sending ? null : _offerToRead,
              icon: _sending
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.document_scanner_outlined),
            ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _edit(null),
        child: const Icon(Icons.add),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 90),
        children: [
          // A batch being read on the server, or one that just finished.
          if (_watcher.job != null) ...[
            _importCard(_watcher.job!),
            const SizedBox(height: 14),
          ],

          // The ones a model wrote that nobody has looked at. Offered for
          // a glance rather than held back - they count meanwhile.
          if (_unreviewed > 0) ...[
            Container(
              padding: const EdgeInsets.all(13),
              decoration: BoxDecoration(
                color: c.brand50,
                border: Border.all(color: c.brand),
                borderRadius: BorderRadius.circular(T.rMd),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '$_unreviewed ${_unreviewed == 1 ? 'perk was' : 'perks were'} read off a '
                    'picture. Nobody has checked the figures yet — open any that look off.',
                    style: TextStyle(fontSize: 12, height: 1.45, color: c.ink70),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton(
                    onPressed: _confirmAll,
                    child: const Text('All look right'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
          ],

          TextField(
            controller: _query,
            autofocus: true,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _ask(),
            style: TextStyle(color: c.ink, fontSize: 15),
            decoration: InputDecoration(
              hintText: 'Where are you?',
              hintStyle: TextStyle(color: c.mutedLight),
              prefixIcon: Icon(Icons.search, size: 19, color: c.mutedLight),
              filled: true,
              fillColor: c.surface,
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(T.rSm),
                borderSide: BorderSide(color: c.lineStrong),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(T.rSm),
                borderSide: BorderSide(color: c.brand),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _amount,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  style: TextStyle(color: c.ink),
                  decoration: InputDecoration(
                    hintText: 'About to spend (optional)',
                    hintStyle: TextStyle(color: c.mutedLight),
                    prefixText: '₹ ',
                    isDense: true,
                    filled: true,
                    fillColor: c.surface,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(T.rSm),
                      borderSide: BorderSide(color: c.lineStrong),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(T.rSm),
                      borderSide: BorderSide(color: c.brand),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              FilledButton(
                onPressed: _asking ? null : _ask,
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 16),
                ),
                child: Text(_asking ? '…' : 'Ask'),
              ),
            ],
          ),

          if (_answer != null) ...[
            const SizedBox(height: 18),
            _Answer(answer: _answer!, onUsed: (perk) => _setUsed(perk, true)),
          ],

          const SizedBox(height: 26),
          Text(
            "EVERYTHING YOU'RE HOLDING",
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.5,
              color: c.muted,
            ),
          ),
          const SizedBox(height: 10),

          // Which app or bank they came from, built from what is saved, so
          // "what do I have on CRED?" is one tap.
          if (_sources.isNotEmpty) ...[
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  for (final source in [null, ..._sources])
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ChoiceChip(
                        label: Text(source ?? 'All'),
                        selected: _sourceFilter == source,
                        onSelected: (_) => setState(() => _sourceFilter = source),
                        visualDensity: VisualDensity.compact,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 10),
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
                padding: const EdgeInsets.only(bottom: 8),
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

    return Container(
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            color: c.brand50,
            child: Text(
              answer.verdict,
              style: TextStyle(fontSize: 13.8, fontWeight: FontWeight.w700, color: c.brandDark, height: 1.4),
            ),
          ),
          for (final match in answer.matches) _MatchRow(match: match, onUsed: () => onUsed(match)),
          if (answer.floatAlternative != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(border: Border(top: BorderSide(color: c.line))),
              child: Row(
                children: [
                  Icon(Icons.account_balance_wallet_outlined, size: 15, color: c.muted),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      'Longest to pay: ${answer.floatAlternative!.name}, '
                      '${answer.floatAlternative!.floatDays} days'
                      '${answer.matches.isNotEmpty ? ' — but no offer here.' : '.'}',
                      style: TextStyle(fontSize: 12.3, height: 1.45, color: c.muted),
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
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: match.isCoupon ? c.paper : c.surface,
        border: Border(top: BorderSide(color: c.line)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: match.title,
                        style: TextStyle(fontSize: 13.8, fontWeight: FontWeight.w700, color: c.ink),
                      ),
                      if (match.card != null)
                        TextSpan(
                          text: '  on ${match.card!.name}',
                          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.muted),
                        ),
                      if (match.reach == 'ANYWHERE')
                        TextSpan(
                          text: '  everywhere',
                          style: TextStyle(fontSize: 11, color: c.mutedLight),
                        ),
                    ],
                  ),
                ),
              ),
              if (match.isCoupon)
                TextButton(onPressed: onUsed, child: const Text('Used it')),
            ],
          ),
          if (detail.isNotEmpty) ...[
            const SizedBox(height: 3),
            Text(
              '${detail.join(' · ')}.',
              style: TextStyle(fontSize: 12.3, height: 1.45, color: c.ink70),
            ),
          ],
          if (match.code != null) ...[
            const SizedBox(height: 8),
            // Tappable because the next thing after reading a code is
            // typing it somewhere else.
            InkWell(
              onTap: () {
                Clipboard.setData(ClipboardData(text: match.code!));
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('Copied ${match.code}')),
                );
              },
              borderRadius: BorderRadius.circular(T.rSm),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                decoration: BoxDecoration(color: c.track, borderRadius: BorderRadius.circular(T.rSm)),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      match.code!,
                      style: kNum.copyWith(fontSize: 13, fontWeight: FontWeight.w700, color: c.ink),
                    ),
                    const SizedBox(width: 7),
                    Icon(Icons.copy, size: 13, color: c.muted),
                  ],
                ),
              ),
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
  Widget _extras(SpendColors c) {
    final perk = widget.perk;
    final source = perk.source?.trim() ?? '';
    final terms = perk.terms?.trim() ?? '';
    final text = perk.extractedText?.trim() ?? '';
    if (source.isEmpty && terms.isEmpty && text.isEmpty) return const SizedBox.shrink();

    Widget toggle(_Fold fold, String label) => InkWell(
          onTap: () => _toggle(fold),
          borderRadius: BorderRadius.circular(100),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(label, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: c.brand)),
                Icon(_open == fold ? Icons.expand_less : Icons.expand_more, size: 15, color: c.brand),
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
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 4,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (source.isNotEmpty)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(color: c.track, borderRadius: BorderRadius.circular(100)),
                  child: Text('from $source', style: TextStyle(fontSize: 11, color: c.ink70)),
                ),
              if (terms.isNotEmpty) toggle(_Fold.terms, 'T&C'),
              if (text.isNotEmpty) toggle(_Fold.text, 'Text read from the screenshot'),
            ],
          ),
          if (body.isNotEmpty) ...[
            const SizedBox(height: 6),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: c.paper, borderRadius: BorderRadius.circular(T.rSm)),
              // Selectable so a code or a line of small print can be copied.
              child: SelectableText(body, style: TextStyle(fontSize: 12, height: 1.5, color: c.ink70)),
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

    return Dismissible(
      key: ValueKey(perk.id),
      direction: DismissDirection.endToStart,
      onDismissed: (_) => onRemove(),
      background: Container(
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 16),
        decoration: BoxDecoration(color: c.debit50, borderRadius: BorderRadius.circular(T.rMd)),
        child: Icon(Icons.delete_outline, size: 18, color: c.debit),
      ),
      child: Opacity(
        opacity: perk.isLive ? 1 : 0.5,
        child: InkWell(
          onTap: onEdit,
          borderRadius: BorderRadius.circular(T.rMd),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
            decoration: BoxDecoration(
              color: c.surface,
              borderRadius: BorderRadius.circular(T.rMd),
              // A thicker edge down the left on one a machine wrote, so it
              // is visible without reading the line under it.
              border: Border(
                top: BorderSide(color: c.line),
                right: BorderSide(color: c.line),
                bottom: BorderSide(color: c.line),
                left: BorderSide(
                  color: perk.needsReview ? c.brand : c.line,
                  width: perk.needsReview ? 3 : 1,
                ),
              ),
            ),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: perk.isCoupon ? c.credit50 : c.brand50,
                    borderRadius: BorderRadius.circular(100),
                  ),
                  child: Text(
                    perk.isCoupon ? 'COUPON' : 'OFFER',
                    style: TextStyle(
                      fontSize: 8.5,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.4,
                      color: perk.isCoupon ? c.credit : c.brandDark,
                    ),
                  ),
                ),
                const SizedBox(width: 11),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              perk.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: c.ink),
                            ),
                          ),
                          if (perk.worth.isNotEmpty) ...[
                            const SizedBox(width: 7),
                            Text(
                              perk.worth,
                              style: kNum.copyWith(fontSize: 12.3, color: c.brand),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        sub.join(' · '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11.8, color: c.muted),
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
      ),
    );
  }
}
