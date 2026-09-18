import 'dart:io' show Platform;
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../services/reminder_service.dart';
import '../services/theme_service.dart';
import '../services/sms_service.dart';
import '../services/update_service.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../version.dart';
import 'accounts_screen.dart';
import 'statements_screen.dart';
import 'login_screen.dart';
import 'permission_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 6, vsync: this);

  List<EmailConnectionStatus> _connections = [];
  bool _smsGranted = false;
  bool _syncing = false;

  /// null until a check has run; empty means "already up to date".
  String? _latestVersion;
  bool _checkingUpdate = false;

  bool _smsSyncing = false;
  DateTime? _smsLastSynced;

  bool _dailyReminder = false;
  DateTime? _nagLastRun;
  bool _nagReminder = false;
  bool _billReminder = false;

  List<MerchantPreset> _presets = [];
  List<Category> _categories = [];
  List<FixedCommitment> _commitments = [];
  List<Loan> _loans = [];
  int? _salaryMinor;
  int? _salaryDay;
  int? _dailyBudgetMinor;

  bool _readingStatements = false;
  String? _statementResult;

  String? _ledgerMonth;
  String? _ledgerPrevious;
  String? _ledgerNote;
  bool _loadingEarlier = false;

  /// Imported rows sitting before the month the ledger starts, from before
  /// the horizon existed. Anything typed in by hand is never counted here
  /// and never removed.
  int _ledgerStale = 0;
  bool _purgingLedger = false;

  @override
  void initState() {
    super.initState();
    _loadConnections();
    _loadYou();
    _loadPresets();
    _loadLedger();
    if (Platform.isAndroid) {
      _refreshSmsStatus();
      _loadReminders();
    }
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  /// Where the ledger starts, and the month a button would open up next.
  Future<void> _loadLedger() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/ledger'),
        ApiClient.instance.get('/ledger/purge'),
      ]);
      if (!mounted) return;

      final json = results[0] as Map<String, dynamic>;
      final plan = results[1] as Map<String, dynamic>;
      setState(() {
        _ledgerMonth = json['month'] as String?;
        _ledgerPrevious = (json['canGoBack'] as bool? ?? false) ? json['previous'] as String? : null;
        _ledgerStale = (plan['imported'] as int? ?? 0) + (plan['statements'] as int? ?? 0);
      });
    } catch (_) {
      // The card says it is loading and stays that way.
    }
  }

  /// Go back one more month, and fetch it.
  ///
  /// Opening a month up is only half of it: that month's alerts and
  /// statements were skipped when they first went past, so moving the
  /// start without going back for them would show an empty month.
  Future<void> _loadEarlierMonth() async {
    setState(() {
      _loadingEarlier = true;
      _ledgerNote = null;
    });

    try {
      final json = await ApiClient.instance.post('/ledger/earlier') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _ledgerNote = '${_monthLabel(json['month'] as String)} is in. '
            '${json['imported'] ?? 0} transactions and ${json['statementsRead'] ?? 0} statements '
            'came back with it.';
      });
      await _loadLedger();
    } catch (error) {
      if (mounted) {
        setState(() =>
            _ledgerNote = error is ApiException ? error.message : "That didn't work just now.");
      }
    } finally {
      if (mounted) setState(() => _loadingEarlier = false);
    }
  }

  /// Remove what was imported before the ledger starts.
  ///
  /// Named before it happens rather than after: this deletes transactions
  /// and there is no undo. Anything entered by hand is kept whatever its
  /// date - the horizon decides what SpendLog fetches, not what somebody
  /// is allowed to remember.
  Future<void> _purgeOldMonths() async {
    final month = _ledgerMonth == null ? 'the start' : _monthLabel(_ledgerMonth!);
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Clear the older months?'),
        content: Text(
          'This removes $_ledgerStale imported transactions and statements from before $month. '
          'Anything you entered by hand is kept, and nothing from an SMS or an email after that '
          'month is touched.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep them')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    if (sure != true) return;

    setState(() => _purgingLedger = true);
    try {
      final result = await ApiClient.instance
          .post('/ledger/purge', {'confirm': 'clear the old months'}) as Map<String, dynamic>;
      if (!mounted) return;
      setState(() => _ledgerNote =
          'Removed ${result['transactionsDeleted'] ?? 0} transactions and '
          '${result['statementsDeleted'] ?? 0} statements.');
      await _loadLedger();
    } catch (error) {
      if (mounted) {
        setState(() =>
            _ledgerNote = error is ApiException ? error.message : "That didn't work just now.");
      }
    } finally {
      if (mounted) setState(() => _purgingLedger = false);
    }
  }

  /// "September 2026", from a YYYY-MM key.
  String _monthLabel(String month) {
    final parts = month.split('-');
    if (parts.length != 2) return month;

    final year = int.tryParse(parts[0]);
    final index = int.tryParse(parts[1]);
    if (year == null || index == null) return month;

    return DateFormat('MMMM yyyy').format(DateTime(year, index));
  }

  Future<void> _loadPresets() async {
    try {
      final result = await ApiClient.instance.get('/merchant-presets') as List<dynamic>;
      if (!mounted) return;
      setState(() =>
          _presets = result.map((p) => MerchantPreset.fromJson(p as Map<String, dynamic>)).toList());
    } catch (_) {
      // The presets tab simply shows nothing.
    }
  }

  Future<void> _removePreset(MerchantPreset preset) async {
    await ApiClient.instance.delete('/merchant-presets/${preset.id}').catchError((_) => null);
    await _loadPresets();
  }

  /// Salary and the fixed monthly costs: facts about you rather than about
  /// money that moved, which is why they are set here and only shown on the
  /// dashboard.
  Future<void> _loadYou() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/budget/profile'),
        ApiClient.instance.get('/budget/commitments'),
        ApiClient.instance.get('/categories'),
        ApiClient.instance.get('/loans'),
      ]);
      if (!mounted) return;

      final profile = results[0] as Map<String, dynamic>;
      setState(() {
        _salaryMinor = profile['salaryAmountMinor'] as int?;
        _salaryDay = profile['salaryDay'] as int?;
        _dailyBudgetMinor = profile['dailyBudgetMinor'] as int?;
        _commitments = (results[1] as List<dynamic>)
            .map((c) => FixedCommitment.fromJson(c as Map<String, dynamic>))
            .toList();
        _categories = (results[2] as List<dynamic>)
            .map((c) => Category.fromJson(c as Map<String, dynamic>))
            .toList();
        _loans = (results[3] as List<dynamic>)
            .map((l) => Loan.fromJson(l as Map<String, dynamic>))
            .toList();
      });
    } catch (_) {
      // Nothing set yet, which the card says for itself.
    }
  }

  Future<void> _editSalary() async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => _SalaryDialog(amountMinor: _salaryMinor, day: _salaryDay),
    );
    if (saved == true) await _loadYou();
  }

  Future<void> _editDailyBudget() async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => _DailyBudgetDialog(amountMinor: _dailyBudgetMinor),
    );
    if (saved == true) await _loadYou();
  }

  Future<void> _editCommitment([FixedCommitment? commitment]) async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => _CommitmentDialog(commitment: commitment, categories: _categories),
    );
    if (saved == true) await _loadYou();
  }

  Future<void> _editLoan([Loan? loan]) async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => _LoanDialog(loan: loan),
    );
    if (saved == true) await _loadYou();
  }

  Future<void> _removeCommitment(FixedCommitment commitment) async {
    await ApiClient.instance.delete('/budget/commitments/${commitment.id}').catchError((_) => null);
    await _loadYou();
  }

  Future<void> _removeLoan(Loan loan) async {
    await ApiClient.instance.delete('/loans/${loan.id}').catchError((_) => null);
    await _loadYou();
  }

  /// Go and read any statement in the mailbox that has not been read yet.
  Future<void> _readStatements() async {
    setState(() {
      _readingStatements = true;
      _statementResult = null;
    });

    try {
      final result = await ApiClient.instance.post('/statements/sync') as Map<String, dynamic>;
      final scanned = result['scanned'] as int? ?? 0;
      final read = result['read'] as int? ?? 0;
      final locked = result['locked'] as int? ?? 0;
      final unidentified = result['unidentified'] as int? ?? 0;
      final added = result['added'] as int? ?? 0;

      if (!mounted) return;
      setState(() => _statementResult = scanned == 0
          ? 'No statements found in the mailbox.'
          : 'Read $read of $scanned. $added transactions added'
              '${locked > 0 ? ', $locked still locked' : ''}'
              '${unidentified > 0 ? ', $unidentified on an unknown card' : ''}.');
    } catch (error) {
      if (!mounted) return;
      setState(() =>
          _statementResult = error is ApiException ? error.message : "That didn't work just now.");
    } finally {
      if (mounted) setState(() => _readingStatements = false);
    }
  }

  Future<void> _loadReminders() async {
    final daily = await ReminderService.instance.dailyEnabled();
    final nag = await ReminderService.instance.nagEnabled();
    final bills = await ReminderService.instance.billsEnabled();
    final lastRun = await ReminderService.instance.followUpsLastRan();
    if (!mounted) return;
    setState(() {
      _dailyReminder = daily;
      _nagReminder = nag;
      _billReminder = bills;
      _nagLastRun = lastRun;
    });
  }

  /// Every switch goes through here so a refused permission shows on
  /// screen, rather than leaving one on that can never fire anything.
  Future<void> _setReminder(String which, bool enabled) async {
    setState(() {
      if (which == 'daily') {
        _dailyReminder = enabled;
      } else if (which == 'nag') {
        _nagReminder = enabled;
      } else {
        _billReminder = enabled;
      }
    });
    final messenger = ScaffoldMessenger.of(context);

    final armed = switch (which) {
      'daily' => await ReminderService.instance.setDailyEnabled(enabled),
      'nag' => await ReminderService.instance.setNagEnabled(enabled),
      _ => await ReminderService.instance.setBillsEnabled(enabled),
    };

    if (!mounted || armed == enabled) return;
    setState(() {
      if (which == 'daily') {
        _dailyReminder = false;
      } else if (which == 'nag') {
        _nagReminder = false;
      } else {
        _billReminder = false;
      }
    });
    messenger.showSnackBar(
      const SnackBar(content: Text('Notifications are turned off for SpendLog in Android settings.')),
    );
  }

  Future<void> _refreshSmsStatus() async {
    final granted = await SmsService.instance.hasPermission();
    final lastSynced = await SmsService.instance.lastSyncedAt();
    if (mounted) {
      setState(() {
        _smsGranted = granted;
        _smsLastSynced = lastSynced;
      });
    }
  }

  /// Re-reads recent messages by hand. The automatic capture can miss one —
  /// the phone was off, the app was killed mid-delivery, the request failed
  /// offline — and nothing else would ever go back for it.
  Future<void> _syncSms() async {
    setState(() => _smsSyncing = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await SmsService.instance.syncNow();
      await _refreshSmsStatus();
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            result.foundNothingNew
                ? 'Checked ${result.scanned} messages — nothing new.'
                : 'Imported ${result.created} '
                    '${result.created == 1 ? 'transaction' : 'transactions'} '
                    'from ${result.scanned} messages.',
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text("Couldn't sync messages: $e")));
    } finally {
      if (mounted) setState(() => _smsSyncing = false);
    }
  }

  bool get _updateAvailable => _latestVersion != null && _latestVersion!.isNotEmpty;

  Future<void> _checkForUpdate() async {
    setState(() => _checkingUpdate = true);
    // Asks for the deployed version rather than "is there an update", so an
    // unreachable server can be reported as such instead of as "up to date".
    final latest = await UpdateService.instance.latestVersion();
    if (!mounted) return;

    final newer = latest != null && UpdateService.isNewer(latest, appVersion);
    setState(() {
      // '' distinguishes "checked, nothing newer" from "not checked yet".
      _latestVersion = newer ? latest : '';
      _checkingUpdate = false;
    });

    if (newer) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          latest == null
              ? "Couldn't reach the server to check."
              : 'You are on the latest version.',
        ),
      ),
    );
  }

  /// The list of what has been read and what could not be, with the reason
  /// against each. Without it, a count of failures was all anyone had.
  Future<void> _openStatements() async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const StatementsScreen()));
  }

  Future<void> _loadConnections() async {
    try {
      final result = await ApiClient.instance.get('/ingestion/email/status') as List<dynamic>;
      if (!mounted) return;
      setState(() => _connections =
          result.map((c) => EmailConnectionStatus.fromJson(c as Map<String, dynamic>)).toList());
    } catch (_) {
      // Leave the card in its "not connected" state.
    }
  }

  Future<void> _connectGmail() async {
    final result = await ApiClient.instance.get('/ingestion/email/connect') as Map<String, dynamic>;
    await launchUrl(Uri.parse(result['url'] as String), mode: LaunchMode.externalApplication);
  }

  Future<void> _syncNow() async {
    setState(() => _syncing = true);
    try {
      await ApiClient.instance.post('/ingestion/email/sync');
      await _loadConnections();
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  Future<void> _requestSms() async {
    final granted = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => const PermissionScreen()),
    );
    if (granted == true) _refreshSmsStatus();
  }

  Future<void> _openAccounts() async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AccountsScreen()));
  }

  Future<void> _signOut() async {
    await AuthService.instance.signOut();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const LoginScreen()),
      (route) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    // Six tabs, each of which answers one question completely.
    //
    // It was five, and every one of them touched everything. Statements —
    // a card's paperwork — sat under Connections because that is where they
    // are fetched from. "You" held a salary, a set of monthly commitments
    // and a sign-out button, which is a budget and an identity in one
    // drawer.
    return Column(
      children: [
        TabBar(
          controller: _tabs,
          isScrollable: true,
          tabAlignment: TabAlignment.start,
          tabs: const [
            Tab(text: 'Connections'),
            Tab(text: 'Accounts'),
            Tab(text: 'Budget'),
            Tab(text: 'Presets'),
            Tab(text: 'You'),
            Tab(text: 'About'),
          ],
        ),
        Expanded(
          child: TabBarView(
            controller: _tabs,
            children: [
              _tab(_connectionsTab()),
              _tab(_accountsTab()),
              _tab(_budgetTab()),
              _tab(_presetsTab()),
              _tab(_youTab()),
              _tab(_aboutTab()),
            ],
          ),
        ),
      ],
    );
  }

  Widget _tab(List<Widget> children) => ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
        children: children,
      );

  /// Where the data comes from: Gmail, the statements in it, and SMS.
  List<Widget> _connectionsTab() {
    final connection = _connections.isEmpty ? null : _connections.first;

    return [
        // Where the ledger starts is a fact about what gets fetched, so it
        // belongs beside the mailbox and the phone it gets fetched from.
        _SettingsCard(
          icon: Icons.event_outlined,
          title: 'Start loading from',
          subtitle: _ledgerMonth == null ? 'Loading…' : _monthLabel(_ledgerMonth!),
          child: _CardBody(
            text: _ledgerMonth == null
                ? 'Nothing from before the month you joined is imported.'
                : 'Nothing from before ${_monthLabel(_ledgerMonth!)} is imported. Your mailbox and '
                    'your phone hold plenty from before it, and none of it was ever yours to track '
                    'here.'
                    '${_ledgerNote == null ? '' : '\n\n$_ledgerNote'}',
            actions: [
              if (_ledgerPrevious != null)
                OutlinedButton(
                  onPressed: _loadingEarlier ? null : _loadEarlierMonth,
                  child: Text(
                    _loadingEarlier
                        ? 'Fetching ${_monthLabel(_ledgerPrevious!)}…'
                        : 'Load ${_monthLabel(_ledgerPrevious!)} too',
                  ),
                ),
              // Only while there is something to clear. It is only ever
              // true on an account that imported months of history before
              // there was a horizon to stop it.
              if (_ledgerStale > 0)
                OutlinedButton(
                  onPressed: _purgingLedger ? null : _purgeOldMonths,
                  style: OutlinedButton.styleFrom(foregroundColor: context.c.debit),
                  child: Text(_purgingLedger ? 'Removing…' : 'Clear $_ledgerStale older rows'),
                ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        _SettingsCard(
          icon: Icons.mail_outline,
          title: 'Email import',
          subtitle: 'Gmail, read-only',
          child: connection == null
              ? _CardBody(
                  pill: const _StatusPill(label: 'Not connected', on: false),
                  text: 'Email access was declined when you signed in. You can grant it here instead.',
                  actions: [
                    FilledButton(onPressed: _connectGmail, child: const Text('Connect Gmail')),
                  ],
                )
              : _CardBody(
                  pill: const _StatusPill(label: 'Connected', on: true),
                  text: '${connection.email}\n${connection.lastSyncedAt != null ? 'Last synced ${connection.lastSyncedAt}' : 'Not synced yet.'}',
                  actions: [
                    OutlinedButton(
                      onPressed: _syncing ? null : _syncNow,
                      child: Text(_syncing ? 'Syncing…' : 'Sync now'),
                    ),
                  ],
                ),
        ),
        const SizedBox(height: 14),
        if (Platform.isAndroid)
          _SettingsCard(
            icon: Icons.sms_outlined,
            title: 'SMS import',
            subtitle: 'Android only',
            child: _smsGranted
                ? _CardBody(
                    pill: const _StatusPill(label: 'Granted', on: true),
                    text: 'Reading bank and UPI messages as they arrive.\n'
                        '${_smsLastSynced != null ? 'Last manual sync ${formatDateTime(_smsLastSynced!)}' : 'No manual sync yet.'}',
                    actions: [
                      OutlinedButton(
                        onPressed: _smsSyncing ? null : _syncSms,
                        child: Text(_smsSyncing ? 'Syncing…' : 'Sync now'),
                      ),
                    ],
                  )
                : _CardBody(
                    pill: const _StatusPill(label: 'Not granted', on: false),
                    text: 'Without this, SpendLog can only see what your bank emails — most Indian banks only '
                        'text. Turn it on any time.',
                    actions: [
                      FilledButton(onPressed: _requestSms, child: const Text('Grant SMS access')),
                    ],
                  ),
          )
        else
          const _SettingsCard(
            icon: Icons.sms_outlined,
            title: 'SMS import',
            subtitle: 'Android only',
            child: _CardBody(
              pill: _StatusPill(label: 'Not available here', on: false),
              text: 'Reading text messages is something only Android allows. On this device SpendLog can '
                  'still import from Gmail.',
            ),
          ),
        if (Platform.isAndroid) ...[
          const SizedBox(height: 14),
          _SettingsCard(
            icon: Icons.notifications_none,
            title: 'Reminders',
            subtitle: 'About yesterday',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SizedBox(height: 12),
                Text(
                  'An import gets the amount and the merchant. What it was for is the part only '
                  'you know, and it is easiest to remember the next morning.',
                  style: TextStyle(fontSize: 13, height: 1.5, color: context.c.ink70),
                ),
                const SizedBox(height: 6),
                _ToggleRow(
                  title: 'At midnight',
                  subtitle: 'One nudge as the day closes.',
                  value: _dailyReminder,
                  onChanged: (on) => _setReminder('daily', on),
                ),
                _ToggleRow(
                  title: 'When a card bill arrives',
                  subtitle: 'Said once, when a statement shows what the bill has come to. The '
                      'dashboard carries it after that until it is paid.',
                  value: _billReminder,
                  onChanged: (on) => _setReminder('bills', on),
                ),
                _ToggleRow(
                  title: 'Keep reminding',
                  subtitle: 'From 6am to 10pm, every half hour, while anything from yesterday is '
                      'still uncategorised. Stops as soon as none are.',
                  value: _nagReminder,
                  onChanged: (on) => _setReminder('nag', on),
                ),
                // Said out loud because it is the thing that goes wrong.
                // Android stops background work on most phones once the
                // app has been away a while, and the reminders fall back
                // to alarms that fire regardless - so this line explains a
                // "never" rather than leaving it looking broken.
                if (_nagReminder)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(2, 2, 2, 0),
                    child: Text(
                      _nagLastRun == null
                          ? 'The background check has not managed to run yet, so the reminders '
                              'come from alarms and are switched off next time you open the app.'
                          : 'Background check last ran ${formatDateTime(_nagLastRun!)}.',
                      style: TextStyle(fontSize: 11.5, height: 1.45, color: context.c.mutedLight),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ];
  }

  /// What the money moves through.
  List<Widget> _accountsTab() => [
        _SettingsCard(
          icon: Icons.account_balance_outlined,
          title: 'Accounts and cards',
          subtitle: 'Where the money moves',
          child: _CardBody(
            text: 'Name your accounts, merge the duplicates a bank creates by spelling itself two ways, '
                'and add anything that never sends a message.',
            actions: [
              OutlinedButton(onPressed: _openAccounts, child: const Text('Manage accounts')),
            ],
          ),
        ),
        const SizedBox(height: 14),
        // A card's statements are that card's paperwork, so they live with
        // it rather than under the mailbox they arrived through.
        // Read here as well as seen here. It was read from Connections,
        // beside the mailbox, and seen from this tab - one button in one
        // tab whose result appeared in another, which is the thing a tab
        // must never ask of you.
        _SettingsCard(
          icon: Icons.receipt_long_outlined,
          title: 'Statements',
          subtitle: 'Filed under each card, by month',
          child: _CardBody(
            text: 'The monthly PDF from your mailbox. An alert only arrives for what the bank chose to '
                'announce; the statement is the complete list, so reading it finds the fees, the '
                'finance charges and anything that happened while the phone was off. Open one to see '
                'each transaction on it and overrule anything SpendLog got wrong.'
                '${_statementResult != null ? '\n\n$_statementResult' : ''}',
            actions: [
              OutlinedButton(
                onPressed: _readingStatements || _connections.isEmpty ? null : _readStatements,
                child: Text(_readingStatements ? 'Reading…' : 'Read statements'),
              ),
              OutlinedButton(onPressed: _openStatements, child: const Text('Open statements')),
            ],
          ),
        ),
      ];

  /// The merchant shortcuts, so a payment entered by hand takes one tap.
  List<Widget> _presetsTab() => [
        _SettingsCard(
          icon: Icons.bolt_outlined,
          title: 'Merchant presets',
          subtitle: 'A name and the category it usually belongs to',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 12),
              Text(
                'These appear under the merchant field when you add or edit a payment. Picking one '
                'fills in both, which is most of the typing gone.',
                style: TextStyle(fontSize: 13, height: 1.5, color: context.c.ink70),
              ),
              const SizedBox(height: 14),
              if (_presets.isEmpty)
                Text(
                  'None yet. Add one from the merchant field while editing a payment.',
                  style: TextStyle(fontSize: 12.5, color: context.c.muted),
                )
              else
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final preset in _presets)
                      InputChip(
                        label: Text(
                          preset.category == null
                              ? preset.merchant
                              : '${preset.merchant} · ${preset.category!.name}',
                        ),
                        onDeleted: () => _removePreset(preset),
                      ),
                  ],
                ),
            ],
          ),
        ),
      ];

  /// Facts about you: what lands each month, and signing out.
  /// What is already spoken for each month: pay in, and the fixed payments
  /// out. Together these are what the dashboard paces a month against, and
  /// they used to sit in the same drawer as the sign-out button.
  List<Widget> _budgetTab() => [
        _SettingsCard(
          icon: Icons.account_balance_wallet_outlined,
          title: 'What lands each month',
          subtitle: _salaryMinor != null
              ? '${formatMoney(_salaryMinor!)} on the ${_salaryDay}th'
              : 'Not set',
          child: _CardBody(
            text: 'With these, the dashboard can say how much a day is left before the next one '
                'arrives. It is a pace, not a balance — SpendLog reads messages about transactions '
                'and has never known what is actually in an account.',
            actions: [
              OutlinedButton(onPressed: _editSalary, child: const Text('Set salary')),
              OutlinedButton(onPressed: () => _editCommitment(), child: const Text('Add a fixed cost')),
            ],
          ),
        ),
        const SizedBox(height: 14),
        _SettingsCard(
          icon: Icons.savings_outlined,
          title: 'What a day should cost',
          subtitle:
              _dailyBudgetMinor != null ? '${formatMoney(_dailyBudgetMinor!)} a day' : 'Not set',
          child: _CardBody(
            text: 'Every day under it puts the difference by, every day over it takes the '
                'difference back. The running total is what there is to move into savings when '
                'the next salary lands, and it starts again '
                '${_salaryDay != null ? 'on your pay day' : 'on the 1st'}.',
            actions: [
              OutlinedButton(
                onPressed: _editDailyBudget,
                child: Text(_dailyBudgetMinor != null ? 'Change it' : 'Set a daily budget'),
              ),
            ],
          ),
        ),
        if (_commitments.isNotEmpty) ...[
          const SizedBox(height: 14),
          _SettingsCard(
            icon: Icons.event_repeat_outlined,
            title: 'Fixed each month',
            subtitle:
                '${formatMoney(_commitments.fold<int>(0, (sum, c) => sum + c.amountMinor))} a month',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SizedBox(height: 6),
                for (final commitment in _commitments)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    onTap: () => _editCommitment(commitment),
                    title: Text(commitment.name, style: const TextStyle(fontSize: 13.5)),
                    subtitle: Text(
                      [
                        'on the ${commitment.dayOfMonth}th',
                        if (commitment.merchant != null) commitment.merchant!,
                        if (commitment.categoryName != null) commitment.categoryName!,
                      ].join(' · '),
                    ),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(formatMoney(commitment.amountMinor), style: kNum.copyWith(fontSize: 13)),
                        IconButton(
                          icon: const Icon(Icons.close, size: 17),
                          onPressed: () => _removeCommitment(commitment),
                        ),
                      ],
                    ),
                  ),
                Text(
                  'Tick one off on the dashboard when it has actually gone out.',
                  style: TextStyle(fontSize: 11.5, height: 1.45, color: context.c.mutedLight),
                ),
              ],
            ),
          ),
        ],
        const SizedBox(height: 14),
        _SettingsCard(
          icon: Icons.account_balance_outlined,
          title: 'Loans',
          subtitle: _loans.where((loan) => loan.status == 'ACTIVE').isEmpty
              ? 'None yet'
              : '${formatMoney(_loans.where((loan) => loan.status == 'ACTIVE').fold<int>(0, (sum, l) => sum + l.monthlyAmountMinor))} a month',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                "A bank's personal loan, an employer advance, money from a relative — anything "
                'with a fixed term and a monthly repayment. Mark a payment against one from the '
                'transaction itself, or from here if it never produced a message to match.',
                style: TextStyle(fontSize: 13, height: 1.5, color: context.c.ink70),
              ),
              if (_loans.isNotEmpty) const SizedBox(height: 6),
              for (final loan in _loans)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  onTap: () => _editLoan(loan),
                  title: Text(loan.label, style: const TextStyle(fontSize: 13.5)),
                  subtitle: Text(
                    loan.status != 'ACTIVE'
                        ? loan.status == 'CLOSED'
                            ? 'Closed'
                            : 'Cancelled'
                        : '${loan.paidCount} of ${loan.months} paid · '
                            '${formatMoney(loan.remainingMinor)} left',
                  ),
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(formatMoney(loan.monthlyAmountMinor), style: kNum.copyWith(fontSize: 13)),
                      IconButton(
                        icon: const Icon(Icons.close, size: 17),
                        onPressed: () => _removeLoan(loan),
                      ),
                    ],
                  ),
                ),
              const SizedBox(height: 6),
              OutlinedButton(onPressed: () => _editLoan(), child: const Text('Add a loan')),
            ],
          ),
        ),
      ];

  /// Who you are signed in as, and how to stop being.
  List<Widget> _youTab() => [
        _SettingsCard(
          icon: Icons.lock_outline,
          title: 'Account',
          subtitle: 'Signed in with Google',
          child: _CardBody(
            text: "Signing out doesn't remove any imported transactions. They are on the server, "
                'not on this phone.',
            actions: [
              OutlinedButton(
                onPressed: _signOut,
                style: OutlinedButton.styleFrom(foregroundColor: context.c.debit),
                child: const Text('Sign out'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        _SettingsCard(
          icon: ThemeService.instance.icon,
          title: 'Appearance',
          subtitle: ThemeService.instance.label,
          child: _CardBody(
            text: 'Follows the device unless you say otherwise. The choice is remembered on this '
                'phone and nowhere else.',
            actions: [
              OutlinedButton(
                onPressed: () async {
                  await ThemeService.instance.cycle();
                  if (mounted) setState(() {});
                },
                child: Text('Switch to ${_nextThemeLabel()}'),
              ),
            ],
          ),
        ),
      ];

  /// What the button offers next. ThemeService cycles light, dark, system.
  String _nextThemeLabel() {
    switch (ThemeService.instance.mode) {
      case ThemeMode.light:
        return 'dark';
      case ThemeMode.dark:
        return 'system';
      case ThemeMode.system:
        return 'light';
    }
  }

  /// What the app is, and what it cannot do.
  List<Widget> _aboutTab() => [
        _SettingsCard(
          icon: Icons.info_outline,
          title: 'Version',
          subtitle: 'SpendLog $appVersion (build $appBuildNumber)',
          child: _CardBody(
            pill: _updateAvailable ? const _StatusPill(label: 'Update available', on: false) : null,
            text: _updateAvailable
                ? 'Version $_latestVersion is out. Installing it over this one keeps your data.'
                : 'The app, the website and the server are released together and share this version '
                    'number, so what you are running always matches the server.',
            actions: [
              if (_updateAvailable)
                FilledButton(
                  onPressed: UpdateService.instance.openDownload,
                  child: const Text('Download update'),
                )
              else
                OutlinedButton(
                  onPressed: _checkingUpdate ? null : _checkForUpdate,
                  child: Text(_checkingUpdate ? 'Checking…' : 'Check for updates'),
                ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        const _SettingsCard(
          icon: Icons.help_outline,
          title: 'What it knows',
          subtitle: 'And what it does not',
          child: _CardBody(
            text: 'SpendLog reads the messages your banks send about transactions, and the statements '
                'they email. It has never known a balance.\n\nSo it can say you are spending faster '
                'this fortnight than your salary supports. It cannot say whether you can afford next '
                "week's bill. Every figure is built from money that moved.",
          ),
        ),
      ];
}

class _SettingsCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final Widget child;

  const _SettingsCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: context.c.surface,
        border: Border.all(color: context.c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(color: context.c.brand50, borderRadius: BorderRadius.circular(9)),
                child: Icon(icon, size: 17, color: context.c.brand),
              ),
              const SizedBox(width: 10),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: context.c.ink)),
                  Text(subtitle, style: TextStyle(fontSize: 12, color: context.c.muted)),
                ],
              ),
            ],
          ),
          child,
        ],
      ),
    );
  }
}

class _CardBody extends StatelessWidget {
  final Widget? pill;
  final String text;
  final List<Widget>? actions;

  const _CardBody({this.pill, required this.text, this.actions});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 12),
        if (pill != null) ...[pill!, const SizedBox(height: 8)],
        Text(text, style: TextStyle(fontSize: 13, height: 1.5, color: context.c.ink70)),
        if (actions != null) ...[
          const SizedBox(height: 14),
          Row(children: [for (final action in actions!) Padding(padding: const EdgeInsets.only(right: 8), child: action)]),
        ],
      ],
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String label;
  final bool on;

  const _StatusPill({required this.label, required this.on});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: on ? context.c.credit50 : context.c.chipNeutral,
        borderRadius: BorderRadius.circular(100),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (on) ...[
            Icon(Icons.check, size: 12, color: context.c.credit),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w700,
              color: on ? context.c.credit : context.c.muted,
            ),
          ),
        ],
      ),
    );
  }
}

/// A switch with room for a line explaining what it does — these two need
/// explaining, since neither one's behaviour is obvious from its name.
class _ToggleRow extends StatelessWidget {
  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  const _ToggleRow({
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return SwitchListTile(
      value: value,
      onChanged: onChanged,
      contentPadding: EdgeInsets.zero,
      dense: true,
      title: Text(
        title,
        style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: context.c.ink),
      ),
      subtitle: Text(
        subtitle,
        style: TextStyle(fontSize: 12, height: 1.4, color: context.c.muted),
      ),
    );
  }
}

/// What lands each month and when.
///
/// Two numbers rather than a whole profile screen, because they are the
/// only two the pace arithmetic needs.
/// What a day should cost. One field, because that is the whole setting.
class _DailyBudgetDialog extends StatefulWidget {
  final int? amountMinor;

  const _DailyBudgetDialog({this.amountMinor});

  @override
  State<_DailyBudgetDialog> createState() => _DailyBudgetDialogState();
}

class _DailyBudgetDialogState extends State<_DailyBudgetDialog> {
  late final _amount = TextEditingController(
    text: widget.amountMinor != null ? (widget.amountMinor! ~/ 100).toString() : '',
  );
  bool _saving = false;

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    final navigator = Navigator.of(context);
    final rupees = double.tryParse(_amount.text.trim());

    try {
      // An empty box clears it rather than being a mistake: that is how
      // somebody turns the bucket off again.
      await ApiClient.instance.patch('/budget/profile', {
        'dailyBudgetMinor': rupees == null || rupees <= 0 ? null : (rupees * 100).round(),
      });
      navigator.pop(true);
    } catch (_) {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('What a day should cost'),
      content: TextField(
        controller: _amount,
        autofocus: true,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        decoration: const InputDecoration(
          labelText: 'A day',
          prefixText: '₹ ',
          hintText: '1000',
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _saving ? null : _save, child: const Text('Save')),
      ],
    );
  }
}

class _SalaryDialog extends StatefulWidget {
  final int? amountMinor;
  final int? day;

  const _SalaryDialog({this.amountMinor, this.day});

  @override
  State<_SalaryDialog> createState() => _SalaryDialogState();
}

class _SalaryDialogState extends State<_SalaryDialog> {
  late final _amount = TextEditingController(
    text: widget.amountMinor != null ? (widget.amountMinor! ~/ 100).toString() : '',
  );
  late final _day = TextEditingController(text: widget.day?.toString() ?? '');
  bool _saving = false;

  @override
  void dispose() {
    _amount.dispose();
    _day.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    final navigator = Navigator.of(context);
    final rupees = double.tryParse(_amount.text.trim());

    try {
      await ApiClient.instance.patch('/budget/profile', {
        'salaryAmountMinor': rupees == null ? null : (rupees * 100).round(),
        'salaryDay': int.tryParse(_day.text.trim()),
      });
      navigator.pop(true);
    } catch (_) {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Your salary'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _amount,
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Amount', prefixText: '₹ '),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _day,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Day of the month', hintText: '15'),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _saving ? null : _save, child: const Text('Save')),
      ],
    );
  }
}

/// Rent, a SIP, insurance - anything that goes out every month whatever
/// else happens, and is therefore not free to spend.
///
/// The merchant and category live here rather than only on the payment,
/// because a fixed cost is the same both every month: recording them once
/// means a payment marked against it arrives already filled in.
class _CommitmentDialog extends StatefulWidget {
  /// null means "add a new one".
  final FixedCommitment? commitment;
  final List<Category> categories;

  const _CommitmentDialog({this.commitment, this.categories = const []});

  @override
  State<_CommitmentDialog> createState() => _CommitmentDialogState();
}

class _CommitmentDialogState extends State<_CommitmentDialog> {
  late final _name = TextEditingController(text: widget.commitment?.name ?? '');
  late final _amount = TextEditingController(
    text: widget.commitment != null ? (widget.commitment!.amountMinor ~/ 100).toString() : '',
  );
  late final _day = TextEditingController(text: widget.commitment?.dayOfMonth.toString() ?? '');
  late final _merchant = TextEditingController(text: widget.commitment?.merchant ?? '');

  late String? _categoryId = widget.commitment?.categoryId;
  bool _saving = false;

  @override
  void dispose() {
    _name.dispose();
    _amount.dispose();
    _day.dispose();
    _merchant.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final rupees = double.tryParse(_amount.text.trim());
    if (_name.text.trim().isEmpty || rupees == null) return;

    setState(() => _saving = true);
    final navigator = Navigator.of(context);

    final body = {
      'name': _name.text.trim(),
      'amountMinor': (rupees * 100).round(),
      'dayOfMonth': int.tryParse(_day.text.trim()) ?? 1,
      'merchant': _merchant.text.trim().isEmpty ? null : _merchant.text.trim(),
      'categoryId': _categoryId,
    };

    try {
      if (widget.commitment == null) {
        await ApiClient.instance.post('/budget/commitments', body);
      } else {
        await ApiClient.instance.patch('/budget/commitments/${widget.commitment!.id}', body);
      }
      navigator.pop(true);
    } catch (_) {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.commitment == null ? 'Add a fixed cost' : 'Edit fixed cost'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: _name,
              autofocus: widget.commitment == null,
              decoration: const InputDecoration(labelText: 'What it is', hintText: 'Rent'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _amount,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                labelText: 'Amount a month',
                prefixText: '₹ ',
                helperText: 'What it costs you - your share, on a bill you pay whole for others.',
                helperMaxLines: 3,
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _day,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Day of the month', hintText: '5'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _merchant,
              decoration: const InputDecoration(labelText: 'Usually paid to', hintText: 'Landlord'),
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<String?>(
              initialValue: _categoryId,
              isExpanded: true,
              decoration: const InputDecoration(
                labelText: 'Usual category',
                helperText: 'Both fill themselves in on a payment marked against this.',
                helperMaxLines: 3,
              ),
              items: [
                const DropdownMenuItem<String?>(value: null, child: Text('None')),
                for (final category in widget.categories)
                  DropdownMenuItem<String?>(value: category.id, child: Text(category.name)),
              ],
              onChanged: (value) => setState(() => _categoryId = value),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(widget.commitment == null ? 'Add' : 'Save'),
        ),
      ],
    );
  }
}

/// Add a loan, or rename one already added.
///
/// Unlike an EMI, there is no purchase to read a principal off - the money
/// most often never arrived as a transaction SpendLog has ever seen, so
/// everything here is typed in rather than taken from a debit already on
/// the ledger. Editing an existing loan only renames it; the schedule of
/// one already running cannot be changed, the same as an EMI plan cannot
/// be re-amortised after the fact.
class _LoanDialog extends StatefulWidget {
  /// null means "add a new one".
  final Loan? loan;

  const _LoanDialog({this.loan});

  @override
  State<_LoanDialog> createState() => _LoanDialogState();
}

class _LoanDialogState extends State<_LoanDialog> {
  late final _label = TextEditingController(text: widget.loan?.label ?? '');
  late final _principal = TextEditingController(
    text: widget.loan != null ? (widget.loan!.principalMinor ~/ 100).toString() : '',
  );
  late final _months = TextEditingController(text: widget.loan?.months.toString() ?? '12');
  late final _monthly = TextEditingController(
    text: widget.loan != null ? (widget.loan!.monthlyAmountMinor / 100).toStringAsFixed(2) : '',
  );
  late final _rate = TextEditingController();
  DateTime _startDate = DateTime.now();

  bool _saving = false;
  String? _error;

  bool get _isNew => widget.loan == null;

  @override
  void dispose() {
    _label.dispose();
    _principal.dispose();
    _months.dispose();
    _monthly.dispose();
    _rate.dispose();
    super.dispose();
  }

  /// The reducing-balance formula the server uses, for the preview.
  int _computedMonthlyMinor() {
    final principalMinor = ((double.tryParse(_principal.text.trim()) ?? 0) * 100).round();
    final months = int.tryParse(_months.text.trim()) ?? 0;
    if (months <= 0) return 0;

    final annual = double.tryParse(_rate.text.trim());
    if (annual == null || annual <= 0) return (principalMinor / months).round();

    final r = annual / 12 / 100;
    final growth = math.pow(1 + r, months);
    return (principalMinor * r * growth / (growth - 1)).round();
  }

  Future<void> _pickStartDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _startDate,
      firstDate: DateTime(2015),
      lastDate: DateTime.now().add(const Duration(days: 1)),
    );
    if (picked != null) setState(() => _startDate = picked);
  }

  Future<void> _save() async {
    if (_label.text.trim().isEmpty) {
      setState(() => _error = "Give it a name — who it's from, or what it's for.");
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);

    try {
      if (_isNew) {
        final principalMinor = ((double.tryParse(_principal.text.trim()) ?? 0) * 100).round();
        final months = int.tryParse(_months.text.trim()) ?? 0;
        final monthlyMinor = _monthly.text.trim().isNotEmpty
            ? (double.parse(_monthly.text.trim()) * 100).round()
            : _computedMonthlyMinor();

        if (principalMinor <= 0) {
          setState(() {
            _error = 'Enter the amount borrowed.';
            _saving = false;
          });
          return;
        }
        if (monthlyMinor <= 0) {
          setState(() {
            _error = 'The monthly amount needs to be more than zero.';
            _saving = false;
          });
          return;
        }

        await ApiClient.instance.post('/loans', {
          'label': _label.text.trim(),
          'principalMinor': principalMinor,
          'months': months,
          'monthlyAmountMinor': monthlyMinor,
          'interestRatePctAnnual': _rate.text.trim().isEmpty ? null : double.tryParse(_rate.text.trim()),
          'startDate': _startDate.toIso8601String(),
        });
      } else {
        await ApiClient.instance.patch('/loans/${widget.loan!.id}', {'label': _label.text.trim()});
      }
      navigator.pop(true);
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error is ApiException ? error.message : "That didn't work.";
          _saving = false;
        });
      }
    }
  }

  Future<void> _closeEarly() async {
    setState(() => _saving = true);
    final navigator = Navigator.of(context);
    try {
      await ApiClient.instance.patch('/loans/${widget.loan!.id}', {'status': 'CLOSED'});
      navigator.pop(true);
    } catch (error) {
      if (mounted) {
        setState(() {
          _error = error is ApiException ? error.message : "That didn't work.";
          _saving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_isNew ? 'Add a loan' : 'Rename loan'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: _label,
              autofocus: _isNew,
              decoration: const InputDecoration(
                labelText: "Who it's from, or what it's for",
                hintText: 'HDFC personal loan',
              ),
            ),
            if (_isNew) ...[
              const SizedBox(height: 10),
              TextField(
                controller: _principal,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Amount borrowed', prefixText: '₹ '),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _months,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Months', hintText: '24'),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _monthly,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: InputDecoration(
                  labelText: 'Monthly repayment',
                  prefixText: '₹ ',
                  hintText: _computedMonthlyMinor() > 0 ? (_computedMonthlyMinor() / 100).toStringAsFixed(2) : null,
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _rate,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Interest rate (% a year)', hintText: 'Optional'),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 10),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Started on'),
                subtitle: Text(formatShortDate(_startDate)),
                trailing: const Icon(Icons.calendar_today_outlined, size: 18),
                onTap: _pickStartDate,
              ),
              Text(
                'Take the monthly figure off the paperwork if you can — a calculated one rarely '
                "lands to the rupee once the lender's own rounding is in it.",
                style: TextStyle(fontSize: 11.5, height: 1.4, color: context.c.mutedLight),
              ),
            ] else ...[
              const SizedBox(height: 8),
              Text(
                '${widget.loan!.paidCount} of ${widget.loan!.months} paid, '
                '${formatMoney(widget.loan!.remainingMinor)} left. The schedule itself cannot be '
                'changed once a loan is added.',
                style: TextStyle(fontSize: 11.5, height: 1.4, color: context.c.mutedLight),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: TextStyle(fontSize: 12, color: context.c.debit)),
            ],
          ],
        ),
      ),
      actions: [
        if (!_isNew && widget.loan!.status == 'ACTIVE')
          TextButton(onPressed: _saving ? null : _closeEarly, child: const Text('Close early')),
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(_isNew ? 'Add' : 'Save'),
        ),
      ],
    );
  }
}
