import 'dart:async';
import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../services/api_client.dart';
import '../../widgets/ds/ds.dart';
import '../../utils/format.dart';
import '../../widgets/funds/fund_form.dart';
import '../../widgets/funds/fund_text.dart';
import '../../widgets/funds/fund_widgets.dart';

/// Add a fund: find the scheme, then say what's in it - units already held,
/// a SIP, both, or neither (to link the SIP's bank debits instead).
///
/// Pops `true` once the fund is added.
class AddFundScreen extends StatefulWidget {
  const AddFundScreen({super.key, this.initialScheme});

  /// Straight to the form for this scheme - an example fund on a goal, or
  /// one the advice named.
  final SchemeResult? initialScheme;

  static Future<bool> open(BuildContext context, {SchemeResult? scheme}) async {
    final added = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => AddFundScreen(initialScheme: scheme)),
    );
    return added == true;
  }

  @override
  State<AddFundScreen> createState() => _AddFundScreenState();
}

class _AddFundScreenState extends State<AddFundScreen> {
  late SchemeResult? _scheme = widget.initialScheme;

  final _query = TextEditingController();
  Timer? _debounce;
  List<SchemeResult>? _results;
  bool _searching = false;
  bool _fromCache = false;
  String? _searchError;

  /// Which search the results are for, so a slow answer to an old one
  /// can't replace a newer one.
  int _searchSerial = 0;

  final _fields = FundFormFields();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _debounce?.cancel();
    _query.dispose();
    _fields.dispose();
    super.dispose();
  }

  void _onQuery(String text) {
    _debounce?.cancel();
    final q = text.trim();
    if (q.length < 2) {
      setState(() {
        _results = null;
        _searching = false;
        _searchError = null;
      });
      return;
    }
    setState(() => _searching = true);
    _debounce = Timer(const Duration(milliseconds: 350), () => _search(q));
  }

  Future<void> _search(String q) async {
    final serial = ++_searchSerial;
    try {
      final json = await ApiClient.instance.get('/funds/search?q=${Uri.encodeQueryComponent(q)}') as Map<String, dynamic>;
      if (!mounted || serial != _searchSerial) return;
      final search = SchemeSearch.fromJson(json);
      setState(() {
        _results = SchemeResult.preferred(search.results);
        _fromCache = search.fromCache;
        _searching = false;
        _searchError = null;
      });
    } catch (error) {
      if (!mounted || serial != _searchSerial) return;
      setState(() {
        _searching = false;
        _searchError = error is ApiException ? error.message : "Couldn't search right now.";
      });
    }
  }

  Future<void> _save() async {
    final scheme = _scheme;
    if (scheme == null || _saving) return;
    final check = _fields.data.check(istToday());
    if (!check.ok) {
      setState(() => _error = check.error);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    try {
      await ApiClient.instance.post('/funds/holdings', check.createBody(scheme.schemeCode));
      navigator.pop(true);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = error is ApiException ? error.message : "Couldn't add that fund. Try again.";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Text(_scheme == null ? 'Add a fund' : 'Your investment'),
      ),
      body: _scheme == null ? _searchView() : _formView(_scheme!),
    );
  }

  Widget _searchView() {
    final c = context.c;
    final results = _results;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
          child: TextField(
            controller: _query,
            autofocus: true,
            textInputAction: TextInputAction.search,
            onChanged: _onQuery,
            style: TextStyle(fontSize: 14, color: c.tx),
            decoration: InputDecoration(
              hintText: 'Fund name, e.g. Parag Parikh Flexi Cap',
              hintStyle: TextStyle(fontSize: 14, color: c.tx3),
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              prefixIcon: Padding(
                padding: const EdgeInsets.only(left: 12, right: 8),
                child: DsIcon(DsIcons.search, size: 20, color: c.tx3),
              ),
              prefixIconConstraints: const BoxConstraints(minWidth: 40, minHeight: 44),
              suffixIcon: _searching
                  ? const Padding(
                      padding: EdgeInsets.all(13),
                      child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                    )
                  : null,
            ),
          ),
        ),
        if (_fromCache && results != null)
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: FundBanner(
              icon: Icons.cloud_off_outlined,
              text: "The fund list can't be reached right now, so these are only funds SpendLog already knows.",
            ),
          ),
        Expanded(
          child: _searchError != null
              ? _hint(_searchError!, warn: true)
              : results == null
                  ? _hint('Search by fund name. Direct-Growth plans come first: no distributor commission, '
                      'and gains stay invested.')
                  : results.isEmpty
                      ? _hint('No funds match "${_query.text.trim()}". Try fewer words, or the fund house name.')
                      : ListView.separated(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                          itemCount: results.length,
                          separatorBuilder: (_, __) => const SizedBox(height: 8),
                          itemBuilder: (context, i) => _ResultRow(
                            result: results[i],
                            onTap: () => setState(() => _scheme = results[i]),
                          ),
                        ),
        ),
      ],
    );
  }

  Widget _hint(String text, {bool warn = false}) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      child: warn
          ? Align(alignment: Alignment.topCenter, child: DsCallout(tone: DsTone.warn, title: text))
          : Text(
              text,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2),
            ),
    );
  }

  Widget _formView(SchemeResult scheme) {
    final c = context.c;
    final bare = _fields.data.isBare;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        FundCard(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      shortSchemeName(scheme.schemeName),
                      style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                    const SizedBox(height: 2),
                    Text(scheme.schemeName, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: schemeTags(
                        isDirect: scheme.isDirect,
                        isRegular: scheme.isRegular,
                        isGrowth: scheme.isGrowth,
                      ),
                    ),
                  ],
                ),
              ),
              TextButton(
                onPressed: _saving ? null : () => setState(() => _scheme = null),
                child: const Text('Change'),
              ),
            ],
          ),
        ),
        if (scheme.isRegular) ...[
          const SizedBox(height: 12),
          const FundBanner(
            icon: DsIcons.transfer,
            text: 'This is a regular plan. If you are choosing now, the Direct plan of the same fund costs less '
                'every year.',
          ),
        ],
        const SizedBox(height: 16),
        ToggleSection(
          icon: DsIcons.banknote,
          title: 'I already hold units',
          subtitle: 'From a statement: units, what they cost, and as of when.',
          on: _fields.holdsUnits,
          onChanged: (on) => setState(() => _fields.holdsUnits = on),
          child: OpeningFields(fields: _fields, onChanged: () => setState(() {})),
        ),
        const SizedBox(height: kCardGap),
        ToggleSection(
          icon: DsIcons.repeat,
          title: 'I run a SIP',
          subtitle: 'An amount each month on the same day, with any changes along the way.',
          on: _fields.runsSip,
          onChanged: (on) => setState(() {
            _fields.runsSip = on;
            _fields.sipStart ??= istToday();
          }),
          child: SipFields(fields: _fields, onChanged: () => setState(() {})),
        ),
        const SizedBox(height: 16),
        DsField(
          label: 'Folio number (optional)',
          help: 'Only to tell two holdings of the same fund apart.',
          child: TextField(controller: _fields.folio),
        ),
        if (bare) ...[
          const SizedBox(height: 16),
          const FundBanner(
            icon: DsIcons.link,
            tone: TagTone.neutral,
            text: "Nothing to fill in? That's fine if SpendLog already has this fund's SIP debits: add it bare, "
                "then link them from the fund's page. It shows ₹0 until you do.",
          ),
        ],
        if (_error != null) ...[
          const SizedBox(height: 12),
          DsCallout(tone: DsTone.crit, title: _error!),
        ],
        const SizedBox(height: 20),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: _saving
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Add to portfolio'),
        ),
        if (_saving) ...[
          const SizedBox(height: 10),
          Text(
            'Fetching its NAV history. The first fund can take a few seconds while category ranks are built.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
        ],
      ],
    );
  }
}

class _ResultRow extends StatelessWidget {
  const _ResultRow({required this.result, required this.onTap});

  final SchemeResult result;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return FundCard(
      onTap: onTap,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            shortSchemeName(result.schemeName),
            style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
          ),
          const SizedBox(height: 2),
          Text(
            result.schemeName,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 4,
            children: schemeTags(isDirect: result.isDirect, isRegular: result.isRegular, isGrowth: result.isGrowth),
          ),
        ],
      ),
    );
  }
}
