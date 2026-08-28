import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/transaction_tile.dart';

class TransactionsScreen extends StatefulWidget {
  const TransactionsScreen({super.key});

  @override
  State<TransactionsScreen> createState() => _TransactionsScreenState();
}

class _TransactionsScreenState extends State<TransactionsScreen> {
  List<Transaction> _items = [];
  List<Category> _categories = [];
  int _page = 1;
  int _total = 0;
  static const _pageSize = 50;
  String _query = '';
  String? _categoryId;

  @override
  void initState() {
    super.initState();
    _loadCategories();
    _loadTransactions();
  }

  Future<void> _loadCategories() async {
    final result = await ApiClient.instance.get('/categories');
    setState(() => _categories = (result as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList());
  }

  Future<void> _loadTransactions() async {
    final params = {
      'page': '$_page',
      'pageSize': '$_pageSize',
      if (_query.isNotEmpty) 'q': _query,
      if (_categoryId != null) 'categoryId': _categoryId!,
    };
    final query = Uri(queryParameters: params).query;
    final result = await ApiClient.instance.get('/transactions?$query') as Map<String, dynamic>;
    setState(() {
      _items = (result['items'] as List<dynamic>).map((t) => Transaction.fromJson(t as Map<String, dynamic>)).toList();
      _total = result['total'] as int;
    });
  }

  void _handleUpdated(Transaction updated) {
    setState(() => _items = _items.map((t) => t.id == updated.id ? updated : t).toList());
  }

  @override
  Widget build(BuildContext context) {
    final totalPages = (_total / _pageSize).ceil().clamp(1, 999999);

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  decoration: const InputDecoration(hintText: 'Search merchant or note…', isDense: true),
                  onSubmitted: (value) {
                    _query = value;
                    _page = 1;
                    _loadTransactions();
                  },
                ),
              ),
              const SizedBox(width: 8),
              DropdownButton<String?>(
                value: _categoryId,
                hint: const Text('All'),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('All categories')),
                  ..._categories.map((c) => DropdownMenuItem<String?>(value: c.id, child: Text(c.name))),
                ],
                onChanged: (value) {
                  setState(() => _categoryId = value);
                  _page = 1;
                  _loadTransactions();
                },
              ),
            ],
          ),
        ),
        Expanded(
          child: _items.isEmpty
              ? const Center(child: Text('No transactions match these filters.'))
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  itemCount: _items.length,
                  itemBuilder: (context, i) =>
                      TransactionTile(transaction: _items[i], categories: _categories, onUpdated: _handleUpdated),
                ),
        ),
        Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              IconButton(
                icon: const Icon(Icons.chevron_left),
                onPressed: _page > 1
                    ? () {
                        setState(() => _page -= 1);
                        _loadTransactions();
                      }
                    : null,
              ),
              Text('Page $_page of $totalPages'),
              IconButton(
                icon: const Icon(Icons.chevron_right),
                onPressed: _page < totalPages
                    ? () {
                        setState(() => _page += 1);
                        _loadTransactions();
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
