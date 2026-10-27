import 'dart:io' show Platform;
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/models.dart';
import '../models/subscription_models.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../services/push_service.dart';
import '../services/reminder_service.dart';
import '../services/theme_service.dart';
import '../services/sms_service.dart';
import '../services/update_service.dart';
import '../utils/format.dart';
import '../utils/loan_tab.dart';
import '../version.dart';
import '../widgets/commitment_amount.dart';
import '../widgets/ds/ds.dart';
import '../widgets/family_section.dart';
import '../widgets/loan_dialog.dart';
import '../widgets/person_picker_sheet.dart';
import 'accounts_screen.dart';
import 'monthly_budget_screen.dart';
import 'statements_screen.dart';
import 'subscriptions_screen.dart';
import 'login_screen.dart';
import 'permission_screen.dart';
import 'start_fresh_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => SettingsScreenState();
}

/// Public so the shell can turn to the assistant's card when the Ask
/// screen sends somebody here to add a key.
class SettingsScreenState extends State<SettingsScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 6, vsync: this);

  /// The tab the AI assistant card sits on.
  static const _assistantTab = 4;

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
  bool _planWarnings = true;

  List<MerchantPreset> _presets = [];
  List<Category> _categories = [];
  List<FixedCommitment> _commitments = [];
  List<Loan> _loans = [];

  /// What renews, in one line; null until it has loaded.
  SubscriptionTotals? _subscriptions;
  int? _salaryMinor;
  int? _salaryDay;

  /// This month against its budget; null until loaded, or when it failed.
  MonthlyBudgetStatus? _budget;

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

  /// null until the server has said whether a key is saved.
  AiSettings? _ai;
  List<AiModel> _aiModels = [];
  final _aiKey = TextEditingController();
  bool _aiKeyVisible = false;
  bool _aiSaving = false;
  String? _aiNote;
  bool _aiNoteIsError = false;

  @override
  void initState() {
    super.initState();
    _loadConnections();
    _loadYou();
    _loadPresets();
    _loadLedger();
    _loadAi();
    if (Platform.isAndroid) {
      _refreshSmsStatus();
      _loadReminders();
    }
  }

  @override
  void dispose() {
    _tabs.dispose();
    _aiKey.dispose();
    super.dispose();
  }

  /// Turn to the AI assistant card, freshly loaded - the Ask screen sends
  /// people here when there is no key yet.
  void showAssistant() {
    _tabs.animateTo(_assistantTab);
    _loadAi();
  }

  Future<void> _loadAi() async {
    try {
      final json = await ApiClient.instance.get('/ai/settings') as Map<String, dynamic>;
      if (!mounted) return;
      final settings = AiSettings.fromJson(json);
      setState(() => _ai = settings);
      await _loadAiModels(settings);
    } catch (_) {
      // The card says it is loading and stays that way.
    }
  }

  /// The models this key can use. Only asked for once a key is saved -
  /// the list comes from Google, under that key.
  Future<void> _loadAiModels(AiSettings settings) async {
    if (!settings.hasKey) {
      if (mounted) setState(() => _aiModels = []);
      return;
    }
    try {
      final result = await ApiClient.instance.get('/ai/models') as List<dynamic>;
      if (!mounted) return;
      setState(() => _aiModels =
          result.map((m) => AiModel.fromJson(m as Map<String, dynamic>)).toList());
    } catch (_) {
      // The picker offers the default alone, which always works.
      if (mounted) setState(() => _aiModels = []);
    }
  }

  /// Every change to the assistant's settings goes through here, so the
  /// card shows what the server now holds rather than what was asked for.
  Future<void> _putAi(Map<String, dynamic> body, String done) async {
    setState(() {
      _aiSaving = true;
      _aiNote = null;
    });
    try {
      final json = await ApiClient.instance.put('/ai/settings', body) as Map<String, dynamic>;
      if (!mounted) return;
      final settings = AiSettings.fromJson(json);
      setState(() {
        _ai = settings;
        _aiNote = done;
        _aiNoteIsError = false;
      });
      if (body.containsKey('apiKey')) {
        _aiKey.clear();
        await _loadAiModels(settings);
      }
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _aiNote = error is ApiException ? error.message : "Couldn't save that just now.";
        _aiNoteIsError = true;
      });
    } finally {
      if (mounted) setState(() => _aiSaving = false);
    }
  }

  Future<void> _saveAiKey() async {
    final key = _aiKey.text.trim();
    if (key.isEmpty) return;
    // The server tries the key against Google before keeping it, so a
    // mistyped one is turned away here rather than at the first question.
    await _putAi({'apiKey': key}, 'Saved. Ask away from the dashboard.');
  }

  Future<void> _removeAiKey() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Remove the key?'),
        content: const Text(
          'The assistant stops working until a key is added again. Nothing else changes, and the '
          'key itself still works with Google.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep it')),
          _ConfirmRemove(onPressed: () => Navigator.of(context).pop(true)),
        ],
      ),
    );
    if (sure != true) return;
    await _putAi({'apiKey': null}, 'Removed.');
  }

  Future<void> _openAiStudio() async {
    await launchUrl(Uri.parse('https://aistudio.google.com/apikey'), mode: LaunchMode.externalApplication);
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
          _ConfirmRemove(onPressed: () => Navigator.of(context).pop(true)),
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

    // On its own, so a budget that fails to load costs its card and not
    // the salary and fixed costs beside it.
    try {
      final json = await ApiClient.instance.get('/budget/monthly') as Map<String, dynamic>;
      if (mounted) setState(() => _budget = MonthlyBudgetStatus.fromJson(json));
    } catch (_) {
      // The card says "Not set" and the editor loads it again itself.
    }
    await _loadSubscriptions();
  }

  /// The subscriptions line: on its own, like the budget, so a hiccup
  /// there costs its card and nothing else.
  Future<void> _loadSubscriptions() async {
    try {
      final json = await ApiClient.instance.get('/subscriptions/summary') as Map<String, dynamic>;
      if (mounted) setState(() => _subscriptions = SubscriptionTotals.fromJson(json));
    } catch (_) {
      // The card keeps its general line.
    }
  }

  Future<void> _editSalary() async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => _SalaryDialog(amountMinor: _salaryMinor, day: _salaryDay),
    );
    if (saved == true) await _loadYou();
  }

  Future<void> _editBudget() async {
    // Handed what is already loaded, so it opens filled in; it fetches for
    // itself when the budget could not be loaded here.
    final saved = await MonthlyBudgetScreen.open(
      context,
      initial: _budget,
      categories: _budget == null || _categories.isEmpty ? null : _categories,
    );
    if (saved) await _loadYou();
  }

  Future<void> _editCommitment([FixedCommitment? commitment]) async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => _CommitmentDialog(commitment: commitment, categories: _categories),
    );
    if (saved == true) await _loadYou();
  }

  Future<void> _editLoan([Loan? loan]) async {
    if (await LoanDialog.show(context, loan: loan)) await _loadYou();
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
    final plan = await ReminderService.instance.planWarningsEnabled();
    if (!mounted) return;
    setState(() {
      _dailyReminder = daily;
      _nagReminder = nag;
      _billReminder = bills;
      _planWarnings = plan;
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
      } else if (which == 'plan') {
        _planWarnings = enabled;
      } else {
        _billReminder = enabled;
      }
    });
    final messenger = ScaffoldMessenger.of(context);

    final armed = switch (which) {
      'daily' => await ReminderService.instance.setDailyEnabled(enabled),
      'nag' => await ReminderService.instance.setNagEnabled(enabled),
      'plan' => await ReminderService.instance.setPlanWarningsEnabled(enabled),
      _ => await ReminderService.instance.setBillsEnabled(enabled),
    };

    if (!mounted || armed == enabled) return;
    setState(() {
      if (which == 'daily') {
        _dailyReminder = false;
      } else if (which == 'nag') {
        _nagReminder = false;
      } else if (which == 'plan') {
        _planWarnings = false;
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
      // Checked with Google, so this never says "Connected" about a mailbox
      // that can no longer be read.
      final result = await ApiClient.instance.get('/ingestion/email/status?check=1') as List<dynamic>;
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
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ApiClient.instance.post('/ingestion/email/sync');
    } catch (error) {
      messenger.showSnackBar(SnackBar(
        content: Text(error is ApiException ? error.message : "Couldn't sync just now."),
      ));
    } finally {
      await _loadConnections();
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
    // First, while the session can still tell the server to stop waking
    // this phone for kids' refreshes.
    await PushService.instance.unregister();
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
    //
    // The design has no underline tabs; six sections are too many for a
    // segmented control at phone width, so they are a scrolling row of
    // chips (the settings "secondary nav"), still driven by the same
    // controller so a swipe between pages keeps working.
    final c = context.c;
    return Column(
      children: [
        Container(
          decoration: BoxDecoration(color: c.bg, border: Border(bottom: BorderSide(color: c.ln))),
          child: AnimatedBuilder(
            animation: _tabs,
            builder: (context, _) => SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
              child: Row(
                children: [
                  for (var i = 0; i < _sections.length; i++) ...[
                    if (i > 0) const SizedBox(width: 8),
                    DsChip(
                      label: _sections[i],
                      selected: _tabs.index == i,
                      showCheck: false,
                      onTap: () => _tabs.animateTo(i),
                    ),
                  ],
                ],
              ),
            ),
          ),
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

  static const _sections = ['Connections', 'Accounts', 'Budget', 'Presets', 'You', 'About'];

  Widget _tab(List<Widget> children) => ListView(
        padding: kPagePad,
        children: children,
      );

  /// A destructive secondary button: transparent, crit text, critSoft edge.
  ButtonStyle _destructive(DsColors c) => OutlinedButton.styleFrom(
        foregroundColor: c.crit,
        backgroundColor: Colors.transparent,
        side: BorderSide(color: c.critSoft),
      );

  /// Where the data comes from: Gmail, the statements in it, and SMS.
  List<Widget> _connectionsTab() {
    final connection = _connections.isEmpty ? null : _connections.first;
    final c = context.c;

    return [
        // Where the ledger starts is a fact about what gets fetched, so it
        // belongs beside the mailbox and the phone it gets fetched from.
        _SettingsCard(
          icon: DsIcons.calendar,
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
                  style: _destructive(c),
                  child: Text(_purgingLedger ? 'Removing…' : 'Clear $_ledgerStale older rows'),
                ),
            ],
          ),
        ),
        const SizedBox(height: kCardGap),
        _SettingsCard(
          icon: DsIcons.mail,
          title: 'Email import',
          subtitle: 'Gmail, read-only',
          // A mailbox Google stopped letting us read is the critical state
          // (§7.5): the whole card turns, not just a line in it.
          critical: connection?.needsReconnect ?? false,
          child: connection == null
              ? _CardBody(
                  pill: const _StatusPill(label: 'Not connected', on: false),
                  text: 'Email access was declined when you signed in. You can grant it here instead.',
                  actions: [
                    FilledButton(onPressed: _connectGmail, child: const Text('Connect Gmail')),
                  ],
                )
              // Google dropped the saved sign-in. Nothing imported is lost;
              // only reading new mail waits on reconnecting.
              : connection.needsReconnect
              ? _CardBody(
                  pill: const _StatusPill(label: 'Not connected', on: false, tone: DsTone.crit),
                  text: '${connection.email}\nGoogle stopped letting SpendLog read this mailbox, so it has been '
                      'unlinked. Nothing already imported is lost - connect it again to carry on reading new '
                      'emails and statements.',
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
        const SizedBox(height: kCardGap),
        if (Platform.isAndroid)
          _SettingsCard(
            icon: DsIcons.message,
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
            icon: DsIcons.message,
            title: 'SMS import',
            subtitle: 'Android only',
            child: _CardBody(
              pill: _StatusPill(label: 'Not available here', on: false),
              text: 'Reading text messages is something only Android allows. On this device SpendLog can '
                  'still import from Gmail.',
            ),
          ),
        if (Platform.isAndroid) ...[
          const SizedBox(height: kCardGap),
          _SettingsCard(
            icon: DsIcons.bell,
            title: 'Reminders',
            subtitle: 'About yesterday',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SizedBox(height: 12),
                Text(
                  'An import gets the amount and the merchant. What it was for is the part only '
                  'you know, and it is easiest to remember the next morning.',
                  style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2),
                ),
                const SizedBox(height: 8),
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
                  title: 'Warn me when I break my savings plan',
                  subtitle: 'Up to 3 times a day, 8am to 10pm, while a rule in your AI savings '
                      'plan is being broken. Needs a Gemini key and a plan.',
                  value: _planWarnings,
                  onChanged: (on) => _setReminder('plan', on),
                ),
                _ToggleRow(
                  title: 'Keep reminding',
                  subtitle: 'From 6am to 10pm, every half hour, while anything from yesterday is '
                      'still uncategorised. Stops as soon as none are.',
                  value: _nagReminder,
                  onChanged: (on) => _setReminder('nag', on),
                  last: true,
                ),
                // Said out loud because it is the thing that goes wrong.
                // Android stops background work on most phones once the
                // app has been away a while, and the reminders fall back
                // to alarms that fire regardless - so this line explains a
                // "never" rather than leaving it looking broken.
                if (_nagReminder)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      _nagLastRun == null
                          ? 'The background check has not managed to run yet, so the reminders '
                              'come from alarms and are switched off next time you open the app.'
                          : 'Background check last ran ${formatDateTime(_nagLastRun!)}.',
                      style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
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
          icon: DsIcons.bank,
          title: 'Accounts and cards',
          subtitle: 'Where the money moves',
          child: _CardBody(
            text: 'Name your accounts, merge the duplicates a bank creates by spelling itself two ways, '
                'and add anything that never sends a message.',
            actions: [
              OutlinedButton(onPressed: _openAccounts, child: const Text('Manage accounts')),
              // Stop chasing old mismatches: every balance starts again
              // from what the banks show today.
              OutlinedButton(
                onPressed: () => StartFreshScreen.open(context),
                child: const Text('Start fresh from today'),
              ),
            ],
          ),
        ),
        const SizedBox(height: kCardGap),
        // Beside Accounts because a kid's login is built on the pocket
        // money accounts marked there.
        _SettingsCard(
          icon: DsIcons.users,
          title: 'Family',
          subtitle: 'Logins for your kids',
          child: FamilySection(onOpenAccounts: _openAccounts),
        ),
        const SizedBox(height: kCardGap),
        // A card's statements are that card's paperwork, so they live with
        // it rather than under the mailbox they arrived through.
        // Read here as well as seen here. It was read from Connections,
        // beside the mailbox, and seen from this tab - one button in one
        // tab whose result appeared in another, which is the thing a tab
        // must never ask of you.
        _SettingsCard(
          icon: DsIcons.list,
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
          icon: DsIcons.tag,
          title: 'Merchant presets',
          subtitle: 'A name and the category it usually belongs to',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 12),
              Text(
                'These appear under the merchant field when you add or edit a payment. Picking one '
                'fills in both, which is most of the typing gone.',
                style: TextStyle(fontSize: 14, height: 20 / 14, color: context.c.tx2),
              ),
              const SizedBox(height: 16),
              if (_presets.isEmpty)
                const DsEmpty(
                  icon: DsIcons.tag,
                  message: 'None yet. Add one from the merchant field while editing a payment.',
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
                        deleteIcon: DsIcon(DsIcons.x, size: 14, color: context.c.tx2),
                        deleteButtonTooltipMessage: 'Remove',
                        onDeleted: () => _removePreset(preset),
                      ),
                  ],
                ),
            ],
          ),
        ),
      ];

  /// "₹20,000 a month · 4 category limits", or "Not set".
  String _budgetSubtitle() {
    final budget = _budget;
    if (budget == null || !budget.configured) return 'Not set';
    final limits = budget.categories.length;
    return '${formatMoney(budget.budgetMinor!)} a month'
        '${limits == 0 ? '' : ' · $limits ${limits == 1 ? 'category limit' : 'category limits'}'}';
  }

  /// What is already spoken for each month: pay in, and the fixed payments
  /// out. The pay day sets where a month starts, and the fixed payments
  /// count against the monthly budget; they used to sit in the same drawer
  /// as the sign-out button.
  List<Widget> _budgetTab() => [
        _SettingsCard(
          icon: DsIcons.banknote,
          title: 'What lands each month',
          subtitle: _salaryMinor != null
              ? '${formatMoney(_salaryMinor!)} on the ${_salaryDay}th'
              : 'Not set',
          child: _CardBody(
            text: 'The pay day sets where your month starts, so the monthly budget runs pay day to pay '
                'day. Fixed costs - rent, EMIs, SIPs - count against that budget like everything else, '
                'and the dashboard ticks them off as they go out.',
            actions: [
              OutlinedButton(onPressed: _editSalary, child: const Text('Set salary')),
              OutlinedButton(onPressed: () => _editCommitment(), child: const Text('Add a fixed cost')),
            ],
          ),
        ),
        const SizedBox(height: kCardGap),
        _SettingsCard(
          icon: DsIcons.target,
          title: 'Monthly budget',
          subtitle: _budgetSubtitle(),
          child: _CardBody(
            text: 'One amount for the month, and everything counts against it - rent, EMIs and SIPs '
                'included. Share it out across categories if you like; whatever is left when the '
                'month ends goes into your savings bucket. A month runs '
                '${_salaryDay != null ? 'pay day to pay day' : 'from the 1st'}.',
            actions: [
              OutlinedButton(
                onPressed: _editBudget,
                child: Text(_budget?.configured ?? false ? 'Edit budget' : 'Set a monthly budget'),
              ),
            ],
          ),
        ),
        if (_commitments.isNotEmpty) ...[
          const SizedBox(height: kCardGap),
          _SettingsCard(
            icon: DsIcons.repeat,
            title: 'Fixed each month',
            subtitle:
                '${formatMoney(_commitments.fold<int>(0, (sum, c) => sum + c.amountMinor))} a month',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SizedBox(height: 8),
                for (var i = 0; i < _commitments.length; i++)
                  _ListRow(
                    title: _commitments[i].name,
                    subtitle: [
                      'on the ${_commitments[i].dayOfMonth}th',
                      if (_commitments[i].merchant != null) _commitments[i].merchant!,
                      if (_commitments[i].categoryName != null) _commitments[i].categoryName!,
                    ].join(' · '),
                    amount: CommitmentAmount(commitment: _commitments[i], fontSize: 14),
                    onTap: () => _editCommitment(_commitments[i]),
                    onRemove: () => _removeCommitment(_commitments[i]),
                    divider: i < _commitments.length - 1,
                  ),
                const SizedBox(height: 8),
                Text(
                  'Each one counts against your monthly budget. Tick one off on the dashboard when it has '
                  'actually gone out.',
                  style: TextStyle(fontSize: 12, height: 16 / 12, color: context.c.tx3),
                ),
              ],
            ),
          ),
        ],
        const SizedBox(height: kCardGap),
        _SettingsCard(
          icon: DsIcons.calendar,
          title: 'Subscriptions',
          subtitle: _subscriptions == null || _subscriptions!.isEmpty
              ? 'Netflix, Prime, the gym - anything that renews'
              : '${formatMoney(_subscriptions!.monthlyMinor)} a month · ${_subscriptions!.activeCount} active',
          child: _CardBody(
            pill: _subscriptions != null && _subscriptions!.alertCount > 0
                ? DsBadge('${_subscriptions!.alertCount} need${_subscriptions!.alertCount == 1 ? 's' : ''} a look', tone: DsTone.warn, icon: DsIcons.alertTriangle)
                : null,
            text: 'Each renewal is matched to the payment that lands, counted as a fixed cost of the month, and '
                'flagged when it does not show up or comes in at a new price. Repeating charges you are not '
                'tracking yet are pointed out there.',
            actions: [
              OutlinedButton(
                key: const ValueKey('open-subscriptions'),
                onPressed: () => SubscriptionsScreen.open(context).then((_) => _loadSubscriptions()),
                child: const Text('Open subscriptions'),
              ),
            ],
          ),
        ),
        const SizedBox(height: kCardGap),
        _SettingsCard(
          icon: DsIcons.bank,
          title: 'Loans',
          subtitle: _loans.where((loan) => loan.status == 'ACTIVE').isEmpty
              ? 'None yet'
              : '${formatMoney(_loans.where((loan) => loan.status == 'ACTIVE').fold<int>(0, (sum, l) => sum + l.monthlyAmountMinor))} a month',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 12),
              Text(
                "A bank's personal loan, an employer advance, money from a relative — anything "
                'with a fixed term and a monthly repayment. Mark a payment against one from the '
                'transaction itself, or from here if it never produced a message to match.',
                style: TextStyle(fontSize: 14, height: 20 / 14, color: context.c.tx2),
              ),
              if (_loans.isNotEmpty) const SizedBox(height: 8),
              for (var i = 0; i < _loans.length; i++)
                _ListRow(
                  title: _loans[i].label,
                  subtitle: _loans[i].status != 'ACTIVE'
                      ? _loans[i].status == 'CLOSED'
                          ? 'Closed'
                          : 'Cancelled'
                      : '${_loans[i].paidCount} of ${_loans[i].months} paid · '
                          '${formatMoney(_loans[i].remainingMinor)} left · ${loanTabShort(_loans[i].balanceMinor)}',
                  amount: Text(
                    formatMoney(_loans[i].monthlyAmountMinor),
                    style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: context.c.tx),
                  ),
                  onTap: () => _editLoan(_loans[i]),
                  onRemove: () => _removeLoan(_loans[i]),
                  divider: i < _loans.length - 1,
                ),
              const SizedBox(height: 12),
              OutlinedButton.icon(
                onPressed: () => _editLoan(),
                icon: const DsIcon(DsIcons.plus, size: 18),
                label: const Text('Add a loan'),
              ),
            ],
          ),
        ),
      ];

  /// Who you are signed in as, and how to stop being.
  List<Widget> _youTab() => [
        _aiCard(),
        const SizedBox(height: kCardGap),
        _SettingsCard(
          icon: DsIcons.sliders,
          title: 'Appearance',
          subtitle: ThemeService.instance.label,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 12),
              Text(
                'Follows the device unless you say otherwise. The choice is remembered on this '
                'phone and nowhere else.',
                style: TextStyle(fontSize: 14, height: 20 / 14, color: context.c.tx2),
              ),
              const SizedBox(height: 16),
              DsSegmented<ThemeMode>(
                height: 40,
                segments: const [
                  (ThemeMode.light, 'Light'),
                  (ThemeMode.dark, 'Dark'),
                  (ThemeMode.system, 'System'),
                ],
                selected: ThemeService.instance.mode,
                onChanged: (mode) async {
                  await ThemeService.instance.set(mode);
                  if (mounted) setState(() {});
                },
              ),
            ],
          ),
        ),
        const SizedBox(height: kCardGap),
        _SettingsCard(
          icon: DsIcons.lock,
          title: 'Account',
          subtitle: 'Signed in with Google',
          child: _CardBody(
            text: "Signing out doesn't remove any imported transactions. They are on the server, "
                'not on this phone.',
            actions: [
              OutlinedButton(
                onPressed: _signOut,
                style: _destructive(context.c),
                child: const Text('Sign out'),
              ),
            ],
          ),
        ),
      ];

  /// The AI assistant: a Gemini key of your own, and which model it uses.
  ///
  /// The key is theirs rather than SpendLog's, so what it costs and what
  /// Google sees is between them and Google - which is why the card says
  /// plainly what gets sent.
  Widget _aiCard() {
    final c = context.c;
    final ai = _ai;
    final canStore = ai?.canStoreKey ?? true;

    // A saved model the list no longer offers still has to be an item, or
    // the dropdown has nothing to show as selected.
    final models = [
      ..._aiModels,
      if (ai?.model != null && !_aiModels.any((m) => m.id == ai!.model))
        AiModel(id: ai!.model!, name: ai.model!),
    ];

    return _SettingsCard(
      icon: DsIcons.sparkles,
      title: 'AI assistant',
      subtitle: ai == null
          ? 'Loading…'
          : ai.hasKey
              ? 'Key ending ••${ai.keyHint ?? '????'}'
              : 'No key yet',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(height: 12),
          if (ai != null) ...[
            _StatusPill(label: ai.hasKey ? 'Ready' : 'Not set up', on: ai.hasKey),
            const SizedBox(height: 8),
          ],
          Text(
            'Ask about your money in plain words — "how much went on eating out this month?" — '
            'from the dashboard, and get an answer worked out from your own figures.\n\n'
            'It runs on Google Gemini with a key of your own. Get one free from Google AI Studio '
            '(aistudio.google.com/apikey) and paste it here. Your questions, and the figures needed '
            'to answer them, are sent to Google under that key. The key is stored encrypted and '
            'never shown again.',
            style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2),
          ),
          if (!canStore) ...[
            const SizedBox(height: 12),
            const DsCallout(
              tone: DsTone.warn,
              title: "The server isn't set up to store keys yet, so one can't be saved here.",
            ),
          ],
          const SizedBox(height: 16),
          DsField(
            label: ai?.hasKey ?? false ? 'Replace the key' : 'Gemini API key',
            child: TextField(
              controller: _aiKey,
              enabled: canStore && !_aiSaving,
              obscureText: !_aiKeyVisible,
              autocorrect: false,
              enableSuggestions: false,
              // Revealed in Plex Mono, so the key's characters can be told apart.
              style: _aiKeyVisible ? kMono.copyWith(fontSize: 15, color: c.tx) : null,
              decoration: InputDecoration(
                hintText: 'Paste it here',
                suffixIcon: Padding(
                  padding: const EdgeInsets.only(right: 2),
                  child: DsEyeButton(
                    obscured: !_aiKeyVisible,
                    noun: 'key',
                    onPressed: () => setState(() => _aiKeyVisible = !_aiKeyVisible),
                  ),
                ),
              ),
              onChanged: (_) => setState(() {}),
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              FilledButton(
                onPressed: !canStore || _aiSaving || _aiKey.text.trim().isEmpty ? null : _saveAiKey,
                child: Text(_aiSaving ? 'Checking…' : 'Save key'),
              ),
              if (ai?.hasKey ?? false)
                OutlinedButton(
                  onPressed: _aiSaving ? null : _removeAiKey,
                  style: _destructive(c),
                  child: const Text('Remove'),
                ),
              TextButton.icon(
                onPressed: _openAiStudio,
                icon: const DsIcon(DsIcons.arrowUpRight, size: 16),
                label: const Text('Get a free key'),
              ),
            ],
          ),
          if (ai != null && ai.hasKey) ...[
            const SizedBox(height: 16),
            const DsLabel('Model'),
            const SizedBox(height: 6),
            DropdownButtonFormField<String?>(
              // Rebuilt when the list arrives, since initialValue is only
              // read the first time.
              key: ValueKey('${ai.model}-${models.length}'),
              initialValue: ai.model,
              isExpanded: true,
              icon: DsIcon(DsIcons.chevronDown, size: 20, color: c.tx2),
              borderRadius: BorderRadius.circular(Ds.rLg),
              dropdownColor: c.sf,
              decoration: const InputDecoration(
                helperText: 'The default is quick and fine for most questions.',
                helperMaxLines: 2,
              ),
              items: [
                DropdownMenuItem<String?>(
                  value: null,
                  child: Text(
                    ai.defaultModel.isEmpty ? 'Default' : 'Default (${ai.defaultModel})',
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                for (final model in models)
                  DropdownMenuItem<String?>(
                    value: model.id,
                    child: Text(model.name, overflow: TextOverflow.ellipsis),
                  ),
              ],
              onChanged: _aiSaving
                  ? null
                  : (value) {
                      if (value == ai.model) return;
                      _putAi({'model': value}, 'Model changed.');
                    },
            ),
          ],
          if (_aiNote != null) ...[
            const SizedBox(height: 12),
            if (_aiNoteIsError)
              DsCallout(tone: DsTone.crit, title: _aiNote!)
            else
              Row(
                children: [
                  DsIcon(DsIcons.check, size: 16, color: c.good),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      _aiNote!,
                      style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w500, color: c.good),
                    ),
                  ),
                ],
              ),
          ],
        ],
      ),
    );
  }

  /// What the app is, and what it cannot do.
  List<Widget> _aboutTab() => [
        _SettingsCard(
          icon: DsIcons.info,
          title: 'Version',
          subtitle: 'SpendLog $appVersion (build $appBuildNumber)',
          child: _CardBody(
            pill: _updateAvailable
                ? const _StatusPill(label: 'Update available', on: false, tone: DsTone.ac)
                : null,
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
        const SizedBox(height: kCardGap),
        const _SettingsCard(
          icon: DsIcons.shield,
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

/// A settings card: a 40 icon tile, a 15/20 title and a 13/18 sub-line,
/// then the body. [critical] is the whole-card critical state (§7.5) for
/// something that has stopped working.
class _SettingsCard extends StatelessWidget {
  final Object icon;
  final String title;
  final String subtitle;
  final Widget child;
  final bool critical;

  const _SettingsCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.child,
    this.critical = false,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return DsCard(
      color: critical ? c.critSoft : null,
      borderColor: critical ? c.critSoft : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              DsIconTile(icon, tone: critical ? DsTone.crit : DsTone.ac, onTinted: critical),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        fontSize: 15,
                        height: 20 / 15,
                        fontWeight: FontWeight.w600,
                        color: critical ? c.crit : c.tx,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: TextStyle(fontSize: 13, height: 18 / 13, color: critical ? c.tx2 : c.tx3),
                    ),
                  ],
                ),
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
        Text(text, style: TextStyle(fontSize: 14, height: 20 / 14, color: context.c.tx2)),
        if (actions != null && actions!.isNotEmpty) ...[
          const SizedBox(height: 16),
          Wrap(spacing: 8, runSpacing: 8, children: [for (final action in actions!) action]),
        ],
      ],
    );
  }
}

/// A status badge: good with a check when [on], otherwise [tone]
/// (neutral unless something is actually wrong).
class _StatusPill extends StatelessWidget {
  final String label;
  final bool on;
  final DsTone tone;

  const _StatusPill({required this.label, required this.on, this.tone = DsTone.neutral});

  @override
  Widget build(BuildContext context) => on
      ? DsBadge(label, tone: DsTone.good, icon: DsIcons.check)
      : DsBadge(label, tone: tone, icon: tone == DsTone.crit ? DsIcons.alertTriangle : null);
}

/// A switch with room for a line explaining what it does — these two need
/// explaining, since neither one's behaviour is obvious from its name.
class _ToggleRow extends StatelessWidget {
  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;
  final bool last;

  const _ToggleRow({
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
    this.last = false,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return DecoratedBox(
      decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: c.ln))),
      child: SwitchListTile(
        value: value,
        onChanged: onChanged,
        contentPadding: EdgeInsets.zero,
        minTileHeight: 48,
        title: Text(
          title,
          style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
        ),
        subtitle: Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Text(
            subtitle,
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
        ),
      ),
    );
  }
}

/// A row in a settings list: title and a sub-line, the amount, and a remove
/// button; tapping the row edits it.
class _ListRow extends StatelessWidget {
  final String title;
  final String subtitle;
  final Widget amount;
  final VoidCallback onTap;
  final VoidCallback onRemove;
  final bool divider;

  const _ListRow({
    required this.title,
    required this.subtitle,
    required this.amount,
    required this.onTap,
    required this.onRemove,
    this.divider = true,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 56),
        padding: const EdgeInsets.symmetric(vertical: 6),
        decoration: BoxDecoration(border: divider ? Border(bottom: BorderSide(color: c.ln)) : null),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
                  ),
                  const SizedBox(height: 2),
                  Text(subtitle, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            amount,
            IconButton(
              tooltip: 'Remove',
              icon: DsIcon(DsIcons.x, size: 18, color: c.tx3),
              onPressed: onRemove,
            ),
          ],
        ),
      ),
    );
  }
}

/// The final "Remove" in a confirm dialog: the filled destructive button
/// the system proposes for an action that can't be undone.
class _ConfirmRemove extends StatelessWidget {
  final VoidCallback onPressed;

  const _ConfirmRemove({required this.onPressed});

  @override
  Widget build(BuildContext context) => FilledButton(
        onPressed: onPressed,
        style: FilledButton.styleFrom(backgroundColor: context.c.critFill, foregroundColor: Colors.white),
        child: const Text('Remove'),
      );
}

/// What lands each month and when.
///
/// Two numbers rather than a whole profile screen, because they are all
/// it takes to know where a month starts.
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
          DsField(
            label: 'Amount',
            child: TextField(
              controller: _amount,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              style: kNum.copyWith(fontSize: 15),
              decoration: const InputDecoration(prefixText: '₹'),
            ),
          ),
          const SizedBox(height: 16),
          DsField(
            label: 'Day of the month',
            child: TextField(
              controller: _day,
              keyboardType: TextInputType.number,
              style: kNum.copyWith(fontSize: 15),
              decoration: const InputDecoration(hintText: '15'),
            ),
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
  String? _error;

  /// Who pays the user back for it, each with their part as typed. Names
  /// come from this period's status, which carries them.
  late final List<_ShareRow> _shares = [
    for (final share in widget.commitment?.shares ?? const <CommitmentShare>[])
      _ShareRow(
        contactId: share.contactId,
        name: widget.commitment!.shareStatus.where((s) => s.contactId == share.contactId).firstOrNull?.name ?? 'Someone',
        amount: TextEditingController(text: (share.amountMinor / 100).toStringAsFixed(share.amountMinor % 100 == 0 ? 0 : 2)),
      ),
  ];

  @override
  void dispose() {
    _name.dispose();
    _amount.dispose();
    _day.dispose();
    _merchant.dispose();
    for (final share in _shares) {
      share.amount.dispose();
    }
    super.dispose();
  }

  int get _amountMinor => parseRupees(_amount.text) ?? 0;
  int get _othersMinor => _shares.fold(0, (sum, share) => sum + (parseRupees(share.amount.text) ?? 0));

  Future<void> _addPeople() async {
    final picked = await showPeoplePicker(
      context,
      exclude: _shares.map((share) => share.contactId).toSet(),
      title: 'Who pays you back for it?',
    );
    if (picked == null || picked.isEmpty || !mounted) return;
    setState(() {
      for (final contact in picked) {
        _shares.add(_ShareRow(contactId: contact.id, name: contact.name, amount: TextEditingController()));
      }
    });
  }

  Future<void> _save() async {
    final rupees = double.tryParse(_amount.text.trim());
    if (_name.text.trim().isEmpty || rupees == null) return;
    if (_shares.any((share) => (parseRupees(share.amount.text) ?? 0) <= 0)) {
      return setState(() => _error = "Type each person's part, or take them off.");
    }
    if (_othersMinor > _amountMinor) {
      return setState(() => _error = 'They pay back ${formatMoney(_othersMinor)}, more than the ${formatMoney(_amountMinor)} it comes to.');
    }

    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);

    final body = {
      'name': _name.text.trim(),
      'amountMinor': (rupees * 100).round(),
      'dayOfMonth': int.tryParse(_day.text.trim()) ?? 1,
      'merchant': _merchant.text.trim().isEmpty ? null : _merchant.text.trim(),
      'categoryId': _categoryId,
      'shares': [
        for (final share in _shares) {'contactId': share.contactId, 'amountMinor': parseRupees(share.amount.text) ?? 0},
      ],
    };

    try {
      if (widget.commitment == null) {
        await ApiClient.instance.post('/budget/commitments', body);
      } else {
        await ApiClient.instance.patch('/budget/commitments/${widget.commitment!.id}', body);
      }
      navigator.pop(true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = e is ApiException && !e.message.startsWith('{') ? e.message : "Couldn't save it. Try again.";
        });
      }
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
            DsField(
              label: 'What it is',
              child: TextField(
                controller: _name,
                autofocus: widget.commitment == null,
                decoration: const InputDecoration(hintText: 'Rent'),
              ),
            ),
            const SizedBox(height: 16),
            DsField(
              label: 'Amount a month',
              child: TextField(
                controller: _amount,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                style: kNum.copyWith(fontSize: 15),
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(
                  prefixText: '₹',
                  helperText: 'The whole of what goes out. If others pay you back for it, add them below - only '
                      'your part counts.',
                  helperMaxLines: 3,
                ),
              ),
            ),
            const SizedBox(height: 16),
            _sharesSection(),
            const SizedBox(height: 16),
            DsField(
              label: 'Day of the month',
              child: TextField(
                controller: _day,
                keyboardType: TextInputType.number,
                style: kNum.copyWith(fontSize: 15),
                decoration: const InputDecoration(hintText: '5'),
              ),
            ),
            const SizedBox(height: 16),
            DsField(
              label: 'Usually paid to',
              child: TextField(
                controller: _merchant,
                decoration: const InputDecoration(
                  hintText: 'Landlord',
                  helperText: "As the bank names them. With people paying you back, a payment to them of this amount "
                      'is put down to it and split by itself.',
                  helperMaxLines: 4,
                ),
              ),
            ),
            const SizedBox(height: 16),
            DsField(
              label: 'Usual category',
              child: DropdownButtonFormField<String?>(
                initialValue: _categoryId,
                isExpanded: true,
                icon: DsIcon(DsIcons.chevronDown, size: 20, color: context.c.tx2),
                borderRadius: BorderRadius.circular(Ds.rLg),
                dropdownColor: context.c.sf,
                decoration: const InputDecoration(
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

  /// Who pays the user back, each with their part, and what is left as the
  /// user's own.
  Widget _sharesSection() {
    final c = context.c;
    final mine = _amountMinor - _othersMinor;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text('Who pays you back',
                  style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: c.tx2)),
            ),
            TextButton.icon(
              key: const ValueKey('commitment-add-people'),
              onPressed: _saving ? null : _addPeople,
              icon: const DsIcon(DsIcons.plus, size: 16),
              label: const Text('Add'),
            ),
          ],
        ),
        for (final share in _shares)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(share.name,
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 14, color: c.tx)),
                ),
                SizedBox(
                  width: 104,
                  child: TextField(
                    key: ValueKey('commitment-share-${share.contactId}'),
                    controller: share.amount,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    textAlign: TextAlign.right,
                    onChanged: (_) => setState(() => _error = null),
                    style: kNum.copyWith(fontSize: 14),
                    decoration: const InputDecoration(prefixText: '₹', isDense: true),
                  ),
                ),
                IconButton(
                  tooltip: 'Take ${share.name} off',
                  onPressed: () => setState(() {
                    _shares.remove(share);
                    share.amount.dispose();
                  }),
                  icon: DsIcon(DsIcons.x, size: 16, color: c.tx3),
                ),
              ],
            ),
          ),
        Text(
          _shares.isEmpty
              ? 'Nobody - all of it is yours.'
              : mine < 0
                  ? 'They pay back ${formatMoney(-mine)} more than it comes to.'
                  : 'Your part: ${formatMoney(mine)}. Theirs is owed to you each month, on People.',
          style: TextStyle(
            fontSize: 12,
            height: 16 / 12,
            fontWeight: mine < 0 ? FontWeight.w600 : FontWeight.w400,
            color: mine < 0 ? c.crit : c.tx3,
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 8),
          Text(_error!, style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.crit)),
        ],
      ],
    );
  }
}

/// One person paying back for a fixed cost, as the editor holds them.
class _ShareRow {
  final String contactId;
  final String name;
  final TextEditingController amount;

  _ShareRow({required this.contactId, required this.name, required this.amount});
}
