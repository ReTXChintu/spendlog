import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';

/// Setting the monthly budget, and sharing it out across categories.
///
/// The limits are parts of the total, never extra on top of it, so the
/// one number that matters while typing is how much of the total is still
/// unassigned. It sits at the bottom with the save button, where it stays
/// in sight however far down the list of categories you are, and saving
/// is refused for as long as the limits come to more than the total -
/// the server would refuse it too, and finding out after tapping Save is
/// worse than seeing it as you type.
///
/// A full page rather than a dialog: a total and a limit for every kind of
/// spending is a form, and a form wants the room.
class MonthlyBudgetScreen extends StatefulWidget {
  const MonthlyBudgetScreen({super.key, this.initial, this.categories});

  /// The month as it stands, when the caller already has it.
  final MonthlyBudgetStatus? initial;

  /// Every category; the ones money only comes in on are left out here.
  final List<Category>? categories;

  /// Opens the editor. True once a budget has been saved.
  static Future<bool> open(
    BuildContext context, {
    MonthlyBudgetStatus? initial,
    List<Category>? categories,
  }) async {
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => MonthlyBudgetScreen(initial: initial, categories: categories)),
    );
    return saved ?? false;
  }

  @override
  State<MonthlyBudgetScreen> createState() => _MonthlyBudgetScreenState();
}

class _LimitRow {
  _LimitRow(this.category, String text) : amount = TextEditingController(text: text);

  final Category category;
  final TextEditingController amount;
}

/// Paise as rupees to edit: "20000", or "1499.50" when there are paise.
String _rupeesText(int minor) => minor % 100 == 0 ? '${minor ~/ 100}' : (minor / 100).toStringAsFixed(2);

class _MonthlyBudgetScreenState extends State<MonthlyBudgetScreen> {
  MonthlyBudgetStatus? _status;
  List<Category> _categories = [];
  bool _failed = false;

  final _total = TextEditingController();
  final List<_LimitRow> _rows = [];

  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final initial = widget.initial;
    final categories = widget.categories;
    if (initial != null && categories != null) {
      _fill(initial, categories);
    } else {
      _load();
    }
  }

  @override
  void dispose() {
    _total.dispose();
    for (final row in _rows) {
      row.amount.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _failed = false);
    try {
      final results = await Future.wait([
        widget.initial == null ? ApiClient.instance.get('/budget/monthly') : Future.value(null),
        widget.categories == null ? ApiClient.instance.get('/categories') : Future.value(null),
      ]);
      if (!mounted) return;
      final status = widget.initial ?? MonthlyBudgetStatus.fromJson(results[0] as Map<String, dynamic>);
      final categories = widget.categories ??
          (results[1] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList();
      setState(() => _fill(status, categories));
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  void _fill(MonthlyBudgetStatus status, List<Category> categories) {
    _status = status;
    // Money coming in has nothing to limit; the server refuses those too.
    _categories = categoriesFor(categories, 'DEBIT');

    // Not set yet: start from the old daily budget's month, when there was
    // one. Offered, never saved until Save is tapped.
    final amount = status.configured ? status.budgetMinor : status.suggestedMonthlyMinor;
    _total.text = amount == null || amount <= 0 ? '' : _rupeesText(amount);

    for (final limit in status.categories) {
      final known = _categories.where((c) => c.id == limit.categoryId).firstOrNull;
      _rows.add(_LimitRow(
        known ??
            Category(
              id: limit.categoryId,
              name: limit.name,
              icon: limit.icon,
              color: limit.color,
              direction: 'OUT',
              isSystem: false,
            ),
        _rupeesText(limit.limitMinor),
      ));
    }
  }

  int? get _totalMinor => parseRupees(_total.text);

  int get _assignedMinor => _rows.fold(0, (sum, row) => sum + (parseRupees(row.amount.text) ?? 0));

  /// An empty limit is left out on save; anything typed has to be a number.
  bool get _rowsValid =>
      _rows.every((row) => row.amount.text.trim().isEmpty || parseRupees(row.amount.text) != null);

  bool get _over {
    final total = _totalMinor;
    return total != null && _assignedMinor > total;
  }

  bool get _canSave {
    final total = _totalMinor;
    return !_saving && total != null && total > 0 && _rowsValid && !_over;
  }

  void _changed() => setState(() => _error = null);

  Future<void> _addLimit() async {
    final taken = _rows.map((row) => row.category.id).toSet();
    final free = _categories.where((c) => !taken.contains(c.id)).toList();
    if (free.isEmpty) return;

    final picked = await showModalBottomSheet<Category>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(sheetContext).size.height * 0.7),
          child: ListView(
            shrinkWrap: true,
            children: [
              for (final category in free)
                ListTile(
                  leading: Icon(categoryIcon(category.icon), color: parseHexColor(category.color)),
                  title: Text(category.name),
                  onTap: () => Navigator.of(sheetContext).pop(category),
                ),
            ],
          ),
        ),
      ),
    );
    if (picked == null || !mounted) return;
    setState(() {
      _rows.add(_LimitRow(picked, ''));
      _error = null;
    });
  }

  void _removeLimit(_LimitRow row) {
    setState(() {
      _rows.remove(row);
      _error = null;
    });
    // After the frame, so the field is gone from the tree before its
    // controller is.
    WidgetsBinding.instance.addPostFrameCallback((_) => row.amount.dispose());
  }

  Future<void> _save() async {
    final total = _totalMinor;
    if (total == null || !_canSave) return;

    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ApiClient.instance.put('/budget/monthly', {
        'amountMinor': total,
        // The whole set: a category left out has no limit any more.
        'categoryLimits': [
          for (final row in _rows)
            if (parseRupees(row.amount.text) != null)
              {'categoryId': row.category.id, 'amountMinor': parseRupees(row.amount.text)},
        ],
      });
      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      // Limits over the total come back as a sentence saying by how much;
      // shown here, by the button, rather than in a passing snackbar.
      if (mounted) {
        setState(() => _error = error is ApiException ? error.message : "Couldn't save the budget just now.");
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Text('Monthly budget', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink)),
        shape: Border(bottom: BorderSide(color: c.line)),
      ),
      body: _body(),
      bottomNavigationBar: _status == null ? null : _footer(),
    );
  }

  Widget _body() {
    if (_failed) {
      return StateBlock(
        icon: Icons.wifi_off,
        warn: true,
        title: "Couldn't load the budget",
        body: 'The connection failed. Check your internet and try again.',
        actionLabel: 'Retry',
        onAction: _load,
      );
    }
    final status = _status;
    if (status == null) return const Center(child: CircularProgressIndicator());

    final c = context.c;
    final month = status.month.label;
    final canAdd = _categories.any((category) => !_rows.any((row) => row.category.id == category.id));

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      children: [
        Text(
          'FOR THE MONTH',
          style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: c.muted),
        ),
        const SizedBox(height: 8),
        TextField(
          key: const Key('budget-total'),
          controller: _total,
          autofocus: !status.configured,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          onChanged: (_) => _changed(),
          style: kNum.copyWith(fontSize: 26, fontWeight: FontWeight.w800, color: c.ink),
          decoration: InputDecoration(
            prefixText: '₹ ',
            prefixStyle: kNum.copyWith(fontSize: 26, fontWeight: FontWeight.w800, color: c.muted),
            hintText: '20000',
            filled: true,
            fillColor: c.surface,
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(T.rMd),
              borderSide: BorderSide(color: c.lineStrong),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(T.rMd),
              borderSide: BorderSide(color: c.brand, width: 1.5),
            ),
          ),
        ),
        const SizedBox(height: 10),
        Text(
          'Everything counts against this - rent, EMIs, SIPs and the day to day. Whatever is left when the '
          'month ends goes into your savings bucket.',
          style: TextStyle(fontSize: 12.5, height: 1.5, color: c.ink70),
        ),
        const SizedBox(height: 4),
        Text(
          month.isEmpty
              ? 'Applies from this month on. Months already over keep the budget they had.'
              : 'Applies from this month ($month) on. Months already over keep the budget they had.',
          style: TextStyle(fontSize: 12, height: 1.45, color: c.muted),
        ),
        const SizedBox(height: 24),
        Row(
          children: [
            Expanded(
              child: Text(
                'CATEGORY LIMITS',
                style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: c.muted),
              ),
            ),
            if (canAdd)
              TextButton.icon(
                onPressed: _addLimit,
                icon: const Icon(Icons.add, size: 17),
                label: const Text('Add a limit'),
              ),
          ],
        ),
        Text(
          'Optional. Limits share out the total - they never add to it - and anything without a limit of its '
          'own comes out of what is left unassigned.',
          style: TextStyle(fontSize: 12, height: 1.45, color: c.muted),
        ),
        const SizedBox(height: 12),
        if (_rows.isEmpty)
          OutlinedButton.icon(
            onPressed: canAdd ? _addLimit : null,
            icon: const Icon(Icons.add, size: 17),
            label: const Text('Limit dining, groceries, transport…'),
          ),
        for (final row in _rows) _limitField(row),
      ],
    );
  }

  Widget _limitField(_LimitRow row) {
    final c = context.c;
    final colour = parseHexColor(row.category.color, fallback: c.brand);
    final invalid = row.amount.text.trim().isNotEmpty && parseRupees(row.amount.text) == null;

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(12, 6, 4, 6),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: invalid ? c.debit : c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Row(
        children: [
          Container(
            width: 28,
            height: 28,
            decoration: BoxDecoration(color: colour.withValues(alpha: .14), borderRadius: BorderRadius.circular(8)),
            child: Icon(categoryIcon(row.category.icon), size: 16, color: colour),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              row.category.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: c.ink),
            ),
          ),
          SizedBox(
            width: 116,
            child: TextField(
              key: Key('limit-${row.category.id}'),
              controller: row.amount,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              textAlign: TextAlign.right,
              onChanged: (_) => _changed(),
              style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w700, color: c.ink),
              decoration: InputDecoration(
                isDense: true,
                prefixText: '₹ ',
                hintText: '0',
                border: InputBorder.none,
                prefixStyle: kNum.copyWith(fontSize: 15, color: c.muted),
              ),
            ),
          ),
          IconButton(
            onPressed: () => _removeLimit(row),
            tooltip: 'Remove this limit',
            visualDensity: VisualDensity.compact,
            icon: Icon(Icons.close, size: 18, color: c.mutedLight),
          ),
        ],
      ),
    );
  }

  Widget _footer() {
    final c = context.c;

    return SafeArea(
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        decoration: BoxDecoration(color: c.surface, border: Border(top: BorderSide(color: c.line))),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AssignMeter(
              totalMinor: _totalMinor,
              parts: [
                for (final row in _rows)
                  (
                    colour: parseHexColor(row.category.color, fallback: c.brand),
                    amountMinor: parseRupees(row.amount.text) ?? 0,
                  ),
              ],
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: TextStyle(fontSize: 12.5, height: 1.4, color: c.debit)),
            ],
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _canSave ? _save : null,
              child: Text(_saving ? 'Saving…' : 'Save budget'),
            ),
          ],
        ),
      ),
    );
  }
}

/// How much of the total the category limits have claimed, live.
///
/// "₹X of ₹Y assigned · ₹Z unassigned", over a bar split by category
/// colour - or, once the limits come to more than the total, by how much,
/// in red, because that is the one state that cannot be saved.
class AssignMeter extends StatelessWidget {
  const AssignMeter({super.key, required this.totalMinor, required this.parts});

  final int? totalMinor;
  final List<({Color colour, int amountMinor})> parts;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final total = totalMinor;
    final assigned = parts.fold<int>(0, (sum, part) => sum + part.amountMinor);

    if (total == null || total <= 0) {
      return Text(
        'Enter the total for the month first.',
        style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: c.muted),
      );
    }

    final over = assigned > total;
    final rest = total - assigned;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          over
              ? '${formatMoneyShort(assigned)} of ${formatMoneyShort(total)} assigned · ${formatMoneyShort(-rest)} over'
              : '${formatMoneyShort(assigned)} of ${formatMoneyShort(total)} assigned · '
                  '${formatMoneyShort(rest)} unassigned',
          style: kNum.copyWith(fontSize: 12.8, fontWeight: FontWeight.w700, color: over ? c.debit : c.ink70),
        ),
        const SizedBox(height: 8),
        ClipRRect(
          borderRadius: BorderRadius.circular(100),
          child: SizedBox(
            height: 8,
            child: over
                ? ColoredBox(color: c.debit)
                : Row(
                    children: [
                      for (final part in parts)
                        if (part.amountMinor > 0)
                          Expanded(flex: part.amountMinor, child: ColoredBox(color: part.colour)),
                      if (rest > 0) Expanded(flex: rest, child: ColoredBox(color: c.track)),
                    ],
                  ),
          ),
        ),
        if (over) ...[
          const SizedBox(height: 6),
          Text(
            "Limits can't come to more than the budget. Lower a limit or raise the total.",
            style: TextStyle(fontSize: 12, height: 1.4, color: c.debit),
          ),
        ],
      ],
    );
  }
}
