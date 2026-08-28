import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import '../widgets/transaction_tile.dart';

class TodayScreen extends StatefulWidget {
  const TodayScreen({super.key});

  @override
  State<TodayScreen> createState() => _TodayScreenState();
}

class _TodayScreenState extends State<TodayScreen> {
  List<DayGroup>? _days;
  List<Category> _categories = [];
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/transactions/by-day'),
        ApiClient.instance.get('/categories'),
      ]);
      setState(() {
        _days = (results[0] as List<dynamic>).map((d) => DayGroup.fromJson(d as Map<String, dynamic>)).toList();
        _categories = (results[1] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList();
        _error = null;
      });
    } catch (e) {
      setState(() => _error = e.toString());
    }
  }

  void _handleUpdated(int dayIndex, Transaction updated) {
    setState(() {
      final day = _days![dayIndex];
      final newTransactions = day.transactions.map((t) => t.id == updated.id ? updated : t).toList();
      _days![dayIndex] = DayGroup(
        date: day.date,
        spendMinor: day.spendMinor,
        incomeMinor: day.incomeMinor,
        transactions: newTransactions,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) return Center(child: Text(_error!));
    if (_days == null) return const Center(child: CircularProgressIndicator());
    if (_days!.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('No transactions yet. Grant SMS permission or connect Gmail in Settings to start importing.',
              textAlign: TextAlign.center),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.all(12),
        itemCount: _days!.length,
        itemBuilder: (context, dayIndex) {
          final day = _days![dayIndex];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(formatDayLabel(day.date), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                    Row(
                      children: [
                        if (day.spendMinor > 0)
                          Text('-${formatMoney(day.spendMinor)}',
                              style: TextStyle(color: Colors.red.shade700, fontWeight: FontWeight.bold)),
                        if (day.incomeMinor > 0) ...[
                          const SizedBox(width: 8),
                          Text('+${formatMoney(day.incomeMinor)}',
                              style: TextStyle(color: Colors.green.shade700, fontWeight: FontWeight.bold)),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
              ...day.transactions.map(
                (t) => TransactionTile(
                  transaction: t,
                  categories: _categories,
                  onUpdated: (updated) => _handleUpdated(dayIndex, updated),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
