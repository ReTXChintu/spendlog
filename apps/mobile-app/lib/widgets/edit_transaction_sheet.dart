import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../utils/split.dart';
import 'emi_sheet.dart';
import 'person_picker_sheet.dart';
import 'raw_message_sheet.dart';
import 'refund_sheet.dart';

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
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.c.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
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
  String? _loanId;

  /// On a split: whether the user is one of the heads. Off is money lent.
  late bool _includeMe;

  /// On a split: typing each person's part rather than sharing equally.
  bool _custom = false;

  /// On settling up: whether the parts are still the even split. Typing
  /// one by hand stops the others being redone under it.
  bool _autoSettle = true;

  /// On a trip, an expense is everyone's unless it says otherwise. The only
  /// narrowing worth a control is "this one was just mine".
  late bool _tripJustMine;

  /// Who else it was for or from - shared by split and settling up, so
  /// switching between the two keeps the people already picked.
  final List<_Person> _people = [];

  /// Once the user has typed a merchant in this sheet it is theirs, and no
  /// automatic fill (transfer, person) may replace it.
  bool _merchantTyped = false;

  /// The last "Transfer to …" this sheet wrote, so changing the account
  /// can rewrite its own suggestion without touching anything else.
  String? _autoMerchant;

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
    _loanId = t?.loanId;
    _tripJustMine = t?.tripShareWith?.isNotEmpty ?? false;
    _showMore = _tripJustMine;

    // One kind wins, in the order the server itself would weigh them.
    _kind = switch (t) {
      null => _Kind.normal,
      _ when t.isSettlement => _Kind.settlement,
      _ when t.isTransfer => _Kind.transfer,
      _ when t.type == 'DEBIT' && t.cardPaymentFor != null => _Kind.cardBill,
      _ when t.type == 'DEBIT' && t.loanId != null => _Kind.loan,
      _ when t.split != null => _Kind.split,
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

  /// Active loans, plus whichever this payment already claims - a closed
  /// loan should not vanish from its own dropdown.
  Future<void> _loadLoans() async {
    try {
      final result = await ApiClient.instance.get('/loans') as List<dynamic>;
      if (!mounted) return;
      final all = result.map((l) => Loan.fromJson(l as Map<String, dynamic>)).toList();
      setState(
        () => _loans = all.where((loan) => loan.status == 'ACTIVE' || loan.id == _loanId).toList(),
      );
    } catch (_) {
      // The chip simply does not appear.
    }
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
      _tripJustMine = type == 'DEBIT' && _tripJustMine;
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
    _loanId = null;
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
      case _Kind.loan when _loanId == null:
        return _fail('Pick which loan this repays.');
      default:
        break;
    }
    if (_isDebit && _isFixed && _commitmentId == null) {
      return _fail('Pick which fixed cost this went towards, or turn Fixed cost off.');
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
    };
    // Fields only the edit route takes. On a new row they go in a second
    // call straight after, or a card bill added by hand would quietly
    // forget which card it paid.
    final editOnly = <String, dynamic>{
      'isSpecial': !_isDebit && _isSpecial,
      'isSalary': !_isDebit && _kind == _Kind.salary,
      'cardPaymentFor': _isDebit && _kind == _Kind.cardBill ? _cardPaymentFor : null,
      'commitmentId': _isDebit && _isFixed ? _commitmentId : null,
      'loanId': _isDebit && _kind == _Kind.loan ? _loanId : null,
      // Narrowed to the payer alone, or widened back to everyone on the trip.
      if (widget.transaction?.tripId != null)
        'tripShareWith': _tripJustMine ? [widget.transaction!.userId] : null,
    };

    final navigator = Navigator.of(context);
    try {
      if (_isNew) {
        final created = await ApiClient.instance.post('/transactions', {...body, 'currency': 'INR'})
            as Map<String, dynamic>;
        final id = created['id'] as String;
        final needsEdit = editOnly.entries.any((e) => e.value != null && e.value != false);
        if (needsEdit) await ApiClient.instance.patch('/transactions/$id', editOnly);
        // A refund needs a row to point from, so its purchases are picked
        // the moment it exists.
        if (_kind == _Kind.refund && mounted) {
          await showRefundSheet(context, refund: Transaction.fromJson(created));
        }
      } else {
        await ApiClient.instance.patch('/transactions/${widget.transaction!.id}', {...body, ...editOnly});
      }
      navigator.pop(true);
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

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final tone = _isDebit ? c.debit : c.credit;

    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 38,
                height: 4,
                decoration: BoxDecoration(color: c.lineStrong, borderRadius: BorderRadius.circular(100)),
              ),
            ),
            const SizedBox(height: 12),

            // Title and direction share one line: direction is the first
            // thing to get right, and it does not need a row of its own.
            Row(
              children: [
                Expanded(
                  child: Text(
                    _isNew ? 'Add transaction' : 'Edit transaction',
                    style: TextStyle(fontWeight: FontWeight.w800, fontSize: 17, color: c.ink),
                  ),
                ),
                _directionToggle(),
              ],
            ),
            const SizedBox(height: 12),

            _amountField(tone),
            if (_cardWarning != null) ...[const SizedBox(height: 8), _cardWarningBanner()],
            const SizedBox(height: 12),

            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  flex: 11,
                  child: TextField(
                    controller: _merchant,
                    textCapitalization: TextCapitalization.words,
                    onChanged: (_) => setState(() => _merchantTyped = true),
                    style: TextStyle(color: c.ink, fontSize: 14),
                    decoration: _inputDecoration(context, label: _isDebit ? 'Paid to' : 'From'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(flex: 10, child: _categoryPicker()),
              ],
            ),
            _personRow(),
            _presetRow(),
            const SizedBox(height: 10),

            Row(
              children: [
                Expanded(
                  child: _PickerButton(
                    icon: Icons.calendar_today_outlined,
                    label: DateFormat('EEE, d MMM yyyy').format(_occurredAt),
                    onTap: _pickDate,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: _PickerButton(
                    icon: Icons.schedule,
                    label: TimeOfDay.fromDateTime(_occurredAt).format(context),
                    onTap: _pickTime,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),

            // A transfer has two sides; everything else has one account.
            if (_kind == _Kind.transfer)
              Row(
                children: [
                  Expanded(child: _accountPicker(label: 'From', value: _fromId, onChanged: _setFrom,
                      rowSide: _isDebit)),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: Icon(Icons.arrow_forward, size: 16, color: c.muted),
                  ),
                  Expanded(child: _accountPicker(label: 'To', value: _toId, onChanged: _setTo,
                      rowSide: !_isDebit)),
                ],
              )
            else
              _accountPicker(
                label: 'Account',
                value: _accountId,
                onChanged: (id) => setState(() => _accountId = id),
                rowSide: true,
              ),
            const SizedBox(height: 10),

            TextField(
              controller: _note,
              style: TextStyle(color: c.ink, fontSize: 14),
              decoration: _inputDecoration(context, label: 'Note (optional)'),
            ),
            const SizedBox(height: 16),

            _kindPicker(),
            AnimatedSize(
              duration: const Duration(milliseconds: 180),
              alignment: Alignment.topCenter,
              child: _kindPanel() ?? const SizedBox(width: double.infinity),
            ),

            _moreSection(),

            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: TextStyle(fontSize: 12.5, color: c.debit)),
            ],

            const SizedBox(height: 12),
            Row(
              children: [
                if (!_isNew)
                  TextButton.icon(
                    onPressed: _saving
                        ? null
                        : () => _confirmDelete ? _delete() : setState(() => _confirmDelete = true),
                    style: TextButton.styleFrom(foregroundColor: c.debit),
                    icon: const Icon(Icons.delete_outline, size: 18),
                    label: Text(_confirmDelete ? 'Really delete?' : 'Delete'),
                  ),
                const Spacer(),
                TextButton(
                  onPressed: _saving ? null : () => Navigator.of(context).pop(false),
                  style: TextButton.styleFrom(foregroundColor: c.muted),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _saving ? null : _save,
                  child: Text(_saving ? 'Saving…' : (_isNew ? 'Add' : 'Save')),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _directionToggle() {
    final c = context.c;
    final on = _isDebit ? c.debit : c.credit;
    final onBg = _isDebit ? c.debit50 : c.credit50;
    return SegmentedButton<String>(
      segments: const [
        ButtonSegment(
          value: 'DEBIT',
          label: Text('Debit'),
          icon: Icon(Icons.north_east, size: 14),
          tooltip: 'Money out',
        ),
        ButtonSegment(
          value: 'CREDIT',
          label: Text('Credit'),
          icon: Icon(Icons.south_west, size: 14),
          tooltip: 'Money in',
        ),
      ],
      selected: {_type},
      showSelectedIcon: false,
      onSelectionChanged: (selected) => _setType(selected.first),
      style: ButtonStyle(
        visualDensity: VisualDensity.compact,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 10)),
        textStyle: const WidgetStatePropertyAll(TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
        side: WidgetStatePropertyAll(BorderSide(color: c.lineStrong)),
        backgroundColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? onBg : c.surface,
        ),
        foregroundColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected) ? on : c.muted,
        ),
      ),
    );
  }

  Widget _amountField(Color tone) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: _isDebit ? c.debit50 : c.credit50,
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Row(
        children: [
          Text(
            _isDebit ? '−₹' : '+₹',
            style: kNum.copyWith(fontSize: 26, fontWeight: FontWeight.w800, color: tone),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: TextField(
              controller: _amount,
              autofocus: _isNew,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              onChanged: (_) => setState(() {
                if (_kind == _Kind.settlement && _autoSettle) _resplitSettlement();
              }),
              style: kNum.copyWith(fontSize: 30, fontWeight: FontWeight.w800, color: c.ink),
              decoration: InputDecoration.collapsed(
                hintText: '0.00',
                hintStyle: kNum.copyWith(fontSize: 30, fontWeight: FontWeight.w800, color: c.mutedLight),
              ),
            ),
          ),
          Text(
            _isDebit ? 'money out' : 'money in',
            style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: tone),
          ),
        ],
      ),
    );
  }

  Widget _cardWarningBanner() {
    final c = context.c;
    final card = _cardWarning!;
    final over = card.state == 'over';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: over ? c.debit50 : c.warnBg,
        borderRadius: BorderRadius.circular(T.rSm),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline, size: 15, color: over ? c.debit : c.warn),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              cardCreditWarning(card),
              style: TextStyle(fontSize: 12, height: 1.4, color: over ? c.debit : c.warn),
            ),
          ),
        ],
      ),
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
      decoration: _inputDecoration(context, label: 'Category'),
      dropdownColor: c.surface,
      style: TextStyle(fontSize: 14, color: c.ink),
      items: [
        const DropdownMenuItem<String?>(value: null, child: Text('Uncategorized')),
        for (final category in options)
          DropdownMenuItem<String?>(
            value: category.id,
            child: Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: category.color != null ? parseHexColor(category.color) : c.lineStrong,
                    borderRadius: BorderRadius.circular(2),
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
    final shown = rowSide ? (value ?? _cashId) : value;
    return DropdownButtonFormField<String?>(
      key: ValueKey('$label-$shown-$_type-$_kind'),
      initialValue: shown,
      isExpanded: true,
      hint: Text('Choose', style: TextStyle(color: c.mutedLight)),
      decoration: _inputDecoration(context, label: label),
      dropdownColor: c.surface,
      style: TextStyle(fontSize: 14, color: c.ink),
      items: [
        for (final (id, name) in choices)
          DropdownMenuItem<String?>(
            value: id,
            child: Row(
              children: [
                Icon(
                  name == 'Cash' ? Icons.payments_outlined : Icons.account_balance_wallet_outlined,
                  size: 16,
                  color: c.muted,
                ),
                const SizedBox(width: 8),
                Expanded(child: Text(name, overflow: TextOverflow.ellipsis)),
              ],
            ),
          ),
      ],
      onChanged: onChanged,
    );
  }

  /// The people a typed merchant could be: names starting with it first,
  /// then any containing it. Picking one makes it money between the user
  /// and them - see [_pickPerson].
  Widget _personRow() {
    final c = context.c;
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
                padding: const EdgeInsets.only(right: 6),
                child: ActionChip(
                  avatar: Icon(Icons.person_outline, size: 15, color: c.brandDark),
                  label: Text(contact.name),
                  labelStyle: TextStyle(fontSize: 11.5, color: c.ink, fontWeight: FontWeight.w600),
                  visualDensity: VisualDensity.compact,
                  side: BorderSide(color: contact.id == picked ? c.brand : c.lineStrong),
                  backgroundColor: contact.id == picked ? c.brand50 : c.surface,
                  tooltip: 'Money between you and ${contact.name} - not spending or income',
                  onPressed: () => _pickPerson(contact),
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
                padding: const EdgeInsets.only(right: 6),
                child: _PresetChip(
                  preset: preset,
                  isCurrent: preset.merchant.toLowerCase() == typed.toLowerCase(),
                  onTap: () => _applyPreset(preset),
                  onRemove: () => _removePreset(preset),
                ),
              ),
            if (canSave)
              ActionChip(
                avatar: Icon(Icons.bookmark_add_outlined, size: 15, color: c.brand),
                label: const Text('Save as a shortcut'),
                labelStyle: TextStyle(fontSize: 11.5, color: c.brand, fontWeight: FontWeight.w600),
                visualDensity: VisualDensity.compact,
                side: BorderSide(color: c.brand100),
                backgroundColor: c.surface,
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
    final hasLoans = _loans.isNotEmpty || _loanId != null;
    final hasCommitments = _commitments.isNotEmpty || _commitmentId != null;

    // (label, icon, selected, onTap)
    final options = <(String, IconData, bool, VoidCallback)>[
      if (_isDebit) ...[
        ('Spending', Icons.shopping_bag_outlined, _kind == _Kind.normal, () => _selectKind(_Kind.normal)),
        ('Split', Icons.call_split, _kind == _Kind.split && _includeMe, () => _selectKind(_Kind.split)),
        ('Lent', Icons.handshake_outlined, _isLend, () => _selectKind(_Kind.split, includeMe: false)),
        ('To own account', Icons.swap_horiz, _kind == _Kind.transfer, () => _selectKind(_Kind.transfer)),
        if (hasCards)
          ('Card bill', Icons.credit_card, _kind == _Kind.cardBill, () => _selectKind(_Kind.cardBill)),
        if (hasLoans)
          ('Loan repayment', Icons.account_balance_outlined, _kind == _Kind.loan,
              () => _selectKind(_Kind.loan)),
        ('Settling up', Icons.replay, _kind == _Kind.settlement, () => _selectKind(_Kind.settlement)),
      ] else ...[
        ('Income', Icons.south_west, _kind == _Kind.normal, () => _selectKind(_Kind.normal)),
        ('Salary', Icons.work_outline, _kind == _Kind.salary, () => _selectKind(_Kind.salary)),
        ('Refund…', Icons.undo, _kind == _Kind.refund, () => _selectKind(_Kind.refund)),
        ('For a future purchase', Icons.savings_outlined, _kind == _Kind.earmark,
            () => _selectKind(_Kind.earmark)),
        ('From own account', Icons.swap_horiz, _kind == _Kind.transfer, () => _selectKind(_Kind.transfer)),
        ('Paid back', Icons.replay, _kind == _Kind.settlement, () => _selectKind(_Kind.settlement)),
        ("Part someone else's", Icons.call_split, _kind == _Kind.split,
            () => _selectKind(_Kind.split, includeMe: _includeMe)),
      ],
    ];

    Widget toggle(String label, IconData icon, bool on, ValueChanged<bool> onChanged) => FilterChip(
          avatar: on ? null : Icon(icon, size: 15, color: c.muted),
          label: Text(label),
          selected: on,
          onSelected: onChanged,
          visualDensity: VisualDensity.compact,
          labelStyle: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: on ? c.brandDark : c.ink70),
          selectedColor: c.brand50,
          checkmarkColor: c.brandDark,
          backgroundColor: c.surface,
          side: BorderSide(color: on ? c.brand : c.line),
        );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('What kind is it?', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: c.muted)),
        const SizedBox(height: 6),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: [
              for (final (label, icon, selected, onTap) in options)
                Padding(
                  key: selected ? _selectedChipKey : null,
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(
                    avatar: Icon(icon, size: 15, color: selected ? c.brandDark : c.muted),
                    label: Text(label),
                    selected: selected,
                    showCheckmark: false,
                    onSelected: (_) => onTap(),
                    visualDensity: VisualDensity.compact,
                    labelStyle: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: selected ? c.brandDark : c.ink70,
                    ),
                    selectedColor: c.brand50,
                    backgroundColor: c.surface,
                    side: BorderSide(color: selected ? c.brand : c.lineStrong),
                  ),
                ),
            ],
          ),
        ),
        // These sit on top of whatever kind it is - rent can be split and
        // a fixed cost. A payment has no one-off toggle: one-offs count
        // against the monthly budget like everything else.
        if (!_isDebit || hasCommitments) ...[
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text('Also:', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: c.mutedLight)),
              if (_isDebit)
                toggle('Fixed cost', Icons.event_repeat, _isFixed, (on) => setState(() => _isFixed = on))
              else
                toggle('Keep out of savings bucket', Icons.savings_outlined, _isSpecial,
                    (on) => setState(() => _isSpecial = on)),
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
        ),
      _Kind.cardBill => _cardBillPanel(),
      _Kind.loan => _loanPanel(),
      _Kind.salary => const _Hint(
          'Starts the spending period here, and uses this amount rather than the one in Settings.',
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

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: c.paper,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < parts.length; i++) ...[
            if (i > 0) Divider(height: 20, color: c.line),
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
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: c.ink)),
            ),
            Text('Include me', style: TextStyle(fontSize: 12, color: c.ink70)),
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
        const SizedBox(height: 4),
        Row(
          children: [
            SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: false, label: Text('Equal')),
                ButtonSegment(value: true, label: Text('Custom')),
              ],
              selected: {_custom},
              showSelectedIcon: false,
              onSelectionChanged: (selected) => _setCustom(selected.first),
              style: const ButtonStyle(
                visualDensity: VisualDensity.compact,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                textStyle: WidgetStatePropertyAll(TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
              ),
            ),
            const Spacer(),
            TextButton.icon(
              onPressed: _saving ? null : _addPeople,
              icon: const Icon(Icons.person_add_alt, size: 16),
              label: const Text('Add people'),
            ),
          ],
        ),
        const SizedBox(height: 6),
        if (_includeMe)
          _ShareRow(
            leading: CircleAvatar(
              radius: 13,
              backgroundColor: c.brand,
              child: Text('Me', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w800, color: c.surface)),
            ),
            name: 'My share',
            amount: _custom && _people.isEmpty
                ? _AmountBox(controller: _myShareManual, onChanged: () => setState(() {}))
                : _AmountText(result.myShareMinor, strong: true),
          ),
        for (var i = 0; i < _people.length; i++)
          _ShareRow(
            leading: PersonAvatar(name: _people[i].name, radius: 13),
            name: _people[i].name,
            onRemove: () => _removePerson(_people[i]),
            amount: _custom
                ? _AmountBox(controller: _people[i].amount, onChanged: () => setState(() {}))
                : _AmountText(result.owedMinor[i]),
          ),
        if (_people.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Text(
              _includeMe
                  ? 'Add who it was shared with from your contacts - each gets a running balance. '
                      'Or just type your share.'
                  : 'Add who you lent it to - their balance goes up by their part.',
              style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
            ),
          ),
        if (_custom && _people.isNotEmpty && !_includeMe && result.myShareMinor > 0)
          Text(
            "${formatMoney(result.myShareMinor)} isn't put down to anyone - it counts as yours.",
            style: TextStyle(fontSize: 11.5, color: c.warn),
          ),
        if (result.isOver)
          Text(
            'The parts add up to ${formatMoney(result.overByMinor)} more than the total.',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.debit),
          )
        else
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(_owedHint(result.myShareMinor),
                style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted)),
          ),
        const SizedBox(height: 10),
        TextField(
          controller: _groupLabel,
          style: TextStyle(color: c.ink, fontSize: 13.5),
          decoration: _inputDecoration(
            context,
            label: 'What for (optional)',
            hint: _isDebit ? 'Goa trip' : 'Roommate reimbursement',
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
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: c.ink)),
            ),
            TextButton.icon(
              onPressed: _saving ? null : _addPeople,
              icon: const Icon(Icons.person_add_alt, size: 16),
              label: const Text('Add people'),
            ),
          ],
        ),
        Text(
          _isDebit
              ? 'For bills already recorded - this squares your balance with them.'
              : 'Money back for bills already recorded - not counted as income.',
          style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
        ),
        const SizedBox(height: 6),
        for (final person in _people)
          _ShareRow(
            leading: PersonAvatar(name: person.name, radius: 13),
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
          Text(
            over
                ? "${formatMoney(settled)} is more than the ${formatMoney(total)} that moved."
                : '${formatMoney(settled)} of ${formatMoney(total)} put down to people',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: over ? c.debit : (settled == total ? c.credit : c.muted),
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
        DropdownButtonFormField<String?>(
          initialValue: _cardPaymentFor,
          isExpanded: true,
          hint: Text('Which card?', style: TextStyle(color: c.mutedLight)),
          decoration: _inputDecoration(context, label: 'Bill paid for'),
          dropdownColor: c.surface,
          style: TextStyle(fontSize: 14, color: c.ink),
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
        const SizedBox(height: 6),
        const _Hint('Counts as nothing - the purchases on that card were already counted.'),
      ],
    );
  }

  /// A loan has no purchase to keep out of the totals the way an EMI's
  /// does, so this always counts in full - the picker only ever says which
  /// schedule the payment closes off next.
  Widget _loanPanel() {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        DropdownButtonFormField<String?>(
          initialValue: _loans.any((loan) => loan.id == _loanId) ? _loanId : null,
          isExpanded: true,
          hint: Text('Which loan?', style: TextStyle(color: c.mutedLight)),
          decoration: _inputDecoration(context, label: 'Loan'),
          dropdownColor: c.surface,
          style: TextStyle(fontSize: 14, color: c.ink),
          items: [
            for (final loan in _loans)
              DropdownMenuItem<String?>(
                value: loan.id,
                child: Text('${loan.label} - ${loan.paidCount} of ${loan.months} paid',
                    overflow: TextOverflow.ellipsis),
              ),
          ],
          onChanged: (value) => setState(() => _loanId = value),
        ),
        const SizedBox(height: 6),
        const _Hint('Claims whichever instalment is next due, whatever the exact amount here.'),
      ],
    );
  }

  /// Marking the payment rather than ticking a due date is what lets a
  /// bill be paid early, and what makes a part payment tellable from none.
  Widget _fixedPanel() {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        DropdownButtonFormField<String?>(
          initialValue: _commitments.any((x) => x.id == _commitmentId) ? _commitmentId : null,
          isExpanded: true,
          hint: Text('Which fixed cost?', style: TextStyle(color: c.mutedLight)),
          decoration: _inputDecoration(context, label: 'Fixed monthly cost'),
          dropdownColor: c.surface,
          style: TextStyle(fontSize: 14, color: c.ink),
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
        const SizedBox(height: 6),
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
            style: TextStyle(fontSize: 12, height: 1.4, color: c.ink70),
          ),
        ),
        const SizedBox(width: 8),
        OutlinedButton(
          onPressed: _saving ? null : () => _openLinked(() => showRefundSheet(context, refund: t)),
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
    if (t == null || !t.isEarmarked || _isDebit) return const _Hint(explainer);

    final spent = t.refundOf.fold<int>(0, (sum, a) => sum + a.amountMinor);
    final left = (t.amountMinor - spent).clamp(0, t.amountMinor);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(Icons.hourglass_bottom, size: 15, color: c.brandDark),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                spent == 0
                    ? 'Waiting for the purchase - ${formatMoney(t.amountMinor)} set aside.'
                    : '${formatMoney(spent)} spent on purchases, ${formatMoney(left)} still set aside.',
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: c.ink),
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        const _Hint(explainer),
        const SizedBox(height: 6),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            OutlinedButton.icon(
              onPressed: _saving ? null : () => _openLinked(() => showRefundSheet(context, refund: t)),
              icon: const Icon(Icons.link, size: 16),
              label: const Text('What did this pay for?'),
            ),
            TextButton(
              onPressed: _saving ? null : _releaseEarmark,
              child: const Text('No longer needed - count as income'),
            ),
          ],
        ),
      ],
    );
  }

  // ---- More ----------------------------------------------------------

  /// The rare things, out of the way until asked for.
  Widget _moreSection() {
    final c = context.c;
    final t = widget.transaction;
    final items = <Widget>[
      if (t?.tripName != null && _isDebit)
        SwitchListTile(
          value: _tripJustMine,
          onChanged: (on) => setState(() => _tripJustMine = on),
          contentPadding: EdgeInsets.zero,
          dense: true,
          title: Text('Just mine on ${t!.tripName}', style: TextStyle(fontSize: 13, color: c.ink)),
          subtitle: Text('Leave it out of who owes whom on the trip.',
              style: TextStyle(fontSize: 11.5, color: c.muted)),
        ),
      if (t != null && _isDebit && t.type == 'DEBIT' && t.emiPlanId == null)
        _MoreTile(
          icon: Icons.calendar_month_outlined,
          title: 'Convert to EMI',
          subtitle: 'Paid in monthly instalments instead.',
          onTap: _saving ? null : () => _openLinked(() => showEmiSheet(context, transaction: t)),
        ),
      if (t != null && t.emiPlanId != null)
        _MoreTile(
          icon: Icons.calendar_month_outlined,
          title: t.emiRole == 'PARENT' ? 'On an EMI plan' : 'An EMI instalment',
          subtitle: 'Managed from the EMI plan itself.',
        ),
      if (t != null && (t.rawText != null || t.sources.isNotEmpty))
        _MoreTile(
          icon: Icons.sms_outlined,
          title: 'See the original message',
          subtitle: 'What the bank actually said.',
          onTap: () => showRawMessageSheet(context, t),
        ),
      if (t != null && t.wasReportedTwice)
        _MoreTile(
          icon: Icons.call_split,
          title: 'Split back into ${t.sources.length} rows',
          subtitle: 'These messages were merged into one - undo that.',
          onTap: _saving ? null : _unmerge,
        ),
      if (t != null && !t.wasReportedTwice)
        const _MoreTile(
          icon: Icons.merge_type,
          title: 'Merge with another row',
          subtitle: 'Long-press it in the transactions list, then pick the others.',
        ),
    ];
    if (items.isEmpty) return const SizedBox(height: 4);

    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () => setState(() => _showMore = !_showMore),
            borderRadius: BorderRadius.circular(T.rSm),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                children: [
                  Text('More', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: c.muted)),
                  Icon(_showMore ? Icons.expand_less : Icons.expand_more, size: 18, color: c.muted),
                  const SizedBox(width: 6),
                  Expanded(child: Divider(color: c.line)),
                ],
              ),
            ),
          ),
          if (_showMore) ...items,
        ],
      ),
    );
  }
}

InputDecoration _inputDecoration(BuildContext context, {String? label, String? hint}) {
  final c = context.c;
  return InputDecoration(
    labelText: label,
    hintText: hint,
    labelStyle: TextStyle(fontSize: 13, color: c.muted),
    floatingLabelStyle: TextStyle(fontSize: 13, color: c.brandDark, fontWeight: FontWeight.w600),
    hintStyle: TextStyle(color: c.mutedLight),
    isDense: true,
    filled: true,
    fillColor: c.surface,
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(T.rSm),
      borderSide: BorderSide(color: c.lineStrong),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(T.rSm),
      borderSide: BorderSide(color: c.brand),
    ),
  );
}

class _Hint extends StatelessWidget {
  final String text;
  const _Hint(this.text);

  @override
  Widget build(BuildContext context) =>
      Text(text, style: TextStyle(fontSize: 11.5, height: 1.4, color: context.c.muted));
}

/// Date or time, as a compact tappable field.
class _PickerButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  const _PickerButton({required this.icon, required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(T.rSm),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        decoration: BoxDecoration(
          color: c.surface,
          border: Border.all(color: c.lineStrong),
          borderRadius: BorderRadius.circular(T.rSm),
        ),
        child: Row(
          children: [
            Icon(icon, size: 16, color: c.muted),
            const SizedBox(width: 8),
            Expanded(
              child: Text(label,
                  overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13.5, color: c.ink)),
            ),
          ],
        ),
      ),
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
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          leading,
          const SizedBox(width: 10),
          Expanded(
            child: Text(name,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: c.ink)),
          ),
          SizedBox(width: 112, child: Align(alignment: Alignment.centerRight, child: amount)),
          SizedBox(
            width: 32,
            child: onRemove == null
                ? null
                : IconButton(
                    onPressed: onRemove,
                    tooltip: 'Take $name off',
                    padding: EdgeInsets.zero,
                    visualDensity: VisualDensity.compact,
                    icon: Icon(Icons.close, size: 16, color: c.muted),
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
          fontSize: 13.5,
          fontWeight: strong ? FontWeight.w800 : FontWeight.w600,
          color: strong ? context.c.brandDark : context.c.ink,
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
      style: kNum.copyWith(fontSize: 13.5, fontWeight: FontWeight.w700, color: c.ink),
      decoration: _inputDecoration(context, hint: '0.00').copyWith(
        prefixText: '₹ ',
        prefixStyle: TextStyle(color: c.muted, fontWeight: FontWeight.w600),
        contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
      ),
    );
  }
}

class _MoreTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback? onTap;

  const _MoreTile({required this.icon, required this.title, required this.subtitle, this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return ListTile(
      onTap: onTap,
      contentPadding: EdgeInsets.zero,
      dense: true,
      visualDensity: VisualDensity.compact,
      leading: Icon(icon, size: 19, color: onTap == null ? c.mutedLight : c.ink70),
      title: Text(title, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.ink)),
      subtitle: Text(subtitle, style: TextStyle(fontSize: 11.5, color: c.muted)),
      trailing: onTap == null ? null : Icon(Icons.chevron_right, size: 18, color: c.mutedLight),
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

    return GestureDetector(
      onTap: onTap,
      // Removing is deliberately the long press: the tap has to stay the
      // thing you do fifty times, not the one you undo.
      onLongPress: onRemove,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: isCurrent ? c.brand50 : c.surface,
          border: Border.all(color: isCurrent ? c.brand : c.lineStrong),
          borderRadius: BorderRadius.circular(100),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (preset.category?.color != null) ...[
              Container(
                width: 7,
                height: 7,
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
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: isCurrent ? c.brandDark : c.ink70,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
