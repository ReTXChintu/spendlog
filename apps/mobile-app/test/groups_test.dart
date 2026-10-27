import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/models/models.dart';
import 'package:spendlog/screens/group_add_payments_screen.dart';
import 'package:spendlog/screens/group_detail_screen.dart';
import 'package:spendlog/screens/group_members_screen.dart';
import 'package:spendlog/screens/group_openings_screen.dart';
import 'package:spendlog/screens/group_other_payment_screen.dart';
import 'package:spendlog/screens/group_payments_screen.dart';
import 'package:spendlog/screens/groups_screen.dart';
import 'package:spendlog/screens/people_screen.dart';
import 'package:spendlog/theme.dart';
import 'package:spendlog/widgets/ds/ds_icon.dart';
import 'package:spendlog/widgets/edit_transaction_sheet.dart';
import 'package:spendlog/widgets/group_picker_sheet.dart';

/// A phone: 360 × 800 logical pixels.
void _phone(WidgetTester tester, {double height = 800}) {
  tester.view.physicalSize = Size(1080, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

Map<String, dynamic> _groupJson(
  String id,
  String name, {
  bool archived = false,
  bool dated = false,
  int totalMinor = 0,
  int memberCount = 3,
  Map<String, dynamic>? source,
}) =>
    {
      'id': id,
      'name': name,
      'ownerId': 'me',
      'startedAt': dated ? '2026-08-01T00:00:00.000Z' : null,
      'endedAt': dated ? '2026-08-06T18:00:00.000Z' : null,
      'archivedAt': archived ? '2026-09-01T00:00:00.000Z' : null,
      'isActive': !archived,
      'isArchived': archived,
      'isRunning': false,
      'autoAdds': source != null,
      'joinCode': 'GOA123',
      'source': source,
      'members': [
        {'userId': 'me', 'joinedAt': '2026-08-01T00:00:00.000Z'},
      ],
      'contactMembers': [],
      'memberCount': memberCount,
      'totalMinor': totalMinor,
      'transactionCount': 2,
    };

/// GET /groups/:id: the user, a friend on SpendLog, a contact of the user's
/// and a contact of the friend's.
Map<String, dynamic> _detailJson(String id, String name,
        {bool iOwn = true, List<Map<String, dynamic>> openings = const []}) =>
    {
      ..._groupJson(id, name),
      'openingBalances': openings,
      'members': [
        {'id': 'me', 'kind': 'user', 'userId': 'me', 'name': 'Biswajit', 'isOwner': iOwn, 'isMe': true},
        {'id': 'asha', 'kind': 'user', 'userId': 'asha', 'name': 'Asha', 'isOwner': !iOwn, 'isMe': false},
      ],
      'contacts': [
        {
          'id': 'rahul',
          'kind': 'contact',
          'contactId': 'rahul',
          'name': 'Rahul',
          'phone': '9876543210',
          'addedBy': 'me',
          'addedByName': 'Biswajit',
          'isMine': true,
        },
        {
          'id': 'meera',
          'kind': 'contact',
          'contactId': 'meera',
          'name': 'Meera',
          'phone': null,
          'addedBy': 'asha',
          'addedByName': 'Asha',
          'isMine': false,
        },
      ],
    };

final _goa = Group.fromJson(_groupJson('goa1', 'Goa', dated: true));

Map<String, dynamic> _candidate(String id, String merchant, int amountMinor,
        {bool travel = false, String? category, String day = '2026-09-20'}) =>
    {
      'id': id,
      'occurredAt': '${day}T10:00:00.000Z',
      'merchant': merchant,
      'amountMinor': amountMinor,
      'accountLabel': 'HDFC ••8342',
      'categoryName': category,
      'likelyTravel': travel,
    };

Map<String, dynamic> _settlementJson() => {
      'balances': [
        {'userId': 'me', 'kind': 'user', 'name': 'Biswajit', 'paidMinor': 300000, 'shareMinor': 100000, 'netMinor': 200000, 'isMe': true},
        {'userId': 'asha', 'kind': 'user', 'name': 'Asha', 'paidMinor': 0, 'shareMinor': 100000, 'netMinor': -100000, 'isMe': false},
        {'userId': 'rahul', 'kind': 'contact', 'name': 'Rahul', 'paidMinor': 0, 'shareMinor': 100000, 'netMinor': -100000, 'isMe': false},
      ],
      'transfers': [
        {'fromUserId': 'asha', 'toUserId': 'me', 'fromKind': 'user', 'toKind': 'user', 'fromName': 'Asha', 'toName': 'Biswajit', 'amountMinor': 100000},
        {'fromUserId': 'rahul', 'toUserId': 'me', 'fromKind': 'contact', 'toKind': 'user', 'fromName': 'Rahul', 'toName': 'Biswajit', 'amountMinor': 100000},
      ],
    };

Map<String, dynamic> _summaryJson(String id, String name) => {
      'group': _groupJson(id, name),
      'totalMinor': 300000,
      'transactionCount': 2,
      'dayCount': 2,
      'perDayMinor': 150000,
      'byMember': [],
      'byCategory': [],
    };

List<Map<String, dynamic>> _paymentsJson() => [
      {
        'id': 't1',
        'userId': {'id': 'me', 'name': 'Biswajit'},
        'paidByName': 'Biswajit',
        'isMine': true,
        'amountMinor': 240000,
        'type': 'DEBIT',
        'merchant': 'Hotel',
        'source': 'SMS',
        'occurredAt': '2026-09-20T10:00:00.000Z',
      },
      {
        'id': 't2',
        'userId': {'id': 'me', 'name': 'Biswajit'},
        'paidByName': 'Rahul',
        'paidBy': {'contactId': 'rahul', 'userId': null},
        'offLedger': true,
        'groupSplit': true,
        'isMine': true,
        'amountMinor': 60000,
        'type': 'DEBIT',
        'merchant': 'Dinner',
        'source': 'MANUAL',
        'occurredAt': '2026-09-21T10:00:00.000Z',
      },
    ];

/// JSON with its charset said, so a "••" in an account label survives.
http.Response _json(Object body) =>
    http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json; charset=utf-8'});

/// Everything a request asked for, in order.
class _Calls {
  final requests = <http.Request>[];
  Iterable<http.Request> to(String method, String pathEnd) =>
      requests.where((r) => r.method == method && r.url.path.endsWith(pathEnd));
}

/// Answers every group endpoint the screens and the editor ask for.
MockClient _groupServer(_Calls calls,
        {List<Map<String, dynamic>>? groups, bool iOwn = true, List<Map<String, dynamic>> openings = const []}) =>
    MockClient((request) async {
      calls.requests.add(request);
      final path = request.url.path;
      if (request.method == 'PATCH') return http.Response('{}', 200);
      if (request.method == 'PUT' && path.endsWith('/openings')) {
        return _json(_detailJson('goa1', 'Goa', iOwn: iOwn, openings: openings));
      }
      if (request.method == 'POST' && path.endsWith('/contacts') && path.contains('/groups/')) {
        return http.Response(jsonEncode(_detailJson('goa1', 'Goa')), 201);
      }
      if (request.method == 'POST' && path.endsWith('/payments')) {
        return http.Response(jsonEncode({..._paymentsJson()[1], 'id': 'new'}), 201);
      }
      if (request.method == 'POST' && path.endsWith('/groups')) {
        return http.Response(jsonEncode(_groupJson('new1', 'Flatmates 2')), 201);
      }
      if (request.method == 'POST' && path.endsWith('/transactions')) {
        return http.Response(jsonEncode({..._paymentsJson()[0], 'id': 'new', 'userId': 'me'}), 201);
      }
      if (path.endsWith('/groups/active')) {
        return _json([
          _groupJson('goa1', 'Goa', totalMinor: 1500000, memberCount: 4),
          _groupJson('flat1', 'Flatmates', totalMinor: 4200000),
        ]);
      }
      if (path.endsWith('/groups')) {
        return _json(groups ??
            [
              _groupJson('goa1', 'Goa', totalMinor: 1500000),
              _groupJson('flat1', 'Flatmates', totalMinor: 4200000),
              _groupJson('ker1', 'Kerala 2025', archived: true, dated: true, totalMinor: 99000),
            ]);
      }
      if (path.endsWith('/summary')) return _json(_summaryJson('goa1', 'Goa'));
      if (path.endsWith('/settlement')) return _json(_settlementJson());
      if (path.endsWith('/groups/goa1/transactions')) return _json(_paymentsJson());
      if (RegExp(r'/groups/[a-z0-9]+$').hasMatch(path)) {
        return _json(_detailJson(path.split('/').last, 'Goa', iOwn: iOwn, openings: openings));
      }
      if (path.endsWith('/contacts')) {
        return _json({
          'contacts': [
            {'id': 'rahul', 'name': 'Rahul', 'phone': '9876543210'},
            {'id': 'priya', 'name': 'Priya', 'phone': '9123456780'},
          ],
        });
      }
      return http.Response('[]', 200);
    });

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('the group picker in the editor', () {
    Transaction ticket({Map<String, dynamic> extra = const {}}) => Transaction.fromJson({
          'id': 't9',
          'userId': 'me',
          'amountMinor': 840000,
          'type': 'DEBIT',
          'merchant': 'IRCTC',
          'source': 'SMS',
          'occurredAt': '2026-09-20T10:00:00.000Z',
          ...extra,
        });

    Future<void> open(WidgetTester tester, {Transaction? transaction, bool isNew = false}) async {
      // Wider than a phone, as the other sheet tests open it: the test
      // font's square glyphs overrun the sheet's button row at 360.
      tester.view.physicalSize = const Size(1440, 2600);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(Brightness.light),
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showEditTransactionSheet(
                context,
                transaction: isNew ? null : (transaction ?? ticket()),
                categories: const [],
                accounts: const [],
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
    }

    Future<void> pick(WidgetTester tester, String name) async {
      await tester.ensureVisible(find.text('Add to a group'));
      await tester.tap(find.text('Add to a group'));
      await tester.pumpAndSettle();
      await tester.tap(find.text(name));
      await tester.pumpAndSettle();
    }

    Future<void> save(WidgetTester tester, {String label = 'Save'}) async {
      await tester.ensureVisible(find.text(label));
      await tester.tap(find.text(label));
      await tester.pumpAndSettle();
    }

    Map<String, dynamic> patchOf(_Calls calls) =>
        jsonDecode(calls.to('PATCH', '/transactions/t9').single.body) as Map<String, dynamic>;

    testWidgets('lists every active group and sends the one picked, shared by everyone', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await tester.ensureVisible(find.text('Add to a group'));
        await tester.tap(find.text('Add to a group'));
        await tester.pumpAndSettle();

        expect(find.text('Goa'), findsOneWidget);
        expect(find.text('Flatmates'), findsOneWidget);
        expect(find.text('4 people · ₹15,000'), findsOneWidget);
        await tester.tap(find.text('Goa'));
        await tester.pumpAndSettle();

        expect(find.text('On Goa'), findsOneWidget);
        expect(find.text('Add to a group'), findsNothing);
        expect(find.text('Everyone'), findsOneWidget);
        await save(tester);
      }, () => _groupServer(calls));

      expect(calls.to('GET', '/groups/active'), hasLength(1));
      final patch = patchOf(calls);
      expect(patch['groupId'], 'goa1');
      expect(patch.containsKey('groupShareWith'), isTrue);
      expect(patch['groupShareWith'], isNull);
    });

    testWidgets('"Just mine" sends only the user', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await pick(tester, 'Goa');
        await tester.ensureVisible(find.text('Just mine'));
        await tester.tap(find.text('Just mine'));
        await tester.pumpAndSettle();
        await save(tester);
      }, () => _groupServer(calls));

      final patch = patchOf(calls);
      expect(patch['groupId'], 'goa1');
      expect(patch['groupShareWith'], ['me']);
    });

    testWidgets('"Choose who" sends the people ticked, contacts included', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await pick(tester, 'Goa');
        await tester.ensureVisible(find.text('Choose'));
        await tester.tap(find.text('Choose'));
        await tester.pumpAndSettle();
        // Everyone starts ticked; untick the two not in on it.
        await tester.ensureVisible(find.text('Asha'));
        await tester.tap(find.text('Asha'));
        await tester.tap(find.text('Meera'));
        await tester.pumpAndSettle();
        await save(tester);
      }, () => _groupServer(calls));

      final patch = patchOf(calls);
      expect((patch['groupShareWith'] as List).toSet(), {'me', 'rahul'});
    });

    testWidgets('"Custom" starts from the equal split and sends the parts typed', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await pick(tester, 'Goa');
        await tester.ensureVisible(find.text('Custom'));
        await tester.tap(find.text('Custom'));
        await tester.pumpAndSettle();

        // ₹8,400 between four: ₹2,100 each to start.
        expect(find.text('Adds up to ₹8,400.00.'), findsOneWidget);
        await tester.enterText(find.byKey(const ValueKey('group-part-me')), '400');
        await tester.pumpAndSettle();
        expect(find.textContaining('short of the payment'), findsOneWidget);
        await tester.enterText(find.byKey(const ValueKey('group-part-rahul')), '3800');
        await tester.pumpAndSettle();
        expect(find.text('Adds up to ₹8,400.00.'), findsOneWidget);
        await save(tester);
      }, () => _groupServer(calls));

      final patch = patchOf(calls);
      expect(patch.containsKey('groupShareWith'), isFalse);
      expect(
        {for (final part in patch['groupShareAmounts'] as List) part['memberId']: part['amountMinor']},
        {'me': 40000, 'asha': 210000, 'rahul': 380000, 'meera': 210000},
      );
    });

    testWidgets('"Custom" will not save parts that do not add up', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await pick(tester, 'Goa');
        await tester.ensureVisible(find.text('Custom'));
        await tester.tap(find.text('Custom'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byKey(const ValueKey('group-part-asha')), '5000');
        await tester.pumpAndSettle();
        await save(tester);
      }, () => _groupServer(calls));

      expect(calls.to('PATCH', '/transactions/t9'), isEmpty);
      expect(find.textContaining('more than the payment'), findsWidgets);
    });

    testWidgets('a payment saved with parts opens on them', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(
          tester,
          transaction: ticket(extra: {
            'groupId': 'goa1',
            'group': {'name': 'Goa'},
            'groupShareWith': ['me', 'asha'],
            'groupShareAmounts': [
              {'memberId': 'me', 'amountMinor': 100000},
              {'memberId': 'asha', 'amountMinor': 740000},
            ],
          }),
        );
        await tester.ensureVisible(find.byKey(const ValueKey('group-part-asha')));
        expect(tester.widget<TextField>(find.byKey(const ValueKey('group-part-me'))).controller!.text, '1000.00');
        expect(tester.widget<TextField>(find.byKey(const ValueKey('group-part-asha'))).controller!.text, '7400.00');
        expect(tester.widget<TextField>(find.byKey(const ValueKey('group-part-rahul'))).controller!.text, '');
      }, () => _groupServer(calls));
    });

    testWidgets('switching the pick off before saving leaves the group alone', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await pick(tester, 'Goa');
        await tester.tap(find.text('On Goa'));
        await tester.pumpAndSettle();
        expect(find.text('On Goa'), findsNothing);
        expect(find.text('Add to a group'), findsOneWidget);
        await save(tester);
      }, () => _groupServer(calls));

      final patch = patchOf(calls);
      expect(patch.containsKey('groupId'), isFalse);
      expect(patch.containsKey('groupShareWith'), isFalse);
    });

    testWidgets('a payment in a group can move to another', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester, transaction: ticket(extra: {'groupId': 'goa1', 'group': {'name': 'Goa'}}));
        expect(find.text('On Goa'), findsOneWidget);
        await tester.ensureVisible(find.text('Move to another group'));
        await tester.tap(find.text('Move to another group'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Flatmates'));
        await tester.pumpAndSettle();
        expect(find.text('On Flatmates'), findsOneWidget);
        await save(tester);
      }, () => _groupServer(calls));

      final patch = patchOf(calls);
      expect(patch['groupId'], 'flat1');
      expect(patch['groupShareWith'], isNull);
    });

    testWidgets('a new payment goes into the group as it is created', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester, isNew: true);
        await tester.enterText(find.byType(TextField).first, '1200');
        await pick(tester, 'Goa');
        await save(tester, label: 'Add');
      }, () => _groupServer(calls));

      final post = jsonDecode(calls.to('POST', '/transactions').single.body) as Map<String, dynamic>;
      expect(post['groupId'], 'goa1');
      expect(post['groupShareWith'], isNull);
    });

    testWidgets("a split the group keeps is left to the group", (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(
          tester,
          transaction: ticket(extra: {
            'groupId': 'goa1',
            'group': {'name': 'Goa'},
            'groupSplit': true,
            'split': {'myShareMinor': 420000},
            'people': [
              {'contactId': 'rahul', 'amountMinor': 420000},
            ],
          }),
        );
        // No split of its own on offer: the group's "Who was it for?" is.
        expect(find.text('Split'), findsNothing);
        expect(find.text('Lent'), findsNothing);
        expect(find.text('Everyone'), findsOneWidget);
        await save(tester);
      }, () => _groupServer(calls));

      final patch = patchOf(calls);
      expect(patch.containsKey('split'), isFalse);
      expect(patch.containsKey('people'), isFalse);
      expect(patch.containsKey('groupId'), isFalse);
    });

    testWidgets('a payment someone else made has no account and stays in its group', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(
          tester,
          transaction: ticket(extra: {
            'groupId': 'goa1',
            'group': {'name': 'Goa'},
            'groupSplit': true,
            'offLedger': true,
            'paidBy': {'contactId': 'rahul', 'userId': null},
            'paidByContact': {'id': 'rahul', 'name': 'Rahul'},
            'split': {'myShareMinor': 210000},
            'people': [
              {'contactId': 'rahul', 'amountMinor': 210000},
            ],
          }),
        );
        expect(find.text('Paid by Rahul · not on any of your accounts'), findsOneWidget);
        expect(find.text('Account'), findsNothing);
        expect(find.text('On Goa'), findsNothing, reason: 'it cannot be taken out, only deleted');
        expect(find.text('In Goa'), findsOneWidget);
        expect(find.text('Delete'), findsOneWidget);
        await save(tester);
      }, () => _groupServer(calls));

      final patch = patchOf(calls);
      expect(patch.containsKey('accountId'), isFalse);
      expect(patch.containsKey('split'), isFalse);
      expect(patch.containsKey('people'), isFalse);
      expect(patch.containsKey('groupId'), isFalse);
      expect(patch['groupShareWith'], isNull);
    });
  });

  group('the groups list', () {
    testWidgets('shows active groups, with archived ones folded away', (tester) async {
      _phone(tester, height: 1400);
      await http.runWithClient(() async {
        await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: const GroupsScreen()));
        await tester.pumpAndSettle();

        expect(find.text('Goa'), findsOneWidget);
        expect(find.text('Flatmates'), findsOneWidget);
        expect(find.text('Archived (1)'), findsOneWidget);
        expect(find.text('Kerala 2025'), findsNothing);
        expect(find.text('New group'), findsOneWidget);
        expect(find.text('Join one'), findsOneWidget);

        await tester.tap(find.text('Archived (1)'));
        await tester.pumpAndSettle();
        expect(find.text('Kerala 2025'), findsOneWidget);
        expect(find.text('Archived'), findsOneWidget, reason: 'the badge on the archived card');
      }, () => _groupServer(_Calls()));
    });

    testWidgets('a new group is made with its contacts and opened', (tester) async {
      final calls = _Calls();
      _phone(tester, height: 1400);
      await http.runWithClient(() async {
        await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: const GroupsScreen()));
        await tester.pumpAndSettle();
        await tester.tap(find.text('New group'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField).first, 'Flatmates 2');
        await tester.tap(find.text('Add from contacts'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Priya'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Add'));
        await tester.pumpAndSettle();
        expect(find.text('Priya'), findsOneWidget);
        await tester.tap(find.text('Next'));
        await tester.pumpAndSettle();
        // Nothing owed: the optional step left as it is.
        await tester.tap(find.text('Make the group'));
        await tester.pumpAndSettle();
      }, () => _groupServer(calls));

      final post = jsonDecode(calls.to('POST', '/groups').single.body) as Map<String, dynamic>;
      expect(post['name'], 'Flatmates 2');
      expect(post['contactIds'], ['priya']);
      expect(post['startedAt'], isNull);
      expect(post['endedAt'], isNull);
      expect(post.containsKey('openingBalances'), isFalse);
      // Opened straight away.
      expect(calls.to('GET', '/groups/new1'), isNotEmpty);
    });
  });

  group('a group in detail', () {
    Future<void> openDetail(WidgetTester tester, _Calls calls, {bool iOwn = true, Brightness brightness = Brightness.light}) async {
      _phone(tester, height: 2400);
      await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: GroupDetailScreen(group: _goa)));
      await tester.pumpAndSettle();
    }

    testWidgets('shows people of both kinds, who owes whom and the payments', (tester) async {
      await http.runWithClient(() async {
        await openDetail(tester, _Calls());

        expect(find.text('Biswajit (you)'), findsOneWidget);
        expect(find.text('Asha'), findsWidgets);
        expect(find.text('Contact'), findsNWidgets(2));
        expect(find.text('Your contact · in People'), findsOneWidget);
        expect(find.text("Asha's contact"), findsOneWidget);
        expect(find.text('Rahul → Biswajit'), findsOneWidget);
        expect(find.text('Asha → Biswajit'), findsOneWidget);
        expect(find.text('Hotel'), findsOneWidget);
        expect(find.textContaining('Paid by Rahul'), findsOneWidget);
        expect(find.text('Add a payment someone else made'), findsOneWidget);
        expect(find.text('Archive'), findsOneWidget);
        // An ordinary group takes in nothing by date, so there is nothing
        // to re-scan.
        expect(find.textContaining('Re-scan'), findsNothing);
      }, () => _groupServer(_Calls()));
    });

    testWidgets('archives, for the one who started it', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await openDetail(tester, calls);
        await tester.ensureVisible(find.text('Archive'));
        await tester.tap(find.text('Archive'));
        await tester.pumpAndSettle();
      }, () => _groupServer(calls));
      expect(calls.to('POST', '/groups/goa1/archive'), hasLength(1));
    });

    testWidgets('someone who did not start it can leave, not archive', (tester) async {
      await http.runWithClient(() async {
        await openDetail(tester, _Calls(), iOwn: false);
        expect(find.text('Archive'), findsNothing);
        expect(find.text('Leave'), findsOneWidget);
      }, () => _groupServer(_Calls(), iOwn: false));
    });
  });

  group('adding a contact to a group', () {
    testWidgets('picks from contacts and adds them by id', (tester) async {
      final calls = _Calls();
      _phone(tester, height: 1600);
      await http.runWithClient(() async {
        await tester.pumpWidget(MaterialApp(
          theme: buildTheme(Brightness.light),
          home: const GroupMembersScreen(groupId: 'goa1', groupName: 'Goa'),
        ));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Add from contacts'));
        await tester.pumpAndSettle();
        // Rahul is in the group already, so only Priya is offered.
        expect(find.byType(CheckboxListTile), findsOneWidget);
        await tester.tap(find.text('Priya'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Add'));
        await tester.pumpAndSettle();
        expect(find.text('Added Priya.'), findsOneWidget);
      }, () => _groupServer(calls));

      final post = calls.to('POST', '/groups/goa1/contacts').single;
      expect(jsonDecode(post.body), {'contactId': 'priya'});
    });
  });

  group('a payment someone else made', () {
    Future<List<bool?>> open(WidgetTester tester, {Brightness brightness = Brightness.light}) async {
      _phone(tester);
      final results = <bool?>[];
      final detail = GroupDetail.fromJson(_detailJson('goa1', 'Goa'));
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(brightness),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                results.add(await Navigator.of(context).push<bool>(
                  MaterialPageRoute(builder: (_) => GroupOtherPaymentScreen(detail: detail)),
                ));
              },
              child: const Text('Go'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('Go'));
      await tester.pumpAndSettle();
      return results;
    }

    testWidgets('posts who paid, how much and who it was for', (tester) async {
      final calls = _Calls();
      late List<bool?> results;
      await http.runWithClient(() async {
        results = await open(tester);
        // Only the user's own contacts can be said to have paid.
        expect(find.widgetWithText(InkWell, 'Meera'), findsNothing);
        await tester.enterText(find.byType(TextField).at(0), '2000');
        await tester.enterText(find.byType(TextField).at(1), 'Dinner');
        await tester.pumpAndSettle();
        // Four people, ₹2,000 each way: ₹500 is the user's.
        expect(find.textContaining('Your share is ₹500.00'), findsOneWidget);
        await tester.tap(find.text('Save payment'));
        await tester.pumpAndSettle();
      }, () => _groupServer(calls));

      final body = jsonDecode(calls.to('POST', '/groups/goa1/payments').single.body) as Map<String, dynamic>;
      expect(body['paidBy'], {'contactId': 'rahul'});
      expect(body['amountMinor'], 200000);
      expect(body['merchant'], 'Dinner');
      expect(body['shareWith'], isNull);
      expect(body['occurredAt'], isA<String>());
      expect(results, [true]);
    });

    testWidgets('"Just me" makes it all the user\'s', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await tester.enterText(find.byType(TextField).at(0), '900');
        await tester.tap(find.text('Just me'));
        await tester.pumpAndSettle();
        expect(find.textContaining('Your share is ₹900.00'), findsOneWidget);
        await tester.tap(find.text('Save payment'));
        await tester.pumpAndSettle();
      }, () => _groupServer(calls));

      final body = jsonDecode(calls.to('POST', '/groups/goa1/payments').single.body) as Map<String, dynamic>;
      expect(body['shareWith'], ['me']);
    });

    testWidgets('"Custom" sends each one\'s part, and my part is what I owe', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await tester.enterText(find.byType(TextField).at(0), '1000');
        await tester.pumpAndSettle();
        await tester.tap(find.text('Custom'));
        await tester.pumpAndSettle();
        await tester.enterText(find.byKey(const ValueKey('group-part-me')), '100');
        await tester.enterText(find.byKey(const ValueKey('group-part-asha')), '400');
        await tester.pumpAndSettle();
        await tester.ensureVisible(find.text('Save payment'));
        await tester.pumpAndSettle();
        expect(find.textContaining('Your share is ₹100.00', skipOffstage: false), findsOneWidget);
        await tester.tap(find.text('Save payment'));
        await tester.pumpAndSettle();
      }, () => _groupServer(calls));

      final body = jsonDecode(calls.to('POST', '/groups/goa1/payments').single.body) as Map<String, dynamic>;
      expect(
        {for (final part in body['shareAmounts'] as List) part['memberId']: part['amountMinor']},
        {'me': 10000, 'asha': 40000, 'rahul': 25000, 'meera': 25000},
      );
    });

    test('shares come out the way the server splits them', () {
      expect(groupShareOut(10000, ['b', 'a', 'c']), {'a': 3334, 'b': 3333, 'c': 3333});
    });
  });

  group('adding earlier payments to a group', () {
    final rows = [
      _candidate('c3', 'DMart', 150000, day: '2026-10-08'),
      _candidate('c1', 'IRCTC', 240000, travel: true, day: '2026-09-20'),
      _candidate('c2', 'Taj Exotica', 600000, category: 'Travel', travel: true, day: '2026-09-12'),
      _candidate('c4', 'Amazon', 99900, day: '2026-09-01'),
    ];

    /// Answers the candidates list, filtered by any search, and the add.
    MockClient server(_Calls calls, {List<Map<String, dynamic>>? list}) => MockClient((request) async {
          calls.requests.add(request);
          if (request.url.path.endsWith('/candidates')) {
            final q = request.url.queryParameters['q']?.toLowerCase();
            final matching =
                (list ?? rows).where((r) => q == null || (r['merchant'] as String).toLowerCase().contains(q)).toList();
            return _json(matching);
          }
          if (request.url.path.endsWith('/add')) {
            final ids = (jsonDecode(request.body)['transactionIds'] as List).length;
            return _json({'added': ids, 'skipped': 0});
          }
          return http.Response('[]', 200);
        });

    /// Opens the screen from a page that keeps what it pops with.
    Future<List<int?>> open(WidgetTester tester, {Group? group}) async {
      _phone(tester);
      final results = <int?>[];
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(Brightness.light),
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                results.add(await Navigator.of(context).push<int>(
                  MaterialPageRoute(builder: (_) => GroupAddPaymentsScreen(group: group ?? _goa)),
                ));
              },
              child: const Text('Go'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('Go'));
      await tester.pumpAndSettle();
      return results;
    }

    double top(WidgetTester tester, String text) => tester.getTopLeft(find.text(text)).dy;

    testWidgets('puts what looks like travel first, then the rest', (tester) async {
      await http.runWithClient(() async {
        await open(tester);

        expect(top(tester, 'Looks like travel'), lessThan(top(tester, 'IRCTC')));
        expect(top(tester, 'IRCTC'), lessThan(top(tester, 'Taj Exotica')));
        expect(top(tester, 'Taj Exotica'), lessThan(top(tester, 'Everything else')));
        expect(top(tester, 'Everything else'), lessThan(top(tester, 'DMart')));
        expect(top(tester, 'DMart'), lessThan(top(tester, 'Amazon')));
        expect(find.text('Pick the payments to add'), findsOneWidget);
      }, () => server(_Calls()));
    });

    testWidgets('totals what is ticked on the button, and adds exactly those', (tester) async {
      final calls = _Calls();
      late List<int?> results;
      await http.runWithClient(() async {
        results = await open(tester);

        await tester.tap(find.text('IRCTC'));
        await tester.pumpAndSettle();
        expect(find.text('Add 1 payment (₹2,400.00)'), findsOneWidget);

        await tester.tap(find.text('Taj Exotica'));
        await tester.tap(find.text('DMart'));
        await tester.pumpAndSettle();
        expect(find.text('Add 3 payments (₹9,900.00)'), findsOneWidget);

        // Unticking takes it back out of the total.
        await tester.tap(find.text('DMart'));
        await tester.pumpAndSettle();
        expect(find.text('Add 2 payments (₹8,400.00)'), findsOneWidget);

        await tester.tap(find.text('Add 2 payments (₹8,400.00)'));
        await tester.pumpAndSettle();
      }, () => server(calls));

      final add = calls.to('POST', '/groups/goa1/add').single;
      expect(jsonDecode(add.body), {
        'transactionIds': ['c1', 'c2'],
      });
      expect(results, [2], reason: 'pops with how many went on, for the snackbar');
    });

    testWidgets('searches, and keeps what was ticked before the search', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await tester.tap(find.text('DMart'));
        await tester.pumpAndSettle();

        await tester.enterText(find.byType(TextField), 'irc');
        await tester.pump(const Duration(milliseconds: 400));
        await tester.pumpAndSettle();

        expect(find.text('IRCTC'), findsOneWidget);
        expect(find.text('DMart'), findsNothing);
        expect(find.text('Amazon'), findsNothing);

        await tester.tap(find.text('IRCTC'));
        await tester.pumpAndSettle();
        expect(find.text('Add 2 payments (₹3,900.00)'), findsOneWidget);
      }, () => server(calls));

      expect(calls.to('GET', '/candidates').last.url.queryParameters['q'], 'irc');
    });

    testWidgets('goes back further, 60 then 180 then 365 days', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await open(tester);
        await tester.tap(find.text('Go back further'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Go back further'));
        await tester.pumpAndSettle();
        // A year is as far as it goes.
        expect(find.text('Go back further'), findsNothing);
      }, () => server(calls));

      expect(
        calls.to('GET', '/candidates').map((r) => r.url.queryParameters['days']).toList(),
        ['60', '180', '365'],
      );
    });

    testWidgets('works for a group with no dates', (tester) async {
      await http.runWithClient(() async {
        await open(tester, group: Group.fromJson(_groupJson('flat1', 'Flatmates')));
        expect(find.textContaining('in no group yet'), findsOneWidget);
      }, () => server(_Calls()));
    });

    testWidgets('says so when there is nothing to add', (tester) async {
      await http.runWithClient(() async {
        await open(tester);
        expect(find.text('Nothing to add'), findsOneWidget);
      }, () => server(_Calls(), list: const []));
    });

    test('the snackbar names the group and the count', () {
      expect(addedToGroupMessage(3, 'Goa'), 'Added 3 payments to Goa');
      expect(addedToGroupMessage(1, 'Goa'), 'Added 1 payment to Goa');
    });
  });

  group('starting balances', () {
    /// Through "New group" to "Anything already owed?", with Rahul and Priya in it.
    Future<void> toOwedStep(WidgetTester tester, {Brightness brightness = Brightness.light, double height = 1400}) async {
      _phone(tester, height: height);
      await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: const GroupsScreen()));
      await tester.pumpAndSettle();
      await tester.tap(find.text('New group'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, 'Flatmates');
      await tester.tap(find.text('Add from contacts'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Rahul'));
      await tester.tap(find.text('Priya'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Add 2'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Next'));
      await tester.pumpAndSettle();
    }

    testWidgets('"New group" asks what was already owed, and posts it with the group', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await toOwedStep(tester);
        expect(find.text('Anything already owed?'), findsOneWidget);
        expect(find.text('Owes me'), findsNWidgets(2));

        await tester.enterText(find.byKey(const ValueKey('opening-amount-rahul')), '1200');
        await tester.enterText(find.byKey(const ValueKey('opening-amount-priya')), '450.50');
        await tester.tap(find.descendant(
          of: find.byKey(const ValueKey('opening-direction-priya')),
          matching: find.text('I owe'),
        ));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Make the group'));
        await tester.pumpAndSettle();
      }, () => _groupServer(calls));

      final post = jsonDecode(calls.to('POST', '/groups').single.body) as Map<String, dynamic>;
      expect(post['contactIds'], unorderedEquals(['rahul', 'priya']));
      expect(post['openingBalances'], unorderedEquals([
        {'memberKind': 'contact', 'contactId': 'rahul', 'direction': 'owes_me', 'amountMinor': 120000},
        {'memberKind': 'contact', 'contactId': 'priya', 'direction': 'i_owe', 'amountMinor': 45050},
      ]));
    });

    testWidgets('"Skip" makes the group with nothing owed, whatever was typed', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        await toOwedStep(tester);
        await tester.enterText(find.byKey(const ValueKey('opening-amount-rahul')), '1200');
        await tester.tap(find.text('Skip - nothing owed'));
        await tester.pumpAndSettle();
      }, () => _groupServer(calls));

      final post = jsonDecode(calls.to('POST', '/groups').single.body) as Map<String, dynamic>;
      expect(post.containsKey('openingBalances'), isFalse);
      expect(post['contactIds'], hasLength(2));
    });

    final openings = [
      {
        'id': 'o1',
        'memberKind': 'contact',
        'memberId': 'rahul',
        'memberName': 'Rahul',
        'contactId': 'rahul',
        'direction': 'owes_me',
        'amountMinor': 120000,
        'setBy': 'me',
        'setByName': 'Biswajit',
        'isMine': true,
        'fromId': 'rahul',
        'fromName': 'Rahul',
        'toId': 'me',
        'toName': 'Biswajit',
        'viewerDirection': 'owes_me',
      },
      {
        'id': 'o2',
        'memberKind': 'user',
        'memberId': 'me',
        'memberName': 'Biswajit',
        'userId': 'me',
        'direction': 'owes_me',
        'amountMinor': 30000,
        'setBy': 'asha',
        'setByName': 'Asha',
        'isMine': false,
        'fromId': 'me',
        'fromName': 'Biswajit',
        'toId': 'asha',
        'toName': 'Asha',
        'viewerDirection': 'i_owe',
      },
    ];

    testWidgets('the group shows them from my side, and its editor saves mine', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        _phone(tester, height: 2600);
        await tester.pumpWidget(MaterialApp(theme: buildTheme(Brightness.light), home: GroupDetailScreen(group: _goa)));
        await tester.pumpAndSettle();

        expect(find.text('Starting balances'), findsOneWidget);
        expect(find.text('Rahul owes you ₹1,200'), findsOneWidget);
        expect(find.text('You owe Asha ₹300'), findsOneWidget, reason: 'the mirror of the one Asha set');
        expect(find.textContaining('Set by Asha'), findsOneWidget);

        await tester.ensureVisible(find.widgetWithText(TextButton, 'Edit'));
        await tester.tap(find.widgetWithText(TextButton, 'Edit'));
        await tester.pumpAndSettle();
        expect(find.byType(GroupOpeningsScreen), findsOneWidget);
        // Asha set what is between us; it is hers to change.
        expect(find.byKey(const ValueKey('opening-amount-asha')), findsNothing);
        expect(find.textContaining('Asha already set this'), findsOneWidget);
        expect(find.text('1200'), findsOneWidget, reason: 'Rahul, as it stands');

        await tester.tap(find.descendant(
          of: find.byKey(const ValueKey('opening-direction-rahul')),
          matching: find.text('I owe'),
        ));
        await tester.enterText(find.byKey(const ValueKey('opening-amount-rahul')), '1500');
        await tester.pumpAndSettle();
        await tester.tap(find.text('Save starting balances'));
        await tester.pumpAndSettle();
      }, () => _groupServer(calls, openings: openings));

      final put = jsonDecode(calls.to('PUT', '/groups/goa1/openings').single.body) as Map<String, dynamic>;
      expect(put['openingBalances'], [
        {'memberKind': 'contact', 'contactId': 'rahul', 'direction': 'i_owe', 'amountMinor': 150000},
      ]);
      // Back on the group, loaded again.
      expect(find.byType(GroupDetailScreen), findsOneWidget);
    });

    testWidgets('clearing an amount takes that one away', (tester) async {
      final calls = _Calls();
      await http.runWithClient(() async {
        _phone(tester, height: 1400);
        await tester.pumpWidget(MaterialApp(
          theme: buildTheme(Brightness.light),
          home: GroupOpeningsScreen(detail: GroupDetail.fromJson(_detailJson('goa1', 'Goa', openings: openings))),
        ));
        await tester.pumpAndSettle();
        await tester.enterText(find.byKey(const ValueKey('opening-amount-rahul')), '');
        await tester.tap(find.text('Save starting balances'));
        await tester.pumpAndSettle();
      }, () => _groupServer(calls, openings: openings));

      final put = jsonDecode(calls.to('PUT', '/groups/goa1/openings').single.body) as Map<String, dynamic>;
      expect(put['openingBalances'], isEmpty);
    });

    testWidgets('the People page shows a group opening as its own row', (tester) async {
      _phone(tester, height: 1400);
      await http.runWithClient(() async {
        await tester.pumpWidget(MaterialApp(
          theme: buildTheme(Brightness.light),
          home: PersonScreen(contact: Contact(id: 'rahul', name: 'Rahul', balanceMinor: 120000)),
        ));
        await tester.pumpAndSettle();
      }, () => MockClient((request) async => _json({
            'id': 'rahul',
            'name': 'Rahul',
            'balanceMinor': 120000,
            'openingBalanceMinor': 0,
            'groupOpeningMinor': 120000,
            'history': [],
            'clearances': [],
            'groupOpenings': [
              {
                'id': 'o1',
                'groupId': 'flat1',
                'groupName': 'Flatmates',
                'direction': 'owes_me',
                'amountMinor': 120000,
                'effectMinor': 120000,
                'setAt': '2026-10-01T10:00:00.000Z',
              },
            ],
          })));

      expect(find.text('Opening balance in Flatmates'), findsOneWidget);
      expect(find.textContaining('Rahul owes you ₹1,200'), findsOneWidget);
      expect(find.text('+₹1,200.00'), findsOneWidget);
      expect(find.text('Starting balance'), findsNothing, reason: 'not the contact own opening balance');
    });

    for (final brightness in Brightness.values) {
      testWidgets('"Anything already owed?" fits at 360 (${brightness.name})', (tester) async {
        await http.runWithClient(() async {
          await toOwedStep(tester, brightness: brightness, height: 800);
          await tester.enterText(find.byKey(const ValueKey('opening-amount-rahul')), '123456789');
          await tester.pumpAndSettle();
        }, () => _groupServer(_Calls()));
        expect(tester.takeException(), isNull);
        expect(find.text('Anything already owed?'), findsOneWidget);
      });

      testWidgets('the starting balances editor fits at 360 (${brightness.name})', (tester) async {
        _phone(tester);
        final detail = _detailJson('goa1', 'Spiti Valley, Chandratal and the long way back', openings: openings);
        (detail['contacts'] as List).add({
          'id': 'long',
          'kind': 'contact',
          'contactId': 'long',
          'name': 'Venkatanarasimharajuvaripeta Subrahmanyam',
          'addedBy': 'me',
          'isMine': true,
        });
        await http.runWithClient(() async {
          await tester.pumpWidget(MaterialApp(
            theme: buildTheme(brightness),
            home: GroupOpeningsScreen(detail: GroupDetail.fromJson(detail)),
          ));
          await tester.pumpAndSettle();
          await tester.enterText(find.byKey(const ValueKey('opening-amount-long')), '99999999');
          await tester.pumpAndSettle();
        }, () => _groupServer(_Calls()));
        expect(tester.takeException(), isNull);
        expect(find.text('Save starting balances'), findsOneWidget);
      });

      testWidgets('the group detail with starting balances fits at 360 (${brightness.name})', (tester) async {
        _phone(tester, height: 3200);
        await http.runWithClient(() async {
          await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: GroupDetailScreen(group: _goa)));
          await tester.pumpAndSettle();
        }, () => _groupServer(_Calls(), openings: openings));
        expect(tester.takeException(), isNull);
        expect(find.text('Starting balances'), findsOneWidget);
      });
    }
  });

  group('at 360 px', () {
    const longName = 'Spiti Valley, Chandratal and the long way back through Manali';

    MockClient server() => MockClient((request) async {
          final path = request.url.path;
          if (path.endsWith('/candidates')) {
            return _json([
              _candidate('c1', 'MAKEMYTRIP INDIA PRIVATE LIMITED GURGAON HARYANA', 12345678,
                  travel: true, category: 'Travel & Transport'),
              _candidate('c2', 'Some very long merchant name for a grocery store nearby', 99999999),
            ]);
          }
          if (path.endsWith('/summary')) {
            return _json({..._summaryJson('goa1', longName), 'totalMinor': 12345678});
          }
          if (path.endsWith('/settlement')) {
            return _json({
              'balances': [
                {'userId': 'me', 'kind': 'user', 'name': 'Biswajit', 'paidMinor': 12345678, 'shareMinor': 4115226, 'netMinor': 8230452, 'isMe': true},
              ],
              'transfers': [
                {
                  'fromName': 'Asha Raghunathan Venkataraman',
                  'toName': 'Biswajit Panda of the very long surname',
                  'amountMinor': 4115226,
                },
              ],
            });
          }
          if (path.endsWith('/transactions')) {
            return _json([
              {
                'id': 't1',
                'userId': {'id': 'me', 'name': 'Me'},
                'isMine': true,
                'amountMinor': 12345678,
                'type': 'DEBIT',
                'merchant': 'MAKEMYTRIP INDIA PRIVATE LIMITED GURGAON HARYANA',
                'source': 'SMS',
                'occurredAt': '2026-09-20T10:00:00.000Z',
              },
              {
                'id': 't2',
                'userId': {'id': 'asha', 'name': 'Asha Raghunathan Venkataraman'},
                'paidByName': 'Asha Raghunathan Venkataraman',
                'isMine': false,
                'amountMinor': 450000,
                'type': 'DEBIT',
                'merchant': 'Beach shack',
                'source': 'SMS',
                'occurredAt': '2026-10-11T10:00:00.000Z',
              },
            ]);
          }
          if (path.endsWith('/groups')) {
            return _json([
              _groupJson('goa1', longName, dated: true, totalMinor: 1234567,
                  source: {'app': 'trippin', 'externalId': 'x', 'url': 'https://trippin.example/x', 'linked': true}),
              _groupJson('ker1', 'Kerala', archived: true, totalMinor: 99999999),
            ]);
          }
          if (RegExp(r'/groups/[a-z0-9]+$').hasMatch(path)) {
            final detail = _detailJson('goa1', longName);
            (detail['contacts'] as List).add({
              'id': 'long',
              'kind': 'contact',
              'contactId': 'long',
              'name': 'Venkatanarasimharajuvaripeta Subrahmanyam',
              'addedBy': 'asha',
              'addedByName': 'Asha Raghunathan Venkataraman',
              'isMine': false,
            });
            return _json(detail);
          }
          return http.Response('[]', 200);
        });

    for (final brightness in Brightness.values) {
      testWidgets('the candidates fit, with some ticked (${brightness.name})', (tester) async {
        _phone(tester);
        await http.runWithClient(() async {
          await tester.pumpWidget(MaterialApp(
            theme: buildTheme(brightness),
            home: GroupAddPaymentsScreen(group: Group.fromJson(_groupJson('goa1', longName, dated: true))),
          ));
          await tester.pumpAndSettle();
          await tester.tap(find.textContaining('MAKEMYTRIP'));
          await tester.tap(find.textContaining('Some very long'));
          await tester.pumpAndSettle();
        }, server);

        expect(tester.takeException(), isNull);
        expect(find.textContaining('Add 2 payments'), findsOneWidget);
      });

      testWidgets('the groups list fits, archived open (${brightness.name})', (tester) async {
        _phone(tester, height: 1600);
        await http.runWithClient(() async {
          await tester.pumpWidget(MaterialApp(theme: buildTheme(brightness), home: const GroupsScreen()));
          await tester.pumpAndSettle();
          await tester.tap(find.text('Archived (1)'));
          await tester.pumpAndSettle();
        }, server);

        expect(tester.takeException(), isNull);
        expect(find.text('Planned in Trippin'), findsOneWidget);
        expect(find.text('Kerala'), findsOneWidget);
      });

      testWidgets('the group detail fits (${brightness.name})', (tester) async {
        _phone(tester, height: 3200);
        await http.runWithClient(() async {
          await tester.pumpWidget(MaterialApp(
            theme: buildTheme(brightness),
            home: GroupDetailScreen(group: Group.fromJson(_groupJson('goa1', longName))),
          ));
          await tester.pumpAndSettle();
        }, server);

        expect(tester.takeException(), isNull);
        expect(find.text('Add a payment someone else made'), findsOneWidget);
        expect(find.text('Who owes whom'), findsOneWidget);
      });

      testWidgets('the members screen fits (${brightness.name})', (tester) async {
        _phone(tester, height: 2400);
        await http.runWithClient(() async {
          await tester.pumpWidget(MaterialApp(
            theme: buildTheme(brightness),
            home: const GroupMembersScreen(groupId: 'goa1', groupName: longName),
          ));
          await tester.pumpAndSettle();
        }, server);

        expect(tester.takeException(), isNull);
        expect(find.text('Add from contacts'), findsOneWidget);
      });

      testWidgets('the someone-else-paid form fits (${brightness.name})', (tester) async {
        _phone(tester, height: 1400);
        await http.runWithClient(() async {
          await tester.pumpWidget(MaterialApp(
            theme: buildTheme(brightness),
            home: GroupOtherPaymentScreen(detail: GroupDetail.fromJson(_detailJson('goa1', longName))),
          ));
          await tester.pumpAndSettle();
          await tester.enterText(find.byType(TextField).at(0), '123456');
          await tester.tap(find.text('Choose'));
          await tester.pumpAndSettle();
        }, server);

        expect(tester.takeException(), isNull);
        expect(find.text('Save payment'), findsOneWidget);
      });

      testWidgets("the group's payments fit (${brightness.name})", (tester) async {
        _phone(tester);
        await http.runWithClient(() async {
          await tester.pumpWidget(MaterialApp(
            theme: buildTheme(brightness),
            home: GroupPaymentsScreen(group: Group.fromJson(_groupJson('goa1', longName))),
          ));
          await tester.pumpAndSettle();
        }, server);

        expect(tester.takeException(), isNull);
        expect(find.textContaining('Paid by Asha'), findsOneWidget);
        // Only the user's own row opens the edit sheet.
        expect(find.byWidgetPredicate((w) => w is DsIcon && w.glyph == DsIcons.chevronRight), findsOneWidget);
      });
    }
  });
}
