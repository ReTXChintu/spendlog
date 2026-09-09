import 'dart:async';
import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../widgets/state_block.dart';
import '../widgets/transaction_tile.dart';

class TransactionsScreen extends StatefulWidget {
  /// Set when arriving from the "needs a category" nudge on Today.
  final bool startUncategorized;

  const TransactionsScreen({super.key, this.startUncategorized = false});

  @override
  State<TransactionsScreen> createState() => _TransactionsScreenState();
}

class _TransactionsScreenState extends State<TransactionsScreen> {
  static const _pageSize = 50;

  List<Transaction>? _items;
  List<Category> _categories = [];
  int _total = 0;
  int _page = 1;
  bool _error = false;

  String _query = '';
  String? _categoryId;
  String _direction = '';
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    if (widget.startUncategorized) _categoryId = 'none';
    _loadCategories();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  Future<void> _loadCategories() async {
    try {
      final result = await ApiClient.instance.get('/categories');
      if (!mounted) return;
      setState(() => _categories =
          (result as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList());
    } catch (_) {
      // The list still works without the filter chips populated.
    }
  }

  Future<void> _load() async {
    setState(() => _items = null);
    final params = <String, String>{
      'page': '$_page',
      'pageSize': '$_pageSize',
      if (_query.isNotEmpty) 'q': _query,
      if (_categoryId != null) 'categoryId': _categoryId!,
      if (_direction.isNotEmpty) 'type': _direction,
    };

    try {
      final result =
          await ApiClient.instance.get('/transactions?${Uri(queryParameters: params).query}') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _items =
            (result['items'] as List<dynamic>).map((t) => Transaction.fromJson(t as Map<String, dynamic>)).toList();
        _total = result['total'] as int;
        _error = false;
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  void _search(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      _query = value;
      _page = 1;
      _load();
    });
  }

  void _setFilter(void Function() apply) {
    setState(() {
      apply();
      _page = 1;
    });
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final totalPages = _total == 0 ? 1 : ((_total + _pageSize - 1) ~/ _pageSize);

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 10),
          child: TextField(
            onChanged: _search,
            decoration: InputDecoration(
              hintText: 'Merchant or note',
              prefixIcon: const Icon(Icons.search, size: 18, color: T.mutedLight),
              isDense: true,
              filled: true,
              fillColor: T.surface,
              contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(T.rSm),
                borderSide: const BorderSide(color: T.lineStrong),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(T.rSm),
                borderSide: const BorderSide(color: T.brand),
              ),
            ),
          ),
        ),

        SizedBox(
          height: 38,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            children: [
              _FilterChip(
                label: 'All',
                on: _categoryId == null && _direction.isEmpty,
                onTap: () => _setFilter(() {
                  _categoryId = null;
                  _direction = '';
                }),
              ),
              _FilterChip(
                label: 'Needs a category',
                on: _categoryId == 'none',
                onTap: () => _setFilter(() => _categoryId = _categoryId == 'none' ? null : 'none'),
              ),
              _FilterChip(
                label: 'Debit',
                on: _direction == 'DEBIT',
                onTap: () => _setFilter(() => _direction = _direction == 'DEBIT' ? '' : 'DEBIT'),
              ),
              _FilterChip(
                label: 'Credit',
                on: _direction == 'CREDIT',
                onTap: () => _setFilter(() => _direction = _direction == 'CREDIT' ? '' : 'CREDIT'),
              ),
              for (final category in _categories)
                _FilterChip(
                  label: category.name,
                  on: _categoryId == category.id,
                  color: parseHexColor(category.color),
                  onTap: () => _setFilter(() => _categoryId = _categoryId == category.id ? null : category.id),
                ),
            ],
          ),
        ),

        const SizedBox(height: 6),

        Expanded(
          child: _error
              ? StateBlock(
                  icon: Icons.wifi_off,
                  warn: true,
                  title: "Couldn't load your transactions",
                  body: 'The connection failed. Your data is safe — check your internet and try again.',
                  actionLabel: 'Retry',
                  onAction: _load,
                )
              : _items == null
                  ? const Center(child: CircularProgressIndicator())
                  : _items!.isEmpty
                      ? const StateBlock(
                          icon: Icons.search_off,
                          title: 'Nothing matches those filters',
                          body: 'No transaction fits this combination. Clear a filter to see more.',
                        )
                      : ListView.builder(
                          itemCount: _items!.length,
                          itemBuilder: (context, i) => TransactionTile(
                            transaction: _items![i],
                            categories: _categories,
                            onUpdated: (updated) => setState(() {
                              _items = _items!.map((t) => t.id == updated.id ? updated : t).toList();
                            }),
                          ),
                        ),
        ),

        if (_items != null && _items!.isNotEmpty && totalPages > 1)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                IconButton(
                  icon: const Icon(Icons.chevron_left),
                  onPressed: _page > 1
                      ? () {
                          setState(() => _page -= 1);
                          _load();
                        }
                      : null,
                ),
                Text('Page $_page of $totalPages',
                    style: const TextStyle(fontSize: 12.8, color: T.muted, fontWeight: FontWeight.w600)),
                IconButton(
                  icon: const Icon(Icons.chevron_right),
                  onPressed: _page < totalPages
                      ? () {
                          setState(() => _page += 1);
                          _load();
                        }
                      : null,
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _FilterChip extends StatelessWidget {
  final String label;
  final bool on;
  final Color? color;
  final VoidCallback onTap;

  const _FilterChip({required this.label, required this.on, required this.onTap, this.color});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 7),
          decoration: BoxDecoration(
            color: on ? T.brand50 : T.surface,
            border: Border.all(color: on ? T.brand : T.lineStrong),
            borderRadius: BorderRadius.circular(100),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (color != null) ...[
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2)),
                ),
                const SizedBox(width: 6),
              ],
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: on ? T.brandDark : T.ink70,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
