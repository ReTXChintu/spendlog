import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';

/// What the user holds, one or two of each kind.
const _funds = {
  'holdings': [
    {'id': 'f1', 'schemeName': 'Parag Parikh Flexi Cap', 'categoryLabel': 'Flexi cap'},
    {'id': 'f2', 'schemeName': 'HDFC Index Nifty 50', 'categoryLabel': 'Index'},
  ],
};
const _metals = [
  {'id': 'g1', 'name': 'Digital gold', 'purity': '24K', 'kind': 'DIGITAL', 'grams': 3},
  {'id': 'g2', 'name': 'Coins', 'purity': '22K', 'kind': 'COIN', 'grams': 10},
];
const _deposits = {
  'deposits': [
    {'id': 'rd1', 'name': 'Post office RD', 'kind': 'RD', 'isActive': true},
  ],
  'totalMinor': 0,
  'monthlyMinor': 0,
};
const _goals = {
  'goals': [
    {'id': 'goa', 'name': 'Goa trip', 'targetMinor': 5000000, 'targetOn': '2027-03-01', 'savedMinor': 0},
  ],
};
const _ipos = {
  'available': true,
  'open': [
    {'slug': 'acme', 'name': 'Acme', 'status': 'OPEN'},
  ],
  'upcoming': [],
  'closed': [],
};

MockClient _server(List<Map<String, dynamic>> patches, {List<Map<String, dynamic>> fundLinks = const []}) =>
    MockClient((request) async {
      final path = request.url.path;
      if (request.method == 'PATCH') {
        patches.add(jsonDecode(request.body) as Map<String, dynamic>);
        return http.Response('{}', 200);
      }
      final body = switch (path) {
        _ when path.endsWith('/funds/portfolio') => jsonEncode(_funds),
        _ when path.endsWith('/funds/links') => jsonEncode(fundLinks),
        _ when path.endsWith('/metals/holdings') => jsonEncode(_metals),
        _ when path.endsWith('/deposits') => jsonEncode(_deposits),
        _ when path.endsWith('/savings-goals') => jsonEncode(_goals),
        _ when path.endsWith('/ipos') => jsonEncode(_ipos),
        _ when path.endsWith('/contacts') => '{"contacts": []}',
        _ when path.endsWith('/subscriptions') => '{"items": [], "totals": {}}',
        _ => '[]',
      };
      return http.Response(body, 200);
    });

Transaction _payment({int amountMinor = 100000, Map<String, dynamic> extra = const {}}) => Transaction.fromJson({
      'id': 't1',
      'amountMinor': amountMinor,
      'type': 'DEBIT',
      'merchant': 'Zerodha',
      'source': 'SMS',
      'occurredAt': '2026-11-10T05:00:00.000Z',
      ...extra,
    });

Future<void> _open(WidgetTester tester, Transaction transaction) async {
  tester.view.physicalSize = const Size(1440, 3600);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: buildTheme(Brightness.light),
    home: Scaffold(
      body: Builder(
        builder: (context) => TextButton(
          onPressed: () => showEditTransactionSheet(context, transaction: transaction, categories: const [], accounts: const []),
          child: const Text('Open'),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('Open'));
  await tester.pumpAndSettle();
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<void> _type(WidgetTester tester, String key, String text) async {
  final byKey = find.byKey(ValueKey(key));
  final box = tester.widget(byKey) is TextField ? byKey : find.descendant(of: byKey, matching: find.byType(TextField));
  await tester.ensureVisible(box);
  await tester.enterText(box, text);
  await tester.pumpAndSettle();
}

Future<void> _investIn(WidgetTester tester, String kind) async {
  await _tap(tester, find.byKey(const ValueKey('investment')));
  await _tap(tester, find.byKey(ValueKey('invest-$kind')));
}

Future<void> _save(WidgetTester tester) => _tap(tester, find.text('Save'));

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('offers every kind once Investment is on, and no RD/FD or gold chips of their own', (tester) async {
    await http.runWithClient(() async {
      await _open(tester, _payment());
      expect(find.text('Into RD/FD'), findsNothing);
      expect(find.text('Bought gold'), findsNothing);
      await _tap(tester, find.byKey(const ValueKey('investment')));
      for (final label in ['Mutual fund', 'Gold', 'Deposit', 'Goals', 'IPO', 'Other']) {
        expect(find.text(label), findsOneWidget, reason: label);
      }
    }, () => _server([]));
  });

  testWidgets('splits a payment across two funds, and clears every other kind', (tester) async {
    final patches = <Map<String, dynamic>>[];
    await http.runWithClient(() async {
      await _open(tester, _payment());
      await _investIn(tester, 'fund');
      await _type(tester, 'fund-part-f1', '600');
      await _type(tester, 'fund-part-f2', '400');
      expect(find.text('All of it goes into funds.'), findsOneWidget);
      await _save(tester);
    }, () => _server(patches));

    final patch = patches.single;
    expect(patch['fundParts'], [
      {'holdingId': 'f1', 'amountMinor': 60000},
      {'holdingId': 'f2', 'amountMinor': 40000},
    ]);
    // Picked here, so nothing else it may have been stays on it.
    expect(patch['depositParts'], isEmpty);
    expect(patch['metalBuys'], isEmpty);
    expect(patch['investmentTags'], isEmpty);
  });

  testWidgets('splits gold across two holdings, grams typed for one', (tester) async {
    final patches = <Map<String, dynamic>>[];
    await http.runWithClient(() async {
      await _open(tester, _payment());
      await _investIn(tester, 'gold');
      await _type(tester, 'metal-part-g1', '700');
      await _type(tester, 'metal-part-g2', '300');
      await _type(tester, 'metal-grams-g2', '0.25');
      await _save(tester);
    }, () => _server(patches));

    expect(patches.single['metalBuys'], [
      {'holdingId': 'g1', 'amountMinor': 70000, 'grams': null},
      {'holdingId': 'g2', 'amountMinor': 30000, 'grams': 0.25},
    ]);
  });

  testWidgets('names an IPO from the calendar, with all of the payment', (tester) async {
    final patches = <Map<String, dynamic>>[];
    await http.runWithClient(() async {
      await _open(tester, _payment());
      await _investIn(tester, 'ipo');
      await _tap(tester, find.byKey(const ValueKey('ipo-name-Acme')));
      await _save(tester);
    }, () => _server(patches));

    expect(patches.single['investmentTags'], [
      {'kind': 'IPO', 'name': 'Acme', 'amountMinor': 100000},
    ]);
  });

  testWidgets('names anything else, split across two', (tester) async {
    final patches = <Map<String, dynamic>>[];
    await http.runWithClient(() async {
      await _open(tester, _payment());
      await _investIn(tester, 'other');
      await _type(tester, 'tag-name-0', 'PPF');
      await _type(tester, 'tag-amount-0', '600');
      await _tap(tester, find.byKey(const ValueKey('tag-add')));
      await _type(tester, 'tag-name-1', 'NPS');
      await _type(tester, 'tag-amount-1', '400');
      await _save(tester);
    }, () => _server(patches));

    expect(patches.single['investmentTags'], [
      {'kind': 'OTHER', 'name': 'PPF', 'amountMinor': 60000},
      {'kind': 'OTHER', 'name': 'NPS', 'amountMinor': 40000},
    ]);
  });

  testWidgets('refuses an amount with no name', (tester) async {
    final patches = <Map<String, dynamic>>[];
    await http.runWithClient(() async {
      await _open(tester, _payment());
      await _investIn(tester, 'other');
      await _save(tester);
      expect(find.text('Name what each amount went into.'), findsWidgets);
    }, () => _server(patches));
    expect(patches, isEmpty);
  });

  testWidgets('goals make it a transfer to your own account, and say so', (tester) async {
    final patches = <Map<String, dynamic>>[];
    await http.runWithClient(() async {
      await _open(tester, _payment());
      await _investIn(tester, 'goal');
      expect(find.textContaining("money put towards a goal isn't spending"), findsOneWidget);
      await _save(tester);
    }, () => _server(patches));

    final patch = patches.single;
    expect(patch['isTransfer'], isTrue);
    expect(patch['goalParts'], [
      {'goalId': 'goa', 'amountMinor': 100000},
    ]);
  });

  testWidgets('opens on the funds it bought, kept on the funds side', (tester) async {
    final patches = <Map<String, dynamic>>[];
    await http.runWithClient(() async {
      await _open(tester, _payment());
      expect(find.text('Into which fund'), findsOneWidget);
      await _save(tester);
    }, () => _server(patches, fundLinks: [
          {'holdingId': 'f1', 'amountMinor': 100000},
        ]));

    expect(patches.single['fundParts'], [
      {'holdingId': 'f1', 'amountMinor': 100000},
    ]);
  });

  testWidgets('saved without changing kind, leaves whatever else it was marked as', (tester) async {
    final patches = <Map<String, dynamic>>[];
    await http.runWithClient(() async {
      // From before: into an RD and linked to a fund as well.
      await _open(tester, _payment(extra: {
        'depositParts': [
          {'depositId': 'rd1', 'amountMinor': 100000},
        ],
      }));
      await _save(tester);
    }, () => _server(patches, fundLinks: [
          {'holdingId': 'f1', 'amountMinor': 100000},
        ]));

    final patch = patches.single;
    expect(patch['depositParts'], [
      {'depositId': 'rd1', 'amountMinor': 100000},
    ]);
    expect(patch.containsKey('fundParts'), isFalse);
    expect(patch.containsKey('metalBuys'), isFalse);
  });

  testWidgets('a gold purchase of all of it stays all of it when the amount is corrected', (tester) async {
    final patches = <Map<String, dynamic>>[];
    await http.runWithClient(() async {
      await _open(tester, _payment(amountMinor: 50000, extra: {
        'metalBuys': [
          {'holdingId': 'g1', 'grams': 0.0345, 'rateMinor': 1451177, 'gramsTyped': false, 'amountMinor': null},
        ],
      }));
      await tester.enterText(find.byType(TextField).first, '1000');
      await tester.pumpAndSettle();
      await _save(tester);
    }, () => _server(patches));

    expect((patches.single['metalBuys'] as List).single['amountMinor'], 100000);
  });

  testWidgets('turning Investment off takes it off everything', (tester) async {
    final patches = <Map<String, dynamic>>[];
    await http.runWithClient(() async {
      await _open(tester, _payment(extra: {
        'investmentTags': [
          {'kind': 'IPO', 'name': 'Acme', 'amountMinor': 100000},
        ],
      }));
      expect(find.text('Into which IPO'), findsOneWidget);
      await _tap(tester, find.byKey(const ValueKey('investment')));
      await _save(tester);
    }, () => _server(patches));

    final patch = patches.single;
    for (final key in ['investmentTags', 'depositParts', 'metalBuys', 'fundParts', 'goalParts']) {
      expect(patch[key], isEmpty, reason: key);
    }
  });
}
