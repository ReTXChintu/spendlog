import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import 'ds/ds.dart';
import '../utils/format.dart';
import '../utils/loan_tab.dart';
import '../utils/split.dart';
import 'emi_sheet.dart';
import 'person_picker_sheet.dart';
import 'raw_message_sheet.dart';
import 'refund_sheet.dart';
import 'group_picker_sheet.dart';
import 'mirror_share_sheet.dart';

/// Whether a merchant reads like a bank's raw payee rather than a name a
/// person chose: a UPI handle ("9876@ybl") or a shouted reference
/// ("NEFT 0042 HDFC"). Only those get replaced by "Transfer to …" -
/// anything that looks typed by a human is left alone.
bool looksLikeRawPayee(String merchant) {
  final text = merchant.trim();
  if (text.isEmpty) return true;
  if (text.contains('@')) return true;
  return !RegExp('[a-z]').hasMatch(text) && RegExp('[A-Z0-9]').hasMatch(text);
}

/// What the transaction is, beyond which way the money went. Exactly one
/// at a time: each one changes what the money counts as, and two of them
/// at once would contradict each other. Fixed cost and "keep out of
/// savings" layer on top of any of these, so they are toggles instead.
enum _Kind { normal, split, transfer, cardBill, loan, settlement, salary, refund, earmark }

/// One person on a transaction, with their part as it is being typed.
class _Person {
  final String contactId;
  String name;
  final TextEditingController amount;

  _Person({required this.contactId, required this.name, int? amountMinor})
      : amount = TextEditingController(text: amountMinor == null ? '' : _rupees(amountMinor));
}

String _rupees(int minor) => (minor / 100).toStringAsFixed(2);

/// One loan a repayment could go to, with its part as it is being typed.
/// Every loan offered has one, ticked or not, so unticking a loan and
/// ticking it again keeps what was typed for it.
class _LoanPart {
  final String loanId;
  bool picked;
  final TextEditingController amount;

  /// What the loan has owing for this payment's date, from the server's
  /// suggestion. Null until it answers.
  int? dueMinor;

  /// Typed in this sheet, so no suggestion may replace it.
  bool typed = false;

  _LoanPart({required this.loanId, this.picked = false, int? amountMinor})
      : amount = TextEditingController(text: amountMinor == null ? '' : _rupees(amountMinor));
}

/// Full manual edit, and the same form used to add a transaction by hand.
///
/// Parsing gets most of a message right but not all of it, and a wrong
/// amount or direction is worse than none — so every field is editable,
/// including creating a row no message ever produced (cash).
Future<bool?> showEditTransactionSheet(
  BuildContext context, {
  /// null means "create a new one".
  Transaction? transaction,
  required List<Category> categories,
  required List<Account> accounts,
}) {
  // My share of somebody else's group payment: nothing of it is mine to
  // change but the category, and the server would refuse the rest.
  if (transaction?.mirrorOf != null) {
    return showMirrorShareSheet(context, transaction: transaction!, categories: categories);
  }
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.c.sf,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl)),
    ),
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: _EditSheet(
        transaction: transaction,
        categories: categories,
        accounts: accounts,
      ),
    ),
  );
}

/// The same sheet for a row known only by its id - from the passbook, a
/// statement comparison or a to-do, none of which has the row, the
/// categories or the accounts to hand. Fetches the three, then opens.
/// Returns what the sheet returns; null when the row could not be fetched,
/// after saying so.
Future<bool?> showEditTransactionById(BuildContext context, String transactionId) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final results = await Future.wait([
      ApiClient.instance.get('/transactions/$transactionId'),
      ApiClient.instance.get('/categories'),
      ApiClient.instance.get('/accounts'),
    ]);
    if (!context.mounted) return null;
    return await showEditTransactionSheet(
      context,
      transaction: Transaction.fromJson(results[0] as Map<String, dynamic>),
      categories: (results[1] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList(),
      accounts: (results[2] as List<dynamic>).map((a) => Account.fromJson(a as Map<String, dynamic>)).toList(),
    );
  } catch (e) {
    messenger.showSnackBar(
      SnackBar(content: Text(e is ApiException ? e.message : "Couldn't open that transaction.")),
    );
    return null;
  }
}

class _EditSheet extends StatefulWidget {
  final Transaction? transaction;
  final List<Category> categories;
  final List<Account> accounts;

  const _EditSheet({
    required this.transaction,
    required this.categories,
    required this.accounts,
  });

  @override
  State<_EditSheet> createState() => _EditSheetState();
}

class _EditSheetState extends State<_EditSheet> {
  late final TextEditingController _amount;
  late final TextEditingController _merchant;
  late final TextEditingController _note;
  late final TextEditingController _groupLabel;

  /// The user's share typed by hand: only on a split with nobody named,
  /// where there is no list of parts to work it out from.
  late final TextEditingController _myShareManual;

  late String _type;
  late _Kind _kind;
  String? _categoryId;
  String? _accountId;
  String? _transferAccountId;
  late DateTime _occurredAt;

  /// CREDIT only: kept out of the savings bucket. On a DEBIT it no longer
  /// means anything - every payment counts against the monthly budget - so
  /// it is never offered there and always saved as false, which also clears
  /// one left over from when payments had a one-off toggle.
  late bool _isSpecial;
  late bool _isFixed;
  String? _cardPaymentFor;
  String? _commitmentId;

  /// Which loans a repayment goes to and how much to each. See _LoanPart.
  final List<_LoanPart> _loanParts = [];

  /// The loans the payment already repaid when the sheet opened.
  late final List<LoanSplit> _savedLoanSplits;

  /// What each loan has owing for this payment's date; null until the
  /// server answers, and never needed to save.
  LoanSplitSuggestion? _loanSuggestion;

  /// On a split: whether the user is one of the heads. Off is money lent.
  late bool _includeMe;

  /// On a split: typing each person's part rather than sharing equally.
  bool _custom = false;

  /// On settling up: whether the parts are still the even split. Typing
  /// one by hand stops the others being redone under it.
  bool _autoSettle = true;

  /// The group this payment is in, or will be once saved. Nothing goes into
  /// a group by itself: it is picked here, from every active group.
  String? _groupId;
  String? _groupName;

  /// Who it is shared between in the group: everyone equally unless the
  /// user says it was just theirs, or picks who.
  GroupShare _groupShare = GroupShare.everyone;

  /// On [GroupShare.chosen]: the member ids it is shared between.
  final Set<String> _groupChosen = {};

  /// The group's people, for "Choose who" and for knowing which one is the
  /// user. Null until loaded.
  GroupDetail? _groupDetail;

  /// Who else it was for or from - shared by split and settling up, so
  /// switching between the two keeps the people already picked.
  final List<_Person> _people = [];

  /// Once the user has typed a merchant in this sheet it is theirs, and no
  /// automatic fill (transfer, person) may replace it.
  bool _merchantTyped = false;

  /// The last "Transfer to …" this sheet wrote, so changing the account
  /// can rewrite its own suggestion without touching anything else.
  String? _autoMerchant;

  /// Whether the user has chosen an account in this sheet. On a row whose
  /// message named no account, only an actual choice - an account, or
  /// "It was cash" - may say the account is now known; saving an edit to
  /// the merchant must not quietly file it under cash.
  bool _accountPicked = false;

  bool get _unknownAccount => widget.transaction?.accountUnknown == true;

  /// The picker's "nothing chosen yet" on such a row. Never an account id.
  static const _unplacedValue = '__no_account_yet__';

  /// Fetched here rather than threaded through as a prop, because this
  /// sheet opens from several places and only one of them would have
  /// had them to hand.
  List<FixedCommitment> _commitments = [];
  List<Loan> _loans = [];
  List<MerchantPreset> _presets = [];
  List<CardStatus> _cards = [];
  List<Contact> _contacts = [];

  bool _showMore = false;
  bool _saving = false;
  bool _confirmDelete = false;
  String? _error;

  final _selectedChipKey = GlobalKey();

  bool get _isNew => widget.transaction == null;
  bool get _isDebit => _type == 'DEBIT';
  int get _totalMinor => parseRupees(_amount.text) ?? 0;

  /// A payment someone else made: on no account of the user's, and living
  /// in its group for good.
  bool get _offLedger => widget.transaction?.offLedger ?? false;

  /// The row's split is kept by its group - the contacts' shares - for as
  /// long as it stays in one, so the sheet offers the group's split instead.
  bool get _groupKeepsSplit =>
      (widget.transaction?.groupSplit ?? false) && _groupId != null && _isDebit && _kind == _Kind.normal;

  /// Whether the row's split is its group's, whatever kind is picked: the
  /// split chips give way to the group's "Who was it for?".
  bool get _groupOwnsSplit => (widget.transaction?.groupSplit ?? false) && _groupId != null && _isDebit;

  /// The signed-in user's id: the row's owner, or the group's "me".
  String? get _myUserId => widget.transaction?.userId ?? _groupDetail?.me?.id;

  /// Who it is shared between in its group, as the server takes it: null
  /// for everyone, an empty list when it cannot be said yet.
  List<String>? get _groupShareWith => switch (_groupShare) {
        GroupShare.everyone => null,
        GroupShare.justMine => _myUserId == null ? const [] : [_myUserId!],
        GroupShare.chosen => _groupChosen.toList(),
      };

  @override
  void initState() {
    super.initState();
    final t = widget.transaction;
    _amount = TextEditingController(text: t == null ? '' : _rupees(t.amountMinor));
    _merchant = TextEditingController(text: t?.merchant ?? '');
    _note = TextEditingController(text: t?.note ?? '');
    _groupLabel = TextEditingController(text: t?.split?.groupLabel ?? '');
    _type = t?.type ?? 'DEBIT';
    _categoryId = t?.category?.id;
    _accountId = t?.account?.id;
    _transferAccountId = t?.transferAccountId;
    // Held as IST wall-clock while the pickers are open: choosing
    // "11 Sep, 7:21pm" must mean that in India whatever the phone's clock
    // is set to. Converted back to a real instant on save.
    _occurredAt = istWallClock(t?.occurredAt ?? DateTime.now());
    _isSpecial = t?.isSpecial ?? false;
    _cardPaymentFor = t?.cardPaymentFor;
    _commitmentId = t?.commitmentId;
    _isFixed = _commitmentId != null;
    _savedLoanSplits = t != null && t.type == 'DEBIT' ? t.loanSplits : const [];
    for (final split in _savedLoanSplits) {
      _loanParts.add(_LoanPart(loanId: split.loanId, picked: true, amountMinor: split.amountMinor));
    }
    _groupId = t?.groupId;
    _groupName = t?.groupName;
    final shareWith = t?.groupShareWith ?? const <String>[];
    if (shareWith.isEmpty) {
      _groupShare = GroupShare.everyone;
    } else if (shareWith.length == 1 && shareWith.single == t?.userId) {
      _groupShare = GroupShare.justMine;
    } else {
      _groupShare = GroupShare.chosen;
      _groupChosen.addAll(shareWith);
    }

    // One kind wins, in the order the server itself would weigh them.
    _kind = switch (t) {
      null => _Kind.normal,
      _ when t.isSettlement => _Kind.settlement,
      _ when t.isTransfer => _Kind.transfer,
      _ when t.type == 'DEBIT' && t.cardPaymentFor != null => _Kind.cardBill,
      _ when t.type == 'DEBIT' && t.loanSplits.isNotEmpty => _Kind.loan,
      // A split the group keeps is the group's to change, not a split
      // of the user's own.
      _ when t.split != null && !t.groupSplit && !t.offLedger => _Kind.split,
      _ when t.type == 'CREDIT' && t.isEarmarked => _Kind.earmark,
      _ when t.type == 'CREDIT' && t.isSalary => _Kind.salary,
      _ when t.type == 'CREDIT' && t.refundOf.isNotEmpty => _Kind.refund,
      _ => _Kind.normal,
    };

    final myShare = t?.split?.myShareMinor;
    _includeMe = myShare == null || myShare > 0;
    _myShareManual = TextEditingController(text: myShare == null ? '' : _rupees(myShare));

    for (final share in t?.people ?? const <PersonShare>[]) {
      _people.add(_Person(contactId: share.contactId, name: 'Someone', amountMinor: share.amountMinor));
    }
    if (_kind == _Kind.split) {
      // Equal if the saved parts are exactly what equal would give now;
      // anything else was typed, and has to stay as typed.
      final equal = splitEqually(
        totalMinor: t!.amountMinor,
        people: _people.length,
        includeMe: _includeMe,
      );
      final saved = [for (final share in t.people) share.amountMinor];
      _custom = _people.isEmpty ? _includeMe : !listEquals(equal.owedMinor, saved);
    }
    // Parts saved before are the user's own, not an even split to redo.
    _autoSettle = _people.isEmpty;
    _loadContacts();

    _loadCommitments();
    _loadLoans();
    _loadPresets();
    _loadCards();
    if (_groupId != null) _loadGroup(_groupId!);

    WidgetsBinding.instance.addPostFrameCallback((_) => _revealSelectedChip());
  }

  @override
  void dispose() {
    _amount.dispose();
    _merchant.dispose();
    _note.dispose();
    _groupLabel.dispose();
    _myShareManual.dispose();
    for (final person in _people) {
      person.amount.dispose();
    }
    for (final part in _loanParts) {
      part.amount.dispose();
    }
    super.dispose();
  }

  /// The selected kind may sit past the edge of the scrolling row; an edit
  /// should open showing what the transaction already is.
  void _revealSelectedChip() {
    final chip = _selectedChipKey.currentContext;
    if (chip != null && chip.mounted) {
      Scrollable.ensureVisible(chip, alignment: 0.5, duration: const Duration(milliseconds: 200));
    }
  }

  // ---- Loading -------------------------------------------------------

  /// Everyone the user has, for offering as the merchant is typed - and
  /// the names of whoever is already on it, since the transaction only
  /// knows them by id.
  Future<void> _loadContacts() async {
    try {
      final json = await ApiClient.instance.get('/contacts') as Map<String, dynamic>;
      if (!mounted) return;
      final contacts = ContactBalance.fromJson(json).contacts;
      final names = {for (final c in contacts) c.id: c.name};
      setState(() {
        _contacts = contacts;
        for (final person in _people) {
          person.name = names[person.contactId] ?? person.name;
        }
      });
    } catch (_) {
      // "Someone" until the next open, and no people offered.
    }
  }

  Future<void> _loadCards() async {
    try {
      final result = await ApiClient.instance.get('/cards') as List<dynamic>;
      if (!mounted) return;
      setState(() =>
          _cards = result.map((c) => CardStatus.fromJson(c as Map<String, dynamic>)).toList());
    } catch (_) {
      // Advisory only.
    }
  }

  /// The group's people, for "Choose who" and to know which is the user.
  Future<void> _loadGroup(String groupId) async {
    try {
      final json = await ApiClient.instance.get('/groups/$groupId') as Map<String, dynamic>;
      if (!mounted || groupId != _groupId) return;
      setState(() => _groupDetail = GroupDetail.fromJson(json));
    } catch (_) {
      // "Everyone" and "Just mine" still work; "Choose who" waits.
    }
  }

  Future<void> _loadPresets() async {
    try {
      final result = await ApiClient.instance.get('/merchant-presets') as List<dynamic>;
      if (!mounted) return;
      setState(() => _presets =
          result.map((p) => MerchantPreset.fromJson(p as Map<String, dynamic>)).toList());
    } catch (_) {
      // The form works without shortcuts.
    }
  }

  Future<void> _loadCommitments() async {
    try {
      final result = await ApiClient.instance.get('/budget/commitments') as List<dynamic>;
      if (!mounted) return;
      setState(() => _commitments =
          result.map((c) => FixedCommitment.fromJson(c as Map<String, dynamic>)).toList());
    } catch (_) {
      // The chip simply does not appear.
    }
  }

  /// Active loans, plus whichever this payment already repays - a closed
  /// loan should not vanish from its own list.
  Future<void> _loadLoans() async {
    try {
      final result = await ApiClient.instance.get('/loans') as List<dynamic>;
      if (!mounted) return;
      final all = result.map((l) => Loan.fromJson(l as Map<String, dynamic>)).toList();
      final saved = {for (final split in _savedLoanSplits) split.loanId};
      setState(() {
        _loans = all.where((loan) => loan.status == 'ACTIVE' || saved.contains(loan.id)).toList();
        for (final loan in _loans) {
          if (!_loanParts.any((part) => part.loanId == loan.id)) _loanParts.add(_LoanPart(loanId: loan.id));
        }
      });
      if (_kind == _Kind.loan) await _loadLoanSuggestion();
    } catch (_) {
      // The chip simply does not appear.
    }
  }

  /// What each loan has owing around this payment's date, to fill the rows
  /// with. Only fills what nobody has typed or saved: a payment already
  /// split keeps its split, and its unticked rows get their dues as a
  /// starting figure for if they are ticked.
  ///
  /// On a fresh payment, the loans ticked are the one set whose dues add
  /// up to the amount when there is exactly one, and otherwise every loan
  /// with something owing.
  Future<void> _loadLoanSuggestion() async {
    final day = DateFormat('yyyy-MM-dd').format(_occurredAt);
    final own = _isNew ? '' : '&transactionId=${widget.transaction!.id}';
    try {
      final json = await ApiClient.instance
          .get('/loans/split-suggestion?amountMinor=$_totalMinor&on=$day$own') as Map<String, dynamic>;
      if (!mounted) return;
      final suggestion = LoanSplitSuggestion.fromJson(json);
      setState(() {
        _loanSuggestion = suggestion;
        final fresh = _savedLoanSplits.isEmpty && !_loanParts.any((part) => part.typed);
        final match = suggestion.matches.length == 1 ? suggestion.matches.single.toSet() : null;
        for (final due in suggestion.loans) {
          final part = _loanParts.where((part) => part.loanId == due.loanId).firstOrNull;
          if (part == null) continue;
          part.dueMinor = due.dueMinor;
          if (part.typed || (part.picked && _savedLoanSplits.isNotEmpty)) continue;
          if (due.dueMinor > 0) part.amount.text = _rupees(due.dueMinor);
          if (fresh) part.picked = match != null ? match.contains(due.loanId) : due.dueMinor > 0;
        }
      });
    } catch (_) {
      // The rows stay as they are, to be filled by hand.
    }
  }

  List<_LoanPart> get _pickedLoanParts => _loanParts.where((part) => part.picked).toList();

  int get _loanAssignedMinor =>
      _pickedLoanParts.fold(0, (sum, part) => sum + (parseRupees(part.amount.text) ?? 0));

  String _loanLabel(String loanId) =>
      _loans.where((loan) => loan.id == loanId).firstOrNull?.label ?? 'that loan';

  /// Every loan with something owing, ticked, at what it owes.
  void _fillLoanDues() {
    setState(() {
      _error = null;
      for (final part in _loanParts) {
        final due = part.dueMinor;
        if (due == null || due <= 0) continue;
        part.picked = true;
        part.typed = true;
        part.amount.text = _rupees(due);
      }
    });
  }

  /// The whole payment shared equally between the loans ticked.
  void _splitLoansEvenly() {
    final picked = _pickedLoanParts;
    if (picked.isEmpty) return;
    final parts = splitEvenly(_totalMinor, picked.length);
    setState(() {
      _error = null;
      for (var i = 0; i < picked.length; i++) {
        picked[i].typed = true;
        picked[i].amount.text = _rupees(parts[i]);
      }
    });
  }

  // ---- Accounts ------------------------------------------------------

  /// Cash is an account. When the user has its CASH account, picking Cash
  /// means that one; without it, Cash is simply "no account".
  String? get _cashId =>
      widget.accounts.where((account) => account.accountType == 'CASH').firstOrNull?.id;

  /// Every account a picker offers, Cash first.
  List<(String?, String)> get _accountChoices {
    final cashId = _cashId;
    final choices = <(String?, String)>[(cashId, 'Cash')];
    for (final account in widget.accounts) {
      if (account.id == cashId) continue;
      choices.add((account.id, account.label));
    }
    // An account this row already points at stays pickable even if it is
    // no longer in the list, or the dropdown would have nothing to show.
    for (final id in [_accountId, _transferAccountId]) {
      if (id != null && !choices.any((choice) => choice.$1 == id)) {
        final known = widget.transaction?.account;
        choices.add((id, known?.id == id ? known!.label : 'Another account'));
      }
    }
    return choices;
  }

  String? _accountName(String? id) =>
      _accountChoices.where((choice) => choice.$1 == id).firstOrNull?.$2;

  /// Where the money left from and arrived at, read by direction: the row's
  /// own account is the "from" on a debit and the "to" on a credit.
  String? get _fromId => _isDebit ? _accountId : _transferAccountId;
  String? get _toId => _isDebit ? _transferAccountId : _accountId;

  void _setFrom(String? id) => setState(() {
        if (_isDebit) {
          _accountId = id;
        } else {
          _transferAccountId = id;
        }
        _autoFillTransfer();
      });

  void _setTo(String? id) => setState(() {
        if (_isDebit) {
          _transferAccountId = id;
        } else {
          _accountId = id;
        }
        _autoFillTransfer();
      });

  /// A transfer is always "Transfers", and a bank's "UPI/9876@ybl" says
  /// less than "Transfer to Cash". Never replaces a merchant typed in this
  /// sheet. Called inside setState.
  void _autoFillTransfer() {
    if (_kind != _Kind.transfer) return;
    final transfers = widget.categories.where((c) => c.name == 'Transfers').firstOrNull;
    if (transfers != null) _categoryId = transfers.id;

    final other = _transferAccountId == null ? null : _accountName(_transferAccountId);
    if (other == null || _merchantTyped) return;
    final current = _merchant.text.trim();
    if (current.isEmpty || current == _autoMerchant || looksLikeRawPayee(current)) {
      _merchant.text = _isDebit ? 'Transfer to $other' : 'Transfer from $other';
      _autoMerchant = _merchant.text;
    }
  }

  /// The card this is going on, when 70% or more of its credit limit is
  /// already used.
  CardStatus? get _cardWarning {
    if (_accountId == null) return null;
    for (final card in _cards) {
      if (card.accountId == _accountId && (card.state == 'over' || card.state == 'close')) {
        return card;
      }
    }
    return null;
  }

  List<Account> get _cardAccounts =>
      widget.accounts.where((account) => account.accountType == 'CARD').toList();

  // ---- Kind ----------------------------------------------------------

  /// Money lent: a payment split where none of it was the user's.
  bool get _isLend => _isDebit && _kind == _Kind.split && !_includeMe;

  void _selectKind(_Kind kind, {bool includeMe = true}) {
    setState(() {
      _error = null;
      _kind = kind;
      if (kind == _Kind.split) _includeMe = includeMe;
      if (kind == _Kind.settlement && _autoSettle) _resplitSettlement();
      if (_isLend || kind == _Kind.settlement) _fillFromPerson();
      _autoFillTransfer();
    });
    if (kind == _Kind.loan) _loadLoanSuggestion();
  }

  /// Changing direction has to drop anything the new one cannot mean, or
  /// a category picked as spending stays attached to something that is now
  /// income and quietly lands in the wrong total.
  void _setType(String type) {
    if (type == _type) return;
    setState(() {
      _type = type;
      _error = null;

      final stillValid = categoriesFor(widget.categories, type)
          .any((category) => category.id == _categoryId);
      if (!stillValid) _categoryId = null;

      const debitOnly = {_Kind.cardBill, _Kind.loan};
      const creditOnly = {_Kind.salary, _Kind.refund, _Kind.earmark};
      if ((type == 'CREDIT' && debitOnly.contains(_kind)) ||
          (type == 'DEBIT' && creditOnly.contains(_kind))) {
        _kind = _Kind.normal;
      }
      // "Keep out of savings" is for money in only, so it never carries
      // across to a payment.
      _isSpecial = false;
      _isFixed = false;
      _autoFillTransfer();
    });
  }

  // ---- People --------------------------------------------------------

  /// What a split works out to right now.
  SplitResult get _split {
    final total = _totalMinor;
    if (!_custom) {
      return splitEqually(totalMinor: total, people: _people.length, includeMe: _includeMe);
    }
    if (_people.isEmpty) {
      // Nobody named: the share is whatever was typed, or none at all.
      if (!_includeMe) return const SplitResult(owedMinor: [], myShareMinor: 0);
      final share = parseRupees(_myShareManual.text) ?? total;
      return SplitResult(
        owedMinor: const [],
        myShareMinor: share.clamp(0, total < 0 ? 0 : total),
        overByMinor: share > total ? share - total : 0,
      );
    }
    return splitCustom(
      totalMinor: total,
      owedMinor: [for (final person in _people) parseRupees(person.amount.text) ?? 0],
    );
  }

  int get _settledMinor =>
      _people.fold(0, (sum, person) => sum + (parseRupees(person.amount.text) ?? 0));

  void _resplitSettlement() {
    final parts = splitEvenly(_totalMinor, _people.length);
    for (var i = 0; i < _people.length; i++) {
      _people[i].amount.text = _rupees(parts[i]);
    }
  }

  void _setCustom(bool custom) {
    setState(() {
      if (custom && !_custom) {
        // Start the typed parts from the equal ones, not from blanks.
        final equal = _split;
        for (var i = 0; i < _people.length; i++) {
          _people[i].amount.text = _rupees(equal.owedMinor[i]);
        }
        if (_people.isEmpty) _myShareManual.text = _rupees(equal.myShareMinor);
      }
      _custom = custom;
    });
  }

  Future<void> _addPeople() async {
    final picked = await showPeoplePicker(
      context,
      exclude: _people.map((person) => person.contactId).toSet(),
      title: _peopleTitle,
    );
    if (picked == null || picked.isEmpty || !mounted) return;
    setState(() {
      for (final contact in picked) {
        _people.add(_Person(contactId: contact.id, name: contact.name));
      }
      if (_kind == _Kind.settlement && _autoSettle) _resplitSettlement();
      _fillFromPerson();
    });
  }

  void _removePerson(_Person person) {
    setState(() {
      _people.remove(person);
      person.amount.dispose();
      if (_kind == _Kind.settlement && _autoSettle) _resplitSettlement();
    });
  }

  /// Naming who it was for says what the payment was. Money lent or paid
  /// back went *to that person* - the bank's "UPI/9876@ybl" says nothing
  /// the name does not say better - so those take the first person's name
  /// and the category for money between people. An ordinary split (a
  /// dinner) was paid to the restaurant, so the name only fills an empty
  /// merchant there. Called inside setState.
  void _fillFromPerson() {
    if (_people.isEmpty) return;
    final name = _people.first.name;
    // Still "Someone" while an existing transaction's names load.
    if (name.trim().isEmpty || name == 'Someone') return;

    if (_isLend || _kind == _Kind.settlement) {
      if (!_merchantTyped) _merchant.text = name;
      final lent = categoriesFor(widget.categories, _type)
          .where((category) => category.name == 'Lent & borrowed')
          .firstOrNull;
      if (lent != null) _categoryId = lent.id;
    } else if (_merchant.text.trim().isEmpty) {
      _merchant.text = name;
    }
  }

  String get _peopleTitle => switch (_kind) {
        _Kind.settlement => _isDebit ? 'Who did you pay back?' : 'Who paid you back?',
        _ when _isLend => 'Who did you lend it to?',
        _ => _isDebit ? 'Who was it split with?' : 'Whose money is in this?',
      };

  String? get _lentCategoryId => categoriesFor(widget.categories, _type)
      .where((category) => category.name == 'Lent & borrowed')
      .firstOrNull
      ?.id;

  /// A person picked as the merchant: the money went to them, or came
  /// from them - lent, or paid back, all of it theirs. Never spending or
  /// income, and the server reads a plain row in Lent & borrowed the same
  /// way, so the sheet shows here what will be saved rather than Spending.
  void _pickPerson(Contact contact) {
    setState(() {
      _error = null;
      _merchant.text = contact.name;
      _merchantTyped = true;
      _autoMerchant = null;
      final lent = _lentCategoryId;
      if (lent != null) _categoryId = lent;
      _becomePersonKind(contact);
    });
  }

  /// The one contact a merchant names exactly, as the server matches it.
  Contact? _contactNamed(String name) {
    final wanted = name.trim().toLowerCase();
    if (wanted.isEmpty) return null;
    final matches = _contacts.where((contact) => contact.name.trim().toLowerCase() == wanted).toList();
    return matches.length == 1 ? matches.first : null;
  }

  /// Lent on a payment, paid back on money in, with [contact] (when known)
  /// down for the whole amount. A payment already marked as split, or as
  /// paying someone back, keeps that with the person added. Called inside
  /// setState.
  void _becomePersonKind(Contact? contact) {
    _isSpecial = false;
    _isFixed = false;
    _cardPaymentFor = null;
    bool isOn() => contact != null && _people.any((person) => person.contactId == contact.id);

    if (_isDebit && _kind != _Kind.settlement) {
      final keepSplit = _kind == _Kind.split && _includeMe;
      if (!keepSplit) {
        // Lent to this one person: anyone else on it goes.
        if (contact != null) {
          for (final person in _people.where((person) => person.contactId != contact.id).toList()) {
            _people.remove(person);
            person.amount.dispose();
          }
        }
        _includeMe = false;
        _custom = false;
      }
      if (contact != null && !isOn()) _people.add(_Person(contactId: contact.id, name: contact.name));
      _kind = _Kind.split;
      return;
    }
    if (contact != null && !isOn()) _people.add(_Person(contactId: contact.id, name: contact.name));
    _kind = _Kind.settlement;
    if (_autoSettle) _resplitSettlement();
  }

  /// Filing something plain under Lent & borrowed means it was lent or
  /// paid back - the server will save it so - so the kind follows the
  /// category. Called inside setState.
  void _setCategory(String? id) {
    _categoryId = id;
    if (id != null && id == _lentCategoryId && _kind == _Kind.normal) {
      _becomePersonKind(_contactNamed(_merchant.text));
    }
  }

  // ---- Presets -------------------------------------------------------

  /// Fills the name and its usual category in one go.
  void _applyPreset(MerchantPreset preset) {
    setState(() {
      _merchant.text = preset.merchant;
      _merchantTyped = true;
      if (preset.categoryId != null) _setCategory(preset.categoryId);
    });
    // Ordering only: a shortcut must not wait on a round trip.
    ApiClient.instance.post('/merchant-presets/${preset.id}/used').catchError((_) => null);
  }

  Future<void> _savePreset() async {
    final name = _merchant.text.trim();
    if (name.isEmpty) return;
    try {
      await ApiClient.instance
          .post('/merchant-presets', {'merchant': name, 'categoryId': _categoryId});
      await _loadPresets();
    } catch (_) {
      // A shortcut that failed to save is not worth interrupting the edit.
    }
  }

  void _removePreset(MerchantPreset preset) {
    setState(() => _presets = _presets.where((p) => p.id != preset.id).toList());
    ApiClient.instance.delete('/merchant-presets/${preset.id}').catchError((_) => null);
  }

  /// Picking a fixed cost fills in what it is always paid to and always
  /// counts as. Only fills what is empty: a merchant read off a bank
  /// message is better evidence than a default recorded weeks ago.
  void _pickCommitment(String? id) {
    setState(() {
      _commitmentId = id;
      final picked = _commitments.where((commitment) => commitment.id == id).firstOrNull;
      if (picked == null) return;
      if (_merchant.text.trim().isEmpty && picked.merchant != null) {
        _merchant.text = picked.merchant!;
      }
      _categoryId ??= picked.categoryId;
    });
  }

  // ---- Date ----------------------------------------------------------

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _occurredAt,
      firstDate: DateTime(2000),
      lastDate: DateTime.now().add(const Duration(days: 1)),
    );
    if (picked == null) return;
    setState(() => _occurredAt = DateTime(
          picked.year,
          picked.month,
          picked.day,
          _occurredAt.hour,
          _occurredAt.minute,
        ));
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_occurredAt),
    );
    if (picked == null) return;
    setState(() => _occurredAt = DateTime(
          _occurredAt.year,
          _occurredAt.month,
          _occurredAt.day,
          picked.hour,
          picked.minute,
        ));
  }

  // ---- Save ----------------------------------------------------------

  void _fail(String message) => setState(() => _error = message);

  Future<void> _save() async {
    final total = _totalMinor;
    if (total <= 0) return _fail('Enter an amount greater than zero.');

    final people = <Map<String, dynamic>>[];
    Map<String, dynamic>? split;

    switch (_kind) {
      case _Kind.split:
        final result = _split;
        if (result.isOver) {
          return _fail("The parts add up to ${formatMoney(result.overByMinor)} more than the total.");
        }
        for (var i = 0; i < _people.length; i++) {
          if (result.owedMinor[i] <= 0) {
            return _fail('Give ${_people[i].name} an amount, or take them off.');
          }
          people.add(PersonShare(contactId: _people[i].contactId, amountMinor: result.owedMinor[i])
              .toJson());
        }
        split = {
          'myShareMinor': result.myShareMinor,
          'groupLabel': _groupLabel.text.trim().isEmpty ? null : _groupLabel.text.trim(),
        };
      case _Kind.settlement:
        for (final person in _people) {
          final minor = parseRupees(person.amount.text);
          if (minor == null || minor <= 0) {
            return _fail('Give ${person.name} an amount, or take them off.');
          }
          people.add(PersonShare(contactId: person.contactId, amountMinor: minor).toJson());
        }
        if (_settledMinor > total) {
          return _fail('${formatMoney(_settledMinor)} is put down to people, but the whole thing '
              'was only ${formatMoney(total)}.');
        }
      case _Kind.transfer:
        // The other side may still be blank (older transfers never had
        // one); it only has to differ once it is set.
        if (_transferAccountId != null && _transferAccountId == (_accountId ?? _cashId)) {
          return _fail("Money can't move from an account to itself - pick two different ones.");
        }
      case _Kind.cardBill when _cardPaymentFor == null:
        return _fail('Pick which card this bill was for.');
      case _Kind.loan:
        final picked = _pickedLoanParts;
        if (picked.isEmpty) return _fail('Tick which loans this repays.');
        for (final part in picked) {
          final minor = parseRupees(part.amount.text);
          if (minor == null || minor <= 0) {
            return _fail('Give ${_loanLabel(part.loanId)} an amount, or untick it.');
          }
        }
        if (_loanAssignedMinor > total) {
          return _fail('The loans add up to ${formatMoney(_loanAssignedMinor - total)} more than the payment.');
        }
      default:
        break;
    }
    if (_isDebit && _isFixed && _commitmentId == null) {
      return _fail('Pick which fixed cost this went towards, or turn Fixed cost off.');
    }

    // The group it goes in, and who it is shared between there.
    final groupFields = <String, dynamic>{};
    final hadGroup = widget.transaction?.groupId;
    if (_isDebit) {
      if (_groupId != hadGroup) groupFields['groupId'] = _groupId;
      if (_groupId != null) {
        final shareWith = _groupShareWith;
        if (shareWith != null && shareWith.isEmpty) {
          return _fail(_groupShare == GroupShare.justMine
              ? "Couldn't tell which person in the group is you - try again in a moment."
              : 'Pick at least one person in $_groupName to share it with.');
        }
        groupFields['groupShareWith'] = shareWith;
      }
    } else if (hadGroup != null) {
      // Money in is never group spending.
      groupFields['groupId'] = null;
    }

    setState(() {
      _saving = true;
      _error = null;
    });

    final body = <String, dynamic>{
      'amountMinor': total,
      'type': _type,
      'merchant': _merchant.text.trim().isEmpty ? null : _merchant.text.trim(),
      'note': _note.text.trim().isEmpty ? null : _note.text.trim(),
      'categoryId': _categoryId,
      'accountId': _accountId,
      'occurredAt': fromIstWallClock(_occurredAt).toIso8601String(),
      'isTransfer': _kind == _Kind.transfer,
      'transferAccountId': _kind == _Kind.transfer ? _transferAccountId : null,
      'isEarmarked': !_isDebit && _kind == _Kind.earmark,
      'isSettlement': _kind == _Kind.settlement,
      'split': split,
      // An empty list clears whoever was on it before.
      'people': people,
      // The account is known now: the one picked, or - with none - that
      // it really was cash. The server clears this on its own when an
      // account is set; sending it covers the cash case too.
      if (_unknownAccount && _accountPicked) 'accountUnknown': false,
      ...groupFields,
    };
    // A split the group keeps is worked out by the server from who is in
    // the group; sending one would make it the user's own split instead.
    if (_groupKeepsSplit || _offLedger) {
      body.remove('split');
      body.remove('people');
    }
    // Someone else's money was never on any account of the user's.
    if (_offLedger) body.remove('accountId');
    // Fields only the edit route takes. On a new row they go in a second
    // call straight after, or a card bill added by hand would quietly
    // forget which card it paid.
    final editOnly = <String, dynamic>{
      'isSpecial': !_isDebit && _isSpecial,
      'isSalary': !_isDebit && _kind == _Kind.salary,
      'cardPaymentFor': _isDebit && _kind == _Kind.cardBill ? _cardPaymentFor : null,
      'commitmentId': _isDebit && _isFixed ? _commitmentId : null,
      // Every loan it repays and how much went to each; an empty list takes
      // it off them all. Short of the whole payment is fine - the rest is
      // saved as not put down to any loan yet, and shown as such.
      'loanSplits': _isDebit && _kind == _Kind.loan
          ? [
              for (final part in _pickedLoanParts)
                LoanSplit(loanId: part.loanId, amountMinor: parseRupees(part.amount.text) ?? 0).toJson(),
            ]
          : const <Map<String, dynamic>>[],
    };

    final navigator = Navigator.of(context);
    // Captured now: the sheet is gone by the time there is anything to say.
    final messenger = ScaffoldMessenger.of(context);
    try {
      // What saving a transfer did on the other account - paired with the
      // row already there, or one written in because that bank sent
      // nothing. Said once the sheet is closed, since it is a change the
      // user did not make with their own hands.
      TransferLeg? transferLeg;
      if (_isNew) {
        final created = await ApiClient.instance.post('/transactions', {...body, 'currency': 'INR'})
            as Map<String, dynamic>;
        transferLeg = TransferLeg.maybe(created['transferLeg']);
        final id = created['id'] as String;
        final needsEdit = editOnly.entries
            .any((e) => e.value != null && e.value != false && !(e.value is List && (e.value as List).isEmpty));
        if (needsEdit) await ApiClient.instance.patch('/transactions/$id', editOnly);
        // A refund needs a row to point from, so its purchases are picked
        // the moment it exists.
        if (_kind == _Kind.refund && mounted) {
          await showRefundSheet(context, refund: Transaction.fromJson(created));
        }
      } else {
        final updated = await ApiClient.instance.patch('/transactions/${widget.transaction!.id}', {...body, ...editOnly});
        if (updated is Map<String, dynamic>) transferLeg = TransferLeg.maybe(updated['transferLeg']);
      }
      navigator.pop(true);
      if (transferLeg != null) {
        messenger.showSnackBar(SnackBar(content: Text(transferLeg.message)));
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        // The server's own sentence when it has one - "only ₹800 of it
        // wasn't yours" says what to fix. A validation dump does not.
        _error = e is ApiException && !e.message.startsWith('{')
            ? e.message
            : "Couldn't save that change.";
        _saving = false;
      });
    }
  }

  /// Runs a one-tap action that closes the sheet when it works.
  Future<void> _act(Future<void> Function() action, String failure) async {
    setState(() => _saving = true);
    try {
      await action();
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e is ApiException ? e.message : failure;
        _saving = false;
      });
    }
  }

  /// More than one message means the row was merged, automatically or by
  /// hand — and either can be wrong, so both can be taken apart.
  Future<void> _unmerge() => _act(
        () => ApiClient.instance.post('/transactions/${widget.transaction!.id}/unmerge'),
        "Couldn't split it apart.",
      );

  Future<void> _delete() => _act(
        () => ApiClient.instance.delete('/transactions/${widget.transaction!.id}'),
        "Couldn't delete it.",
      );

  /// The purchase is never coming: whatever was not spent counts as income.
  Future<void> _releaseEarmark() => _act(
        () => ApiClient.instance.patch('/transactions/${widget.transaction!.id}', {'isEarmarked': false}),
        "Couldn't change that.",
      );

  /// Opens a sheet that links or converts, closing this one if it did.
  Future<void> _openLinked(Future<bool?> Function() open) async {
    final navigator = Navigator.of(context);
    final changed = await open();
    if (changed == true) navigator.pop(true);
  }

  // ---- Build ---------------------------------------------------------

  /// Not counted either way: moved between own accounts, a card bill, or
  /// money set aside. Drawn in tx3 with no sign, like everywhere else.
  bool get _neutralKind => _kind == _Kind.transfer || _kind == _Kind.cardBill || _kind == _Kind.earmark;

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    // The side panel of the web editor, as a full-height sheet: a header,
    // the form scrolling, and the actions pinned to the bottom.
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DsDragHandle(),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 4, 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    _isNew ? 'Add transaction' : 'Edit transaction',
                    style: TextStyle(fontSize: 19, height: 24 / 19, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                ),
                IconButton(
                  tooltip: 'Close',
                  onPressed: _saving ? null : () => Navigator.of(context).pop(false),
                  icon: DsIcon(DsIcons.x, size: 20, color: c.tx2),
                ),
              ],
            ),
          ),
          Divider(height: 1, color: c.ln),
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 20),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _amountField(),
                  if (_cardWarning != null) ...[const SizedBox(height: 12), _cardWarningBanner()],
                  const SizedBox(height: 18),

                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        flex: 11,
                        child: DsField(
                          label: _isDebit ? 'Paid to' : 'From',
                          child: TextField(
                            controller: _merchant,
                            textCapitalization: TextCapitalization.words,
                            onChanged: (_) => setState(() => _merchantTyped = true),
                            style: TextStyle(color: c.tx, fontSize: 15),
                            decoration: _inputDecoration(context),
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(flex: 10, child: DsField(label: 'Category', child: _categoryPicker())),
                    ],
                  ),
                  if (!_offLedger) _personRow(),
                  _presetRow(),
                  const SizedBox(height: 18),

                  // Someone else's payment is only ever spending: what kind
                  // of money it was is not the user's to say.
                  if (!_offLedger) ...[
                    _kindPicker(),
                    AnimatedSize(
                      duration: Ds.dur,
                      curve: Ds.ease,
                      alignment: Alignment.topCenter,
                      child: _kindPanel() ?? const SizedBox(width: double.infinity),
                    ),
                    const SizedBox(height: 18),
                  ],

                  // Someone else paid: no account of the user's to pick.
                  if (_offLedger)
                    DsCallout(
                      tone: DsTone.ac,
                      icon: DsIcons.users,
                      title: 'Paid by ${widget.transaction?.paidByName ?? 'someone else'} · not on any of your accounts',
                      detail: 'Only your share counts as your spending, and you owe them that much.',
                    )
                  // A transfer has two sides; everything else has one account.
                  else if (_kind == _Kind.transfer)
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Expanded(
                          child: DsField(
                            label: 'From',
                            child: _accountPicker(label: 'From', value: _fromId, onChanged: _setFrom, rowSide: _isDebit),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: DsField(
                            label: 'To',
                            child: _accountPicker(label: 'To', value: _toId, onChanged: _setTo, rowSide: !_isDebit),
                          ),
                        ),
                      ],
                    )
                  else
                    DsField(
                      label: 'Account',
                      child: _accountPicker(
                        label: 'Account',
                        value: _accountId,
                        onChanged: (id) => setState(() => _accountId = id),
                        rowSide: true,
                      ),
                    ),
                  if (_unknownAccount && !_accountPicked)
                    const Padding(
                      padding: EdgeInsets.only(top: 12),
                      child: DsCallout(
                        tone: DsTone.ac,
                        title: 'The message named no account, so this is not in any balance yet. Pick the account it '
                            'was on, or say it was cash.',
                      ),
                    ),
                  const SizedBox(height: 18),

                  const DsLabel('Date & time'),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Expanded(
                        flex: 3,
                        child: _PickerButton(
                          icon: DsIcons.calendar,
                          label: DateFormat('EEE, d MMM yyyy').format(_occurredAt),
                          onTap: _pickDate,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        flex: 2,
                        child: _PickerButton(
                          icon: Icons.schedule,
                          label: TimeOfDay.fromDateTime(_occurredAt).format(context),
                          onTap: _pickTime,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 18),

                  DsField(
                    label: 'Note',
                    child: TextField(
                      controller: _note,
                      style: TextStyle(color: c.tx, fontSize: 15),
                      decoration: _inputDecoration(context, hint: 'Note (optional)'),
                    ),
                  ),

                  _groupSection(),

                  _moreSection(),

                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    DsCallout(tone: DsTone.crit, title: _error!),
                  ],
                ],
              ),
            ),
          ),
          _footer(),
        ],
      ),
    );
  }

  /// Delete on the left, Cancel and Save on the right, on `sf2`.
  Widget _footer() {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      decoration: BoxDecoration(color: c.sf2, border: Border(top: BorderSide(color: c.ln))),
      child: Row(
        children: [
          if (!_isNew)
            OutlinedButton.icon(
              onPressed: _saving
                  ? null
                  : () => _confirmDelete ? _delete() : setState(() => _confirmDelete = true),
              style: OutlinedButton.styleFrom(
                // The final "really" is the filled destructive confirm.
                backgroundColor: _confirmDelete ? c.critFill : Colors.transparent,
                foregroundColor: _confirmDelete ? Colors.white : c.crit,
                side: BorderSide(color: _confirmDelete ? c.critFill : c.critSoft),
                minimumSize: const Size(48, 48),
                padding: const EdgeInsets.symmetric(horizontal: 14),
              ),
              icon: const DsIcon(DsIcons.trash, size: 18),
              label: Text(_confirmDelete ? 'Really delete?' : 'Delete'),
            ),
          const SizedBox(width: 8),
          Expanded(
            child: OverflowBar(
              alignment: MainAxisAlignment.end,
              overflowAlignment: OverflowBarAlignment.end,
              spacing: 8,
              overflowSpacing: 8,
              children: [
                OutlinedButton(
                  onPressed: _saving ? null : () => Navigator.of(context).pop(false),
                  style: OutlinedButton.styleFrom(minimumSize: const Size(64, 48)),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  onPressed: _saving ? null : _save,
                  style: FilledButton.styleFrom(textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 15, fontWeight: FontWeight.w600)),
                  child: Text(_saving ? 'Saving…' : (_isNew ? 'Add' : 'Save')),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// The figure at 34/40, signed the way the list will show it, beside the
  /// Out / In switch.
  Widget _amountField() {
    final c = context.c;
    final signColor = _neutralKind ? c.tx3 : (_isDebit ? c.moneyOut : c.moneyIn);
    final sign = _neutralKind ? '₹' : (_isDebit ? '−₹' : '+₹');
    const big = TextStyle(
      fontSize: 34,
      height: 40 / 34,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.68,
      fontFeatures: Ds.tabular,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Text(sign, style: big.copyWith(color: signColor)),
            const SizedBox(width: 2),
            Expanded(
              child: TextField(
                controller: _amount,
                autofocus: _isNew,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                onChanged: (_) => setState(() {
                  if (_kind == _Kind.settlement && _autoSettle) _resplitSettlement();
                }),
                style: big.copyWith(color: c.tx),
                decoration: InputDecoration.collapsed(
                  hintText: '0.00',
                  hintStyle: big.copyWith(color: c.ln2),
                ),
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(width: 132, child: _directionToggle()),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          _isDebit ? 'Money out' : 'Money in',
          style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
        ),
      ],
    );
  }

  Widget _directionToggle() => DsSegmented<String>(
        segments: const [('DEBIT', 'Out'), ('CREDIT', 'In')],
        selected: _type,
        onChanged: _setType,
        height: 32,
      );

  Widget _cardWarningBanner() {
    final card = _cardWarning!;
    return DsCallout(
      tone: card.state == 'over' ? DsTone.crit : DsTone.warn,
      icon: DsIcons.creditCard,
      title: cardCreditWarning(card),
    );
  }

  Widget _categoryPicker() {
    final c = context.c;
    final options = categoriesFor(widget.categories, _type).toList();
    // A category the row already has stays showable, even if it no longer
    // fits the direction - the dropdown has to be able to show its value.
    var shown = _categoryId;
    if (shown != null && !options.any((category) => category.id == shown)) {
      final known = widget.categories.where((category) => category.id == shown).firstOrNull ??
          (widget.transaction?.category?.id == shown ? widget.transaction!.category : null);
      if (known != null) {
        options.add(known);
      } else {
        shown = null;
      }
    }
    return DropdownButtonFormField<String?>(
      // Keyed on the value so a preset, a transfer or a person picking the
      // category shows up here straight away.
      key: ValueKey('category-$shown'),
      initialValue: shown,
      isExpanded: true,
      icon: DsIcon(DsIcons.chevronDown, size: 20, color: c.tx2),
      decoration: _inputDecoration(context),
      dropdownColor: c.sf,
      borderRadius: BorderRadius.circular(Ds.rLg),
      style: TextStyle(fontFamily: Ds.sans, fontSize: 15, color: c.tx, fontFeatures: Ds.tabular),
      items: [
        const DropdownMenuItem<String?>(value: null, child: Text('Uncategorized')),
        for (final category in options)
          DropdownMenuItem<String?>(
            value: category.id,
            child: Row(
              children: [
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: category.color != null ? parseHexColor(category.color) : c.ln2,
                    borderRadius: BorderRadius.circular(Ds.rXs),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(child: Text(category.name, overflow: TextOverflow.ellipsis)),
              ],
            ),
          ),
      ],
      onChanged: (value) => setState(() => _setCategory(value)),
    );
  }

  /// [rowSide] is whether this picker is the row's own account (which may
  /// be Cash-as-nothing) rather than the other side of a transfer (which
  /// must be a real account).
  Widget _accountPicker({
    required String label,
    required String? value,
    required ValueChanged<String?> onChanged,
    required bool rowSide,
  }) {
    final c = context.c;
    final choices = _accountChoices.where((choice) => rowSide || choice.$1 != null).toList();
    // A row with no known account shows none until one is chosen - Cash
    // would be a guess, and a guess at cash is what accountUnknown exists
    // to avoid. Shown as a value of its own that cannot be picked, since
    // "Cash" may itself be the null value when there is no cash account.
    final unplaced = rowSide && _unknownAccount && !_accountPicked;
    final shown = unplaced ? _unplacedValue : (rowSide ? (value ?? _cashId) : value);
    return DropdownButtonFormField<String?>(
      key: ValueKey('$label-$shown-$_type-$_kind'),
      initialValue: shown,
      isExpanded: true,
      icon: DsIcon(DsIcons.chevronDown, size: 20, color: c.tx2),
      hint: Text('Choose', style: TextStyle(color: c.tx3)),
      decoration: _inputDecoration(context),
      dropdownColor: c.sf,
      borderRadius: BorderRadius.circular(Ds.rLg),
      style: TextStyle(fontFamily: Ds.sans, fontSize: 15, color: c.tx, fontFeatures: Ds.tabular),
      items: [
        if (unplaced)
          DropdownMenuItem<String?>(
            value: _unplacedValue,
            enabled: false,
            child: Row(
              children: [
                DsIcon(DsIcons.info, size: 16, color: c.tx3),
                const SizedBox(width: 8),
                Expanded(child: Text('No account yet', style: TextStyle(color: c.tx3))),
              ],
            ),
          ),
        for (final (id, name) in choices)
          DropdownMenuItem<String?>(
            value: id,
            child: Row(
              children: [
                DsIcon(name == 'Cash' ? DsIcons.banknote : DsIcons.bank, size: 16, color: c.tx3),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    // On the row's own side of a placeless payment, Cash is
                    // an answer rather than a default, and says so.
                    rowSide && _unknownAccount && name == 'Cash' ? 'It was cash' : name,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
      ],
      onChanged: (id) {
        if (id == _unplacedValue) return;
        _accountPicked = true;
        onChanged(id);
      },
    );
  }

  /// The people a typed merchant could be: names starting with it first,
  /// then any containing it. Picking one makes it money between the user
  /// and them - see [_pickPerson].
  Widget _personRow() {
    final typed = _merchant.text.trim().toLowerCase();
    if (typed.isEmpty || _contacts.isEmpty) return const SizedBox.shrink();
    int rank(Contact contact) => contact.name.toLowerCase().startsWith(typed) ? 0 : 1;
    final matches = _contacts.where((contact) => contact.name.toLowerCase().contains(typed)).toList()
      ..sort((a, b) => rank(a) != rank(b) ? rank(a) - rank(b) : a.name.compareTo(b.name));
    if (matches.isEmpty) return const SizedBox.shrink();
    final picked = _kind == _Kind.split || _kind == _Kind.settlement ? _people.firstOrNull?.contactId : null;

    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (final contact in matches.take(4))
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: Tooltip(
                  message: 'Money between you and ${contact.name} - not spending or income',
                  child: DsChip(
                    label: contact.name,
                    icon: DsIcons.users,
                    selected: contact.id == picked,
                    height: 32,
                    onTap: () => _pickPerson(contact),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  /// Shortcuts, small and quiet on one scrolling line: a convenience
  /// rather than the main way to fill the form in.
  Widget _presetRow() {
    final c = context.c;
    final typed = _merchant.text.trim();
    final canSave = typed.isNotEmpty &&
        !_presets.any((preset) => preset.merchant.toLowerCase() == typed.toLowerCase());
    if (_presets.isEmpty && !canSave) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (final preset in _presets)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: _PresetChip(
                  preset: preset,
                  isCurrent: preset.merchant.toLowerCase() == typed.toLowerCase(),
                  onTap: () => _applyPreset(preset),
                  onRemove: () => _removePreset(preset),
                ),
              ),
            if (canSave)
              ActionChip(
                avatar: DsIcon(DsIcons.plus, size: 14, color: c.ac),
                label: const Text('Save as a shortcut'),
                labelStyle: TextStyle(fontSize: 13, color: c.ac, fontWeight: FontWeight.w600),
                visualDensity: VisualDensity.compact,
                side: BorderSide(color: c.acLine),
                backgroundColor: c.sf,
                shape: const StadiumBorder(),
                onPressed: _savePreset,
              ),
          ],
        ),
      ),
    );
  }

  // ---- Kind chips and their panels ------------------------------------

  Widget _kindPicker() {
    final c = context.c;
    final hasCards = _cardAccounts.isNotEmpty || _cardPaymentFor != null;
    final hasLoans = _loans.isNotEmpty || _savedLoanSplits.isNotEmpty;
    final hasCommitments = _commitments.isNotEmpty || _commitmentId != null;

    // (label, selected, onTap). Radio-as-chips: the chosen one is
    // ink-filled with a check, like every selected chip.
    final options = <(String, bool, VoidCallback)>[
      if (_isDebit) ...[
        ('Spending', _kind == _Kind.normal, () => _selectKind(_Kind.normal)),
        // The group keeps this one's split: offered there, not here.
        if (!_groupOwnsSplit) ...[
          ('Split', _kind == _Kind.split && _includeMe, () => _selectKind(_Kind.split)),
          ('Lent', _isLend, () => _selectKind(_Kind.split, includeMe: false)),
        ],
        ('To own account', _kind == _Kind.transfer, () => _selectKind(_Kind.transfer)),
        if (hasCards) ('Card bill', _kind == _Kind.cardBill, () => _selectKind(_Kind.cardBill)),
        if (hasLoans) ('Loan repayment', _kind == _Kind.loan, () => _selectKind(_Kind.loan)),
        ('Settling up', _kind == _Kind.settlement, () => _selectKind(_Kind.settlement)),
      ] else ...[
        ('Income', _kind == _Kind.normal, () => _selectKind(_Kind.normal)),
        ('Salary', _kind == _Kind.salary, () => _selectKind(_Kind.salary)),
        ('Refund…', _kind == _Kind.refund, () => _selectKind(_Kind.refund)),
        ('For a future purchase', _kind == _Kind.earmark, () => _selectKind(_Kind.earmark)),
        ('From own account', _kind == _Kind.transfer, () => _selectKind(_Kind.transfer)),
        ('Paid back', _kind == _Kind.settlement, () => _selectKind(_Kind.settlement)),
        ("Part someone else's", _kind == _Kind.split, () => _selectKind(_Kind.split, includeMe: _includeMe)),
      ],
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const DsLabel('What kind is it?'),
        const SizedBox(height: 6),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          clipBehavior: Clip.none,
          child: Row(
            children: [
              for (final (label, selected, onTap) in options)
                Padding(
                  key: selected ? _selectedChipKey : null,
                  padding: const EdgeInsets.only(right: 8),
                  child: DsChip(label: label, selected: selected, onTap: onTap),
                ),
            ],
          ),
        ),
        // These sit on top of whatever kind it is - rent can be split and
        // a fixed cost. A payment has no one-off toggle: one-offs count
        // against the monthly budget like everything else.
        if (!_isDebit || hasCommitments) ...[
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text('Also', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.tx3)),
              if (_isDebit)
                DsChip(
                  label: 'Fixed cost',
                  icon: DsIcons.repeat,
                  selected: _isFixed,
                  height: 32,
                  onTap: () => setState(() => _isFixed = !_isFixed),
                )
              else
                DsChip(
                  label: 'Keep out of savings bucket',
                  icon: DsIcons.piggyBank,
                  selected: _isSpecial,
                  height: 32,
                  onTap: () => setState(() => _isSpecial = !_isSpecial),
                ),
            ],
          ),
        ],
      ],
    );
  }

  /// Only the selected kind's own controls, plus any toggled extras.
  Widget? _kindPanel() {
    final c = context.c;
    final main = switch (_kind) {
      _Kind.split => _splitPanel(),
      _Kind.settlement => _settlePanel(),
      _Kind.transfer => const _Hint(
          'Moved between your own accounts - left out of spending and income. Cash counts as '
          'an account.',
          info: true,
        ),
      _Kind.cardBill => _cardBillPanel(),
      _Kind.loan => _loanPanel(),
      _Kind.salary => const _Hint(
          'Starts the spending period here, and uses this amount rather than the one in Settings.',
          info: true,
        ),
      _Kind.refund => _refundPanel(),
      _Kind.earmark => _earmarkPanel(),
      _Kind.normal => null,
    };
    final parts = <Widget>[
      if (main != null) main,
      if (_isDebit && _isFixed) _fixedPanel(),
      if (!_isDebit && _isSpecial)
        const _Hint("Kept out of your savings bucket - it won't be counted towards what you save."),
    ];
    if (parts.isEmpty) return null;

    // A lone explainer is an info callout; anything with controls sits in
    // an inner panel on sf2.
    if (parts.length == 1 && parts.single is _Hint && (parts.single as _Hint).info) {
      return Padding(
        padding: const EdgeInsets.only(top: 12),
        child: DsCallout(tone: DsTone.ac, title: (parts.single as _Hint).text),
      );
    }

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.sf2,
        border: Border.all(color: c.ln),
        borderRadius: BorderRadius.circular(Ds.rLg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < parts.length; i++) ...[
            if (i > 0) Divider(height: 24, color: c.ln),
            parts[i],
          ],
        ],
      ),
    );
  }

  /// Says what the split will do, in the same terms the balance uses - but
  /// the terms flip with the direction: on a payment the rest is owed back
  /// to the user, on a credit the rest was already theirs and is not new
  /// income.
  String _owedHint(int myShareMinor) {
    final notMine = _totalMinor - myShareMinor;
    if (_isDebit) {
      if (notMine <= 0) return 'All of it counts as your own spending.';
      return '${formatMoney(notMine)} counts as owed back to you, not as spending.';
    }
    if (notMine <= 0) return 'All of it counts as income.';
    return "${formatMoney(notMine)} doesn't count as income - it's money coming back to you.";
  }

  Widget _splitPanel() {
    final c = context.c;
    final result = _split;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(_peopleTitle,
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx)),
            ),
            Text('Include me', style: TextStyle(fontSize: 13, color: c.tx2)),
            const SizedBox(width: 6),
            Switch(
              value: _includeMe,
              onChanged: (on) => setState(() {
                _includeMe = on;
                // Leaving yourself out is lending: the name says who to.
                if (_isLend) _fillFromPerson();
              }),
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            SizedBox(
              width: 168,
              child: DsSegmented<bool>(
                segments: const [(false, 'Equal'), (true, 'Custom')],
                selected: _custom,
                onChanged: _setCustom,
                height: 32,
              ),
            ),
            const Spacer(),
            TextButton.icon(
              onPressed: _saving ? null : _addPeople,
              icon: const DsIcon(DsIcons.plus, size: 16),
              label: const Text('Add people'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        if (_includeMe)
          _ShareRow(
            leading: const _MeAvatar(),
            name: 'My share',
            amount: _custom && _people.isEmpty
                ? _AmountBox(controller: _myShareManual, onChanged: () => setState(() {}))
                : _AmountText(result.myShareMinor, strong: true),
          ),
        for (var i = 0; i < _people.length; i++)
          _ShareRow(
            leading: PersonAvatar(name: _people[i].name, radius: 14),
            name: _people[i].name,
            onRemove: () => _removePerson(_people[i]),
            amount: _custom
                ? _AmountBox(controller: _people[i].amount, onChanged: () => setState(() {}))
                : _AmountText(result.owedMinor[i]),
          ),
        if (_people.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: _Hint(
              _includeMe
                  ? 'Add who it was shared with from your contacts - each gets a running balance. '
                      'Or just type your share.'
                  : 'Add who you lent it to - their balance goes up by their part.',
            ),
          ),
        if (_custom && _people.isNotEmpty && !_includeMe && result.myShareMinor > 0)
          Text(
            "${formatMoney(result.myShareMinor)} isn't put down to anyone - it counts as yours.",
            style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w500, color: c.warn),
          ),
        if (result.isOver)
          Text(
            'The parts add up to ${formatMoney(result.overByMinor)} more than the total.',
            style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.crit),
          )
        else
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: _Hint(_owedHint(result.myShareMinor)),
          ),
        const SizedBox(height: 12),
        DsField(
          label: 'What for (optional)',
          child: TextField(
            controller: _groupLabel,
            style: TextStyle(color: c.tx, fontSize: 15),
            decoration: _inputDecoration(context, hint: _isDebit ? 'Goa trip' : 'Roommate reimbursement'),
          ),
        ),
      ],
    );
  }

  Widget _settlePanel() {
    final c = context.c;
    final total = _totalMinor;
    final settled = _settledMinor;
    final over = settled > total;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(_peopleTitle,
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx)),
            ),
            TextButton.icon(
              onPressed: _saving ? null : _addPeople,
              icon: const DsIcon(DsIcons.plus, size: 16),
              label: const Text('Add people'),
            ),
          ],
        ),
        _Hint(
          _isDebit
              ? 'For bills already recorded - this squares your balance with them.'
              : 'Money back for bills already recorded - not counted as income.',
        ),
        const SizedBox(height: 8),
        for (final person in _people)
          _ShareRow(
            leading: PersonAvatar(name: person.name, radius: 14),
            name: person.name,
            onRemove: () => _removePerson(person),
            amount: _AmountBox(
              controller: person.amount,
              onChanged: () => setState(() => _autoSettle = false),
            ),
          ),
        if (_people.length > 1 && !_autoSettle)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: () => setState(() {
                _autoSettle = true;
                _resplitSettlement();
              }),
              child: const Text('Split evenly'),
            ),
          ),
        if (_people.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              over
                  ? "${formatMoney(settled)} is more than the ${formatMoney(total)} that moved."
                  : '${formatMoney(settled)} of ${formatMoney(total)} put down to people',
              style: TextStyle(
                fontSize: 12,
                height: 16 / 12,
                fontWeight: FontWeight.w600,
                color: over ? c.crit : (settled == total ? c.good : c.tx3),
                fontFeatures: Ds.tabular,
              ),
            ),
          ),
      ],
    );
  }

  /// A bill payment usually produces one message, from the bank being
  /// debited, with nothing on the card side to pair it with - so the
  /// automatic transfer detection can never find it.
  Widget _cardBillPanel() {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        DsField(
          label: 'Bill paid for',
          child: DropdownButtonFormField<String?>(
            initialValue: _cardPaymentFor,
            isExpanded: true,
            icon: DsIcon(DsIcons.chevronDown, size: 20, color: c.tx2),
            hint: Text('Which card?', style: TextStyle(color: c.tx3)),
            decoration: _inputDecoration(context),
            dropdownColor: c.sf,
            borderRadius: BorderRadius.circular(Ds.rLg),
            style: TextStyle(fontFamily: Ds.sans, fontSize: 15, color: c.tx, fontFeatures: Ds.tabular),
            items: [
              for (final card in _cardAccounts)
                DropdownMenuItem<String?>(
                  value: card.id,
                  child: Text(card.label, overflow: TextOverflow.ellipsis),
                ),
              if (_cardPaymentFor != null && !_cardAccounts.any((card) => card.id == _cardPaymentFor))
                DropdownMenuItem<String?>(value: _cardPaymentFor, child: const Text('A card no longer listed')),
            ],
            onChanged: (value) => setState(() => _cardPaymentFor = value),
          ),
        ),
        const SizedBox(height: 8),
        const _Hint('Counts as nothing - the purchases on that card were already counted.'),
      ],
    );
  }

  /// A loan has no purchase to keep out of the totals the way an EMI's
  /// does, so this always counts in full. One payment often repays several
  /// loans at once: each one it went to is ticked with its share, and what
  /// is left over is saved as not put down to any loan yet - shown, so it
  /// gets sorted out, but never a reason to refuse the save.
  Widget _loanPanel() {
    final c = context.c;
    final total = _totalMinor;
    final assigned = _loanAssignedMinor;
    final rows = [
      for (final loan in _loans)
        if (_loanParts.where((part) => part.loanId == loan.id).firstOrNull case final part?) (loan, part),
    ];
    final hasDues = _loanSuggestion?.loans.any((due) => due.dueMinor > 0) ?? false;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final (loan, part) in rows) _loanRow(loan, part),
        const SizedBox(height: 8),
        Text(
          loanAssignedLine(assignedMinor: assigned, totalMinor: total),
          key: const ValueKey('loan-assigned-line'),
          style: TextStyle(
            fontSize: 13,
            height: 18 / 13,
            fontWeight: FontWeight.w600,
            color: assigned == total ? c.tx2 : c.warn,
            fontFeatures: Ds.tabular,
          ),
        ),
        Wrap(
          spacing: 4,
          children: [
            if (hasDues)
              TextButton(
                onPressed: _fillLoanDues,
                style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 36)),
                child: const Text('Fill dues'),
              ),
            if (_pickedLoanParts.length > 1)
              TextButton(
                onPressed: _splitLoansEvenly,
                style: TextButton.styleFrom(minimumSize: const Size(0, 36)),
                child: const Text('Split evenly'),
              ),
          ],
        ),
        const _Hint("Each loan's share goes into its oldest instalment still owed. More runs on into "
            'the next one; less leaves it part paid.'),
      ],
    );
  }

  /// One loan: whether this payment went to it, how much, and where the
  /// loan stands as things are.
  Widget _loanRow(Loan loan, _LoanPart part) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Checkbox(
            key: ValueKey('loan-pick-${loan.id}'),
            value: part.picked,
            visualDensity: VisualDensity.compact,
            onChanged: (value) => setState(() {
              _error = null;
              part.picked = value ?? false;
            }),
          ),
          const SizedBox(width: 4),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  loan.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
                ),
                Text(
                  loanTabShort(loan.balanceMinor),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    height: 16 / 12,
                    color: loan.balanceMinor < 0 ? c.warn : c.tx3,
                    fontWeight: loan.balanceMinor < 0 ? FontWeight.w500 : FontWeight.w400,
                    fontFeatures: Ds.tabular,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 116,
            child: TextField(
              key: ValueKey('loan-amount-${loan.id}'),
              controller: part.amount,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              textAlign: TextAlign.right,
              style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx),
              decoration: _inputDecoration(context, hint: '0.00', compact: true).copyWith(prefixText: '₹ '),
              // Typing an amount means the payment went there.
              onChanged: (_) => setState(() {
                _error = null;
                part.typed = true;
                part.picked = true;
              }),
            ),
          ),
        ],
      ),
    );
  }

  /// Marking the payment rather than ticking a due date is what lets a
  /// bill be paid early, and what makes a part payment tellable from none.
  Widget _fixedPanel() {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        DsField(
          label: 'Fixed monthly cost',
          child: DropdownButtonFormField<String?>(
            initialValue: _commitments.any((x) => x.id == _commitmentId) ? _commitmentId : null,
            isExpanded: true,
            icon: DsIcon(DsIcons.chevronDown, size: 20, color: c.tx2),
            hint: Text('Which fixed cost?', style: TextStyle(color: c.tx3)),
            decoration: _inputDecoration(context),
            dropdownColor: c.sf,
            borderRadius: BorderRadius.circular(Ds.rLg),
            style: TextStyle(fontFamily: Ds.sans, fontSize: 15, color: c.tx, fontFeatures: Ds.tabular),
            items: [
              for (final commitment in _commitments)
                DropdownMenuItem<String?>(
                  value: commitment.id,
                  child: Text(
                    '${commitment.name} - ${formatMoney(commitment.amountMinor)} a month',
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
            ],
            onChanged: _pickCommitment,
          ),
        ),
        const SizedBox(height: 8),
        const _Hint('Still counts as spending, against your monthly budget like everything else. Sending '
            'less than usual is fine - the dashboard says what went short rather than calling it unpaid.'),
      ],
    );
  }

  Widget _refundPanel() {
    final c = context.c;
    final t = widget.transaction;
    if (t == null) {
      return const _Hint("Once it's added you'll pick which purchases this money came back for.");
    }
    final linked = t.refundOf.fold<int>(0, (sum, a) => sum + a.amountMinor);
    return Row(
      children: [
        Expanded(
          child: Text(
            t.refundOf.isEmpty
                ? 'Not linked to a purchase yet. Linked money stops counting as income.'
                : '${formatMoney(linked)} linked to ${t.refundOf.length} '
                    '${t.refundOf.length == 1 ? 'purchase' : 'purchases'}.',
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2, fontFeatures: Ds.tabular),
          ),
        ),
        const SizedBox(width: 12),
        OutlinedButton(
          onPressed: _saving ? null : () => _openLinked(() => showRefundSheet(context, refund: t)),
          style: OutlinedButton.styleFrom(
            minimumSize: const Size(0, 36),
            padding: const EdgeInsets.symmetric(horizontal: 12),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rMd)),
            textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 13, fontWeight: FontWeight.w600),
          ),
          child: Text(t.refundOf.isEmpty ? 'Pick purchases' : 'Change'),
        ),
      ],
    );
  }

  Widget _earmarkPanel() {
    final c = context.c;
    final t = widget.transaction;
    const explainer = 'Not counted as income. When you buy the thing, link the purchase to this money.';
    // Only once saved as earmarked is there anything to link or release.
    if (t == null || !t.isEarmarked || _isDebit) return const _Hint(explainer, info: true);

    final spent = t.refundOf.fold<int>(0, (sum, a) => sum + a.amountMinor);
    final left = (t.amountMinor - spent).clamp(0, t.amountMinor);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const DsIconTile(DsIcons.piggyBank, tone: DsTone.ac, size: 36),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                spent == 0
                    ? 'Waiting for the purchase - ${formatMoney(t.amountMinor)} set aside.'
                    : '${formatMoney(spent)} spent on purchases, ${formatMoney(left)} still set aside.',
                style: TextStyle(
                  fontSize: 14,
                  height: 20 / 14,
                  fontWeight: FontWeight.w500,
                  color: c.tx,
                  fontFeatures: Ds.tabular,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        const _Hint(explainer),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            OutlinedButton.icon(
              onPressed: _saving ? null : () => _openLinked(() => showRefundSheet(context, refund: t)),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size(0, 36),
                padding: const EdgeInsets.symmetric(horizontal: 12),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rMd)),
                textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 13, fontWeight: FontWeight.w600),
              ),
              icon: const DsIcon(DsIcons.link, size: 16),
              label: const Text('What did this pay for?'),
            ),
            TextButton(
              onPressed: _saving ? null : _releaseEarmark,
              style: TextButton.styleFrom(minimumSize: const Size(0, 36)),
              child: const Text('No longer needed - count as income'),
            ),
          ],
        ),
      ],
    );
  }

  // ---- More ----------------------------------------------------------

  Future<void> _pickGroup() async {
    final group = await showGroupPickerSheet(context, currentId: _groupId);
    if (group == null || !mounted || group.id == _groupId) return;
    setState(() {
      _groupId = group.id;
      _groupName = group.name;
      // Who it was for was said about the group it is leaving.
      _groupShare = GroupShare.everyone;
      _groupChosen.clear();
      _groupDetail = null;
      _error = null;
    });
    await _loadGroup(group.id);
  }

  void _setGroupShare(GroupShare share) => setState(() {
        _groupShare = share;
        _error = null;
        // Choosing starts from everyone, to untick the ones it was not for.
        if (share == GroupShare.chosen && _groupChosen.isEmpty) {
          _groupChosen.addAll(_groupDetail?.everyone.map((m) => m.id) ?? const <String>[]);
        }
      });

  SwitchListTile _switchRow({
    required bool value,
    required ValueChanged<bool> onChanged,
    required String title,
    required String subtitle,
  }) {
    final c = context.c;
    return SwitchListTile(
      value: value,
      onChanged: onChanged,
      contentPadding: EdgeInsets.zero,
      title: Text(title, style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx)),
      subtitle: Text(subtitle, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
    );
  }

  /// The group it is in: picked from every active group, whatever the
  /// payment's date. Shared equally with everyone in it unless the user
  /// says it was just theirs, or picks who.
  Widget _groupSection() {
    final c = context.c;
    final t = widget.transaction;
    // Money in is never group spending; one that somehow is can still be
    // taken out.
    if (!_isDebit && t?.groupId == null) return const SizedBox.shrink();
    final name = _groupName ?? 'the group';
    final detail = _groupDetail;

    return Padding(
      padding: const EdgeInsets.only(top: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DsLabel('Group'),
          if (_offLedger)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: DsCallout(
                tone: DsTone.neutral,
                icon: DsIcons.users,
                title: 'In $name',
                detail: 'A payment someone else made lives in its group. To take it out, delete it.',
              ),
            )
          else if (_groupId == null)
            _MoreTile(
              icon: DsIcons.users,
              title: 'Add to a group',
              subtitle: 'Shared with the people in it - equally, unless you say otherwise.',
              onTap: _saving || !_isDebit ? null : _pickGroup,
            )
          else ...[
            _switchRow(
              value: true,
              // Off takes it out; "Add to a group" is offered again.
              onChanged: (_) => setState(() {
                _groupId = null;
                _groupName = null;
                _groupDetail = null;
                _groupShare = GroupShare.everyone;
                _groupChosen.clear();
              }),
              title: 'On $name',
              subtitle: 'Switch off to take it out of the group.',
            ),
            if (_isDebit)
              _MoreTile(
                icon: DsIcons.transfer,
                title: 'Move to another group',
                subtitle: 'Every active group is offered.',
                onTap: _saving ? null : _pickGroup,
              ),
          ],
          if (_groupId != null && _isDebit) ...[
            const SizedBox(height: 12),
            Text('Who was it for?', style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.tx2)),
            const SizedBox(height: 6),
            DsSegmented<GroupShare>(
              segments: const [
                (GroupShare.everyone, 'Everyone'),
                (GroupShare.justMine, 'Just mine'),
                (GroupShare.chosen, 'Choose who'),
              ],
              selected: _groupShare,
              onChanged: _saving ? null : _setGroupShare,
            ),
            const SizedBox(height: 8),
            if (_groupShare == GroupShare.chosen)
              detail == null
                  ? const DsSkeleton(height: 32)
                  : Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final member in detail.everyone)
                          DsChip(
                            label: member.isMe ? 'Me' : member.name,
                            height: 32,
                            selected: _groupChosen.contains(member.id),
                            onTap: () => setState(() {
                              if (!_groupChosen.remove(member.id)) _groupChosen.add(member.id);
                            }),
                          ),
                      ],
                    ),
            if (_groupShare == GroupShare.chosen) const SizedBox(height: 8),
            _Hint(switch (_groupShare) {
              GroupShare.everyone => "Split equally between everyone in $name. A contact's share is owed to you, "
                  'on the People page.',
              GroupShare.justMine => 'Just mine on $name: left out of who owes whom.',
              GroupShare.chosen => 'Split equally between the people ticked.',
            }),
          ],
        ],
      ),
    );
  }

  /// The rare things, out of the way until asked for.
  Widget _moreSection() {
    final c = context.c;
    final t = widget.transaction;
    final items = <Widget>[
      if (t != null && _isDebit && t.type == 'DEBIT' && t.emiPlanId == null)
        _MoreTile(
          icon: DsIcons.calendar,
          title: 'Convert to EMI',
          subtitle: 'Paid in monthly instalments instead.',
          onTap: _saving ? null : () => _openLinked(() => showEmiSheet(context, transaction: t)),
        ),
      if (t != null && t.emiPlanId != null)
        _MoreTile(
          icon: DsIcons.calendar,
          title: t.emiRole == 'PARENT' ? 'On an EMI plan' : 'An EMI instalment',
          subtitle: 'Managed from the EMI plan itself.',
        ),
      if (t != null && (t.rawText != null || t.sources.isNotEmpty))
        _MoreTile(
          icon: DsIcons.message,
          title: 'See the original message',
          subtitle: 'What the bank actually said.',
          onTap: () => showRawMessageSheet(context, t),
        ),
      if (t != null && t.wasReportedTwice)
        _MoreTile(
          icon: DsIcons.undo,
          title: 'Split back into ${t.sources.length} rows',
          subtitle: 'These messages were merged into one - undo that.',
          onTap: _saving ? null : _unmerge,
        ),
      if (t != null && !t.wasReportedTwice)
        const _MoreTile(
          icon: DsIcons.link,
          title: 'Merge with another row',
          subtitle: 'Long-press it in the transactions list, then pick the others.',
        ),
    ];
    if (items.isEmpty) return const SizedBox(height: 4);

    return Padding(
      padding: const EdgeInsets.only(top: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Semantics(
            button: true,
            expanded: _showMore,
            child: InkWell(
              onTap: () => setState(() => _showMore = !_showMore),
              borderRadius: BorderRadius.circular(Ds.rMd),
              child: Container(
                constraints: const BoxConstraints(minHeight: 40),
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  children: [
                    Text(
                      'More',
                      style: TextStyle(
                        fontSize: 12,
                        height: 16 / 12,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.24,
                        color: c.tx2,
                      ),
                    ),
                    const SizedBox(width: 4),
                    DsIcon(_showMore ? DsIcons.chevronUp : DsIcons.chevronDown, size: 16, color: c.tx2),
                    const SizedBox(width: 8),
                    Expanded(child: Divider(color: c.ln)),
                  ],
                ),
              ),
            ),
          ),
          if (_showMore) ...items,
        ],
      ),
    );
  }
}

/// Inputs take their look from the theme (52 h, radius 10, `ln2`, 2 px
/// `ac` on focus); labels sit above them in a [DsField].
InputDecoration _inputDecoration(BuildContext context, {String? hint, bool compact = false}) {
  return InputDecoration(
    hintText: hint,
    isDense: compact,
    contentPadding: compact ? const EdgeInsets.symmetric(horizontal: 12, vertical: 12) : null,
  );
}

/// An explainer line: 12/17 `tx3`. [info] ones become an info callout
/// when they are all a kind's panel has to say.
class _Hint extends StatelessWidget {
  final String text;
  final bool info;
  const _Hint(this.text, {this.info = false});

  @override
  Widget build(BuildContext context) =>
      Text(text, style: TextStyle(fontSize: 12, height: 17 / 12, color: context.c.tx3));
}

/// Date or time, as a select-styled field: 52 h, radius 10, `ln2` border.
class _PickerButton extends StatelessWidget {
  final Object icon;
  final String label;
  final VoidCallback onTap;

  const _PickerButton({required this.icon, required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Material(
      color: c.sf,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Ds.rMd),
        side: BorderSide(color: c.ln2),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: 52,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Row(
            children: [
              dsIconOf(icon, size: 18, color: c.tx3),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15, color: c.tx, fontFeatures: Ds.tabular),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// "Me" in the split: the user's own avatar, in the accent tint.
class _MeAvatar extends StatelessWidget {
  const _MeAvatar();

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      width: 28,
      height: 28,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: c.acSoft, shape: BoxShape.circle),
      child: Text('Me', style: TextStyle(fontSize: 11, height: 1, fontWeight: FontWeight.w600, color: c.ac)),
    );
  }
}

/// One line of a split or settlement: who, and their part.
class _ShareRow extends StatelessWidget {
  final Widget leading;
  final String name;
  final Widget amount;
  final VoidCallback? onRemove;

  const _ShareRow({required this.leading, required this.name, required this.amount, this.onRemove});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      constraints: const BoxConstraints(minHeight: 48),
      padding: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.ln))),
      child: Row(
        children: [
          leading,
          const SizedBox(width: 12),
          Expanded(
            child: Text(name,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx)),
          ),
          SizedBox(width: 112, child: Align(alignment: Alignment.centerRight, child: amount)),
          SizedBox(
            width: 36,
            child: onRemove == null
                ? null
                : IconButton(
                    onPressed: onRemove,
                    tooltip: 'Take $name off',
                    padding: EdgeInsets.zero,
                    visualDensity: VisualDensity.compact,
                    icon: DsIcon(DsIcons.x, size: 16, color: c.tx3),
                  ),
          ),
        ],
      ),
    );
  }
}

class _AmountText extends StatelessWidget {
  final int minor;
  final bool strong;
  const _AmountText(this.minor, {this.strong = false});

  @override
  Widget build(BuildContext context) => Text(
        formatMoney(minor),
        style: kNum.copyWith(
          fontSize: 14,
          fontWeight: strong ? FontWeight.w600 : FontWeight.w500,
          color: strong ? context.c.tx : context.c.tx2,
        ),
      );
}

class _AmountBox extends StatelessWidget {
  final TextEditingController controller;
  final VoidCallback onChanged;
  const _AmountBox({required this.controller, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return TextField(
      controller: controller,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      textAlign: TextAlign.right,
      onChanged: (_) => onChanged(),
      style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx),
      decoration: _inputDecoration(context, hint: '0.00', compact: true).copyWith(
        prefixText: '₹ ',
        prefixStyle: TextStyle(fontSize: 14, color: c.tx3, fontWeight: FontWeight.w500),
        contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
      ),
    );
  }
}

/// A "More" link row: a 20 px icon, a 14 title over a 12 sub-line, and a
/// chevron when it goes somewhere.
class _MoreTile extends StatelessWidget {
  final Object icon;
  final String title;
  final String subtitle;
  final VoidCallback? onTap;

  const _MoreTile({required this.icon, required this.title, required this.subtitle, this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 56),
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.ln))),
        child: Row(
          children: [
            dsIconOf(icon, size: 20, color: onTap == null ? c.ln2 : c.tx2),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx)),
                  const SizedBox(height: 2),
                  Text(subtitle, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                ],
              ),
            ),
            if (onTap != null) ...[
              const SizedBox(width: 8),
              DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3),
            ],
          ],
        ),
      ),
    );
  }
}

class _PresetChip extends StatelessWidget {
  final MerchantPreset preset;
  final bool isCurrent;
  final VoidCallback onTap;
  final VoidCallback onRemove;

  const _PresetChip({
    required this.preset,
    required this.isCurrent,
    required this.onTap,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    // The quick-pick chip: 32 h pill, ink-filled when it is what the form
    // already says.
    return Material(
      color: isCurrent ? c.tx : c.sf,
      shape: StadiumBorder(side: BorderSide(color: isCurrent ? c.tx : c.ln2)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        // Removing is deliberately the long press: the tap has to stay the
        // thing you do fifty times, not the one you undo.
        onLongPress: onRemove,
        child: Container(
          height: 32,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (preset.category?.color != null) ...[
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: parseHexColor(preset.category!.color),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                const SizedBox(width: 6),
              ],
              Text(
                preset.merchant,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: isCurrent ? c.bg : c.tx,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
