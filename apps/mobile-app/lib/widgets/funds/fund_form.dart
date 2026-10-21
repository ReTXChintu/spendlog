import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../ds/ds.dart';
import '../../utils/format.dart';
import 'fund_text.dart';

/// What the add-fund form (and the SIP and opening editors) hold, as typed,
/// and the checks that turn it into a request body.
///
/// Kept as plain strings, apart from the widgets, so the checks can be
/// tested without a screen. They mirror the server's own (funds.routes.ts)
/// so a mistake is caught before the round trip, in words a person reads.
class FundFormData {
  final bool holdsUnits;
  final String units;
  final String invested;
  final String? asOf;
  final String? firstOn;

  final bool runsSip;
  final String sipAmount;
  final String sipDay;
  final String? sipStart;
  final String? sipEnd;
  final bool sipActive;

  /// Amounts the SIP changed to along the way, after the one it started at.
  final List<SipChangeDraft> sipChanges;

  /// YYYY-MM, months nothing went in.
  final List<String> sipSkips;

  /// Editing a SIP that exists. Its history is then always sent, even
  /// empty, so taking the last change out takes it out on the server too;
  /// a new SIP with no history sends the same body it always did.
  final bool editingSip;

  final String folio;

  const FundFormData({
    this.holdsUnits = false,
    this.units = '',
    this.invested = '',
    this.asOf,
    this.firstOn,
    this.runsSip = false,
    this.sipAmount = '',
    this.sipDay = '',
    this.sipStart,
    this.sipEnd,
    this.sipActive = true,
    this.sipChanges = const [],
    this.sipSkips = const [],
    this.editingSip = false,
    this.folio = '',
  });

  /// Neither section filled: the fund is added bare, to have debits linked.
  bool get isBare => !holdsUnits && !runsSip;

  /// The first problem, or the pieces of the body. [today] is the IST day.
  FundFormCheck check(String today) {
    Map<String, dynamic>? opening;
    Map<String, dynamic>? sip;

    if (holdsUnits) {
      final unitCount = double.tryParse(units.replaceAll(',', '').trim());
      if (unitCount == null || unitCount <= 0) return const FundFormCheck.error('Enter the units you hold.');
      final investedMinor = parseRupees(invested);
      if (investedMinor == null) return const FundFormCheck.error('Enter what those units cost you in all.');
      final day = asOf;
      if (day == null) return const FundFormCheck.error('Pick the date those units are as of.');
      if (day.compareTo(today) > 0) return const FundFormCheck.error("The units can't be as of a future date.");
      if (firstOn != null && firstOn!.compareTo(day) > 0) {
        return const FundFormCheck.error("The first investment can't be after the as-of date.");
      }
      opening = {'units': unitCount, 'investedMinor': investedMinor, 'asOf': day, 'firstOn': firstOn};
    }

    if (runsSip) {
      final amountMinor = parseRupees(sipAmount);
      if (amountMinor == null || amountMinor < 100) return const FundFormCheck.error('Enter the SIP amount.');
      final dayOfMonth = int.tryParse(sipDay.trim());
      if (dayOfMonth == null || dayOfMonth < 1 || dayOfMonth > 31) {
        return const FundFormCheck.error('The SIP day is a date of the month, 1 to 31.');
      }
      final start = sipStart;
      if (start == null) return const FundFormCheck.error('Pick when the SIP started.');
      if (sipEnd != null && sipEnd!.compareTo(start) < 0) {
        return const FundFormCheck.error("The SIP can't end before it starts.");
      }

      // The history, checked as the server checks it (funds.sip.ts).
      final startMonth = start.substring(0, 7);
      final endMonth = sipEnd?.substring(0, 7);
      final steps = <Map<String, dynamic>>[];
      final changedIn = <String>{};
      for (final change in sipChanges) {
        final month = change.month;
        final label = sipMonthLabel(month);
        final changeMinor = parseRupees(change.amount);
        if (changeMinor == null || changeMinor < 100) return FundFormCheck.error('Enter the new amount from $label.');
        if (month.compareTo(startMonth) <= 0) {
          return FundFormCheck.error('$label is when the SIP started. Change the amount above instead.');
        }
        if (endMonth != null && month.compareTo(endMonth) > 0) {
          return FundFormCheck.error("The amount can't change after the SIP ends ($label).");
        }
        if (!changedIn.add(month)) return FundFormCheck.error('Two changes from $label. Keep one.');
        steps.add({
          'fromOn': '$month-01',
          'amountMinor': changeMinor,
          if (change.dayOfMonth != null) 'dayOfMonth': change.dayOfMonth,
        });
      }
      steps.sort((a, b) => (a['fromOn'] as String).compareTo(b['fromOn'] as String));
      final skips = [...sipSkips]..sort();
      for (final month in skips) {
        if (month.compareTo(startMonth) < 0 || (endMonth != null && month.compareTo(endMonth) > 0)) {
          return FundFormCheck.error('${sipMonthLabel(month)} is outside the SIP. Skipped months fall while it ran.');
        }
      }

      sip = {
        'amountMinor': amountMinor,
        'dayOfMonth': dayOfMonth,
        'startOn': start,
        'endOn': sipEnd,
        'active': sipActive,
        if (editingSip || steps.isNotEmpty) 'steps': steps,
        if (editingSip || skips.isNotEmpty) 'skips': skips,
      };
    }

    final folioText = folio.trim();
    if (folioText.length > 40) return const FundFormCheck.error('A folio number is at most 40 characters.');

    return FundFormCheck(opening: opening, sip: sip, folio: folioText.isEmpty ? null : folioText);
  }
}

/// An amount the SIP changed to, from a month on, as typed.
class SipChangeDraft {
  /// YYYY-MM.
  final String month;
  final String amount;

  /// The SIP day from then, when a stored change moved it; carried through
  /// an edit untouched.
  final int? dayOfMonth;

  const SipChangeDraft({required this.month, this.amount = '', this.dayOfMonth});
}

class FundFormCheck {
  final String? error;
  final Map<String, dynamic>? opening;
  final Map<String, dynamic>? sip;
  final String? folio;

  const FundFormCheck({this.opening, this.sip, this.folio}) : error = null;
  const FundFormCheck.error(String this.error)
      : opening = null,
        sip = null,
        folio = null;

  bool get ok => error == null;

  /// `POST /funds/holdings`.
  Map<String, dynamic> createBody(int schemeCode) => {
        'schemeCode': schemeCode,
        if (folio != null) 'folio': folio,
        if (sip != null) 'sip': sip,
        if (opening != null) 'opening': opening,
      };
}

/// The controllers behind the form's text fields, and its dates.
class FundFormFields {
  FundFormFields({FundSip? sip, FundOpening? opening, String? folio})
      : holdsUnits = opening != null,
        units = TextEditingController(text: opening == null ? '' : _plain(opening.units)),
        invested = TextEditingController(text: opening == null ? '' : _rupees(opening.investedMinor)),
        asOf = opening?.asOf ?? istToday(),
        firstOn = opening?.firstOn,
        runsSip = sip != null,
        sipAmount = TextEditingController(text: sip == null ? '' : _rupees(sip.history.first.amountMinor)),
        sipDay = TextEditingController(text: sip?.dayOfMonth.toString() ?? ''),
        sipStart = sip?.startOn,
        sipEnd = sip?.endOn,
        sipActive = sip?.active ?? true,
        sipChanges = [
          for (final step in sip?.history.skip(1) ?? const <FundSipStep>[])
            SipChangeFields(month: step.month, amount: _rupees(step.amountMinor), dayOfMonth: step.dayOfMonth),
        ],
        sipSkips = [...?sip?.skips],
        editingSip = sip != null,
        folio = TextEditingController(text: folio ?? '');

  bool holdsUnits;
  final TextEditingController units;
  final TextEditingController invested;
  String? asOf;
  String? firstOn;

  bool runsSip;
  final TextEditingController sipAmount;
  final TextEditingController sipDay;
  String? sipStart;
  String? sipEnd;
  bool sipActive;
  final List<SipChangeFields> sipChanges;
  final List<String> sipSkips;
  final bool editingSip;

  final TextEditingController folio;

  /// A new change, a month after the last one (or the start).
  void addChange() {
    final after = sipChanges.isNotEmpty ? sipChanges.last.month : (sipStart ?? istToday()).substring(0, 7);
    sipChanges.add(SipChangeFields(month: shiftSipMonth(after, 1)));
  }

  void removeChange(SipChangeFields change) {
    sipChanges.remove(change);
    change.dispose();
  }

  static String _rupees(int minor) => minor % 100 == 0 ? (minor ~/ 100).toString() : (minor / 100).toStringAsFixed(2);
  static String _plain(double value) =>
      value == value.roundToDouble() ? value.toInt().toString() : value.toStringAsFixed(3).replaceFirst(RegExp(r'0+$'), '');

  FundFormData get data => FundFormData(
        holdsUnits: holdsUnits,
        units: units.text,
        invested: invested.text,
        asOf: asOf,
        firstOn: firstOn,
        runsSip: runsSip,
        sipAmount: sipAmount.text,
        sipDay: sipDay.text,
        sipStart: sipStart,
        sipEnd: sipEnd,
        sipActive: sipActive,
        sipChanges: [
          for (final change in sipChanges)
            SipChangeDraft(month: change.month, amount: change.amount.text, dayOfMonth: change.dayOfMonth),
        ],
        sipSkips: sipSkips,
        editingSip: editingSip,
        folio: folio.text,
      );

  void dispose() {
    units.dispose();
    invested.dispose();
    sipAmount.dispose();
    sipDay.dispose();
    for (final change in sipChanges) {
      change.dispose();
    }
    folio.dispose();
  }
}

/// One change of amount on the form: the month, and the amount from then.
class SipChangeFields {
  SipChangeFields({required this.month, String amount = '', this.dayOfMonth})
      : amount = TextEditingController(text: amount);

  String month;
  final TextEditingController amount;
  final int? dayOfMonth;

  void dispose() => amount.dispose();
}

/// A date picker over plain YYYY-MM-DD days.
Future<String?> pickIsoDate(
  BuildContext context, {
  String? initial,
  required DateTime first,
  required DateTime last,
}) async {
  final start = DateTime.tryParse(initial ?? '') ?? DateTime.parse(istToday());
  final clamped = start.isBefore(first) ? first : (start.isAfter(last) ? last : start);
  final picked = await showDatePicker(context: context, initialDate: clamped, firstDate: first, lastDate: last);
  return picked == null ? null : isoDay(picked);
}

DateTime get _todayDate => DateTime.parse(istToday());

/// A month picker: a year with arrows, and its twelve months. Months
/// outside [first]..[last] (YYYY-MM) can't be picked. Pops YYYY-MM.
Future<String?> pickMonth(
  BuildContext context, {
  required String title,
  String? initial,
  required String first,
  required String last,
}) {
  final start = initial ?? istToday().substring(0, 7);
  final clamped = start.compareTo(first) < 0 ? first : (start.compareTo(last) > 0 ? last : start);
  var year = int.parse(clamped.substring(0, 4));
  final firstYear = int.parse(first.substring(0, 4));
  final lastYear = int.parse(last.substring(0, 4));
  return showDialog<String>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) {
        final c = context.c;
        return AlertDialog(
          insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
          title: Text(title),
          content: SizedBox(
            width: double.maxFinite,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    IconButton(
                      tooltip: 'Previous year',
                      onPressed: year > firstYear ? () => setState(() => year -= 1) : null,
                      icon: DsIcon(DsIcons.chevronLeft, color: year > firstYear ? c.tx2 : c.ln2),
                    ),
                    Expanded(
                      child: Text(
                        '$year',
                        textAlign: TextAlign.center,
                        style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Next year',
                      onPressed: year < lastYear ? () => setState(() => year += 1) : null,
                      icon: DsIcon(DsIcons.chevronRight, color: year < lastYear ? c.tx2 : c.ln2),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  alignment: WrapAlignment.center,
                  children: [
                    for (var m = 1; m <= 12; m++)
                      Builder(builder: (context) {
                        final month = '$year-${m.toString().padLeft(2, '0')}';
                        final allowed = month.compareTo(first) >= 0 && month.compareTo(last) <= 0;
                        final chosen = month == clamped;
                        final cell = RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rMd));
                        return SizedBox(
                          width: 64,
                          child: chosen
                              ? FilledButton(
                                  key: ValueKey('pick-month-$month'),
                                  style: FilledButton.styleFrom(
                                    padding: EdgeInsets.zero,
                                    minimumSize: const Size(0, 40),
                                    shape: cell,
                                    backgroundColor: c.tx,
                                    foregroundColor: c.bg,
                                    textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 13, fontWeight: FontWeight.w600),
                                  ),
                                  onPressed: allowed ? () => Navigator.of(context).pop(month) : null,
                                  child: Text(sipMonthLabel(month, withYear: false)),
                                )
                              : OutlinedButton(
                                  key: ValueKey('pick-month-$month'),
                                  style: OutlinedButton.styleFrom(
                                    padding: EdgeInsets.zero,
                                    minimumSize: const Size(0, 40),
                                    shape: cell,
                                    textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 13, fontWeight: FontWeight.w500),
                                  ),
                                  onPressed: allowed ? () => Navigator.of(context).pop(month) : null,
                                  child: Text(sipMonthLabel(month, withYear: false)),
                                ),
                        );
                      }),
                  ],
                ),
              ],
            ),
          ),
          actions: [TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel'))],
        );
      },
    ),
  );
}

/// A row that shows a month and opens the month picker.
class MonthField extends StatelessWidget {
  const MonthField({super.key, required this.label, required this.month, required this.onPick});

  final String label;

  /// YYYY-MM.
  final String month;
  final VoidCallback onPick;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return DsField(
      label: label,
      child: InkWell(
        onTap: onPick,
        borderRadius: BorderRadius.circular(Ds.rMd),
        child: InputDecorator(
          decoration: InputDecoration(suffixIcon: DsIcon(DsIcons.chevronDown, size: 20, color: c.tx2)),
          child: Text(sipMonthLabel(month), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15, color: c.tx)),
        ),
      ),
    );
  }
}

/// A text field with its label above it (§7.2).
class LabelledField extends StatelessWidget {
  const LabelledField({
    super.key,
    required this.label,
    required this.controller,
    this.fieldKey,
    this.hint,
    this.prefix,
    this.keyboardType,
  });

  final String label;
  final TextEditingController controller;
  final Key? fieldKey;
  final String? hint;
  final String? prefix;
  final TextInputType? keyboardType;

  @override
  Widget build(BuildContext context) => DsField(
        label: label,
        child: TextField(
          key: fieldKey,
          controller: controller,
          keyboardType: keyboardType,
          style: kNum.copyWith(fontSize: 15, color: context.c.tx),
          decoration: InputDecoration(hintText: hint, prefixText: prefix),
        ),
      );
}

/// A row that shows a date and opens the picker, with an optional clear.
class DateField extends StatelessWidget {
  const DateField({
    super.key,
    required this.label,
    required this.value,
    required this.onPick,
    this.onClear,
    this.placeholder = 'Pick a date',
  });

  final String label;
  final String? value;
  final VoidCallback onPick;
  final VoidCallback? onClear;
  final String placeholder;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return DsField(
      label: label,
      child: InkWell(
        onTap: onPick,
        borderRadius: BorderRadius.circular(Ds.rMd),
        child: InputDecorator(
          decoration: InputDecoration(
            suffixIcon: value != null && onClear != null
                ? IconButton(tooltip: 'Clear', icon: DsIcon(DsIcons.x, size: 18, color: c.tx2), onPressed: onClear)
                : DsIcon(DsIcons.calendar, size: 20, color: c.tx2),
          ),
          child: Text(
            value == null ? placeholder : formatIsoLongDate(value!),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: kNum.copyWith(fontSize: 15, color: value == null ? c.tx3 : c.tx),
          ),
        ),
      ),
    );
  }
}

/// A section of the form with a switch on its header: "I run a SIP".
class ToggleSection extends StatelessWidget {
  const ToggleSection({
    super.key,
    required this.title,
    required this.subtitle,
    required this.on,
    required this.onChanged,
    required this.child,
    this.icon,
  });

  final String title;
  final String subtitle;
  final bool on;

  /// Null keeps it on - an editor for just this one section.
  final ValueChanged<bool>? onChanged;
  final Widget child;

  /// A [DsGlyph] or a Material [IconData].
  final Object? icon;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      decoration: BoxDecoration(
        color: c.sf,
        border: Border.all(color: c.ln),
        borderRadius: BorderRadius.circular(Ds.rXl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: onChanged == null ? null : () => onChanged!(!on),
            borderRadius: BorderRadius.circular(Ds.rXl),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 14, 10, 14),
              child: Row(
                children: [
                  if (icon != null) ...[
                    DsIconTile(icon!, tone: on ? DsTone.ac : DsTone.neutral),
                    const SizedBox(width: 12),
                  ],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title, style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx)),
                        const SizedBox(height: 2),
                        Text(subtitle, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3)),
                      ],
                    ),
                  ),
                  if (onChanged != null) ...[const SizedBox(width: 8), Switch(value: on, onChanged: onChanged)],
                ],
              ),
            ),
          ),
          if (on) ...[
            Divider(height: 1, color: c.ln),
            Padding(padding: const EdgeInsets.fromLTRB(16, 16, 16, 16), child: child),
          ],
        ],
      ),
    );
  }
}

/// Units held, what they cost, as of when, and since when.
class OpeningFields extends StatelessWidget {
  const OpeningFields({super.key, required this.fields, required this.onChanged});

  final FundFormFields fields;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: LabelledField(
                fieldKey: const ValueKey('opening-units'),
                label: 'Units',
                controller: fields.units,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                hint: '1234.567',
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: LabelledField(
                fieldKey: const ValueKey('opening-invested'),
                label: 'Amount invested',
                controller: fields.invested,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                prefix: '₹ ',
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        DateField(
          label: 'As of',
          value: fields.asOf,
          onPick: () async {
            final picked = await pickIsoDate(context, initial: fields.asOf, first: DateTime(1990), last: _todayDate);
            if (picked != null) {
              fields.asOf = picked;
              onChanged();
            }
          },
        ),
        const SizedBox(height: 14),
        DateField(
          label: 'First invested on (optional)',
          value: fields.firstOn,
          placeholder: 'Not sure? Leave it',
          onClear: () {
            fields.firstOn = null;
            onChanged();
          },
          onPick: () async {
            final last = DateTime.tryParse(fields.asOf ?? '') ?? _todayDate;
            final picked = await pickIsoDate(context, initial: fields.firstOn ?? fields.asOf, first: DateTime(1990), last: last);
            if (picked != null) {
              fields.firstOn = picked;
              onChanged();
            }
          },
        ),
        const SizedBox(height: 8),
        Text(
          'Copy these off your statement or the fund app. The first date makes the yearly return (XIRR) '
          'honest about how long the money has been in.',
          style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
        ),
      ],
    );
  }
}

/// A SIP: how much, which day, since when, until when.
class SipFields extends StatelessWidget {
  const SipFields({super.key, required this.fields, required this.onChanged, this.showActive = false});

  final FundFormFields fields;
  final VoidCallback onChanged;

  /// Editing one that exists: it can be stopped.
  final bool showActive;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              flex: 3,
              child: LabelledField(
                fieldKey: const ValueKey('sip-amount'),
                label: 'Each month',
                controller: fields.sipAmount,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                prefix: '₹ ',
                hint: '5000',
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              flex: 2,
              child: LabelledField(
                fieldKey: const ValueKey('sip-day'),
                label: 'On day',
                controller: fields.sipDay,
                keyboardType: TextInputType.number,
                hint: '5',
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        DateField(
          label: 'Started on',
          value: fields.sipStart,
          onPick: () async {
            final today = _todayDate;
            final picked = await pickIsoDate(
              context,
              initial: fields.sipStart,
              first: DateTime(1990),
              last: DateTime(today.year + 1, today.month, today.day),
            );
            if (picked != null) {
              fields.sipStart = picked;
              onChanged();
            }
          },
        ),
        const SizedBox(height: 14),
        DateField(
          label: 'Ends on (optional)',
          value: fields.sipEnd,
          placeholder: 'Runs until you stop it',
          onClear: () {
            fields.sipEnd = null;
            onChanged();
          },
          onPick: () async {
            final first = DateTime.tryParse(fields.sipStart ?? '') ?? DateTime(1990);
            final picked = await pickIsoDate(context, initial: fields.sipEnd, first: first, last: DateTime(2100));
            if (picked != null) {
              fields.sipEnd = picked;
              onChanged();
            }
          },
        ),
        if (showActive) ...[
          const SizedBox(height: 4),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: fields.sipActive,
            onChanged: (value) {
              fields.sipActive = value;
              onChanged();
            },
            title: Text('Still running', style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx)),
            subtitle: Text(
              'Turn off when you stop the SIP. Instalments up to today stay.',
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
          ),
        ],
        const SizedBox(height: 16),
        SipHistoryFields(fields: fields, onChanged: onChanged),
        const SizedBox(height: 10),
        Text(
          "Each month's instalment is bought at that day's NAV. Link the bank debits too, and they replace the "
          'scheduled ones at what was really paid.',
          style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
        ),
      ],
    );
  }
}

/// The SIP's history on the form: amounts it changed to, and months it
/// skipped. Empty by default - one amount needs nothing here - so someone
/// entering an old SIP can describe it all in one go, and no one else has
/// to look at it.
class SipHistoryFields extends StatelessWidget {
  const SipHistoryFields({super.key, required this.fields, required this.onChanged});

  final FundFormFields fields;
  final VoidCallback onChanged;

  String get _startMonth => (fields.sipStart ?? istToday()).substring(0, 7);

  /// The last month a change or skip can name: the end, or a year from now.
  String get _lastMonth => fields.sipEnd?.substring(0, 7) ?? shiftSipMonth(istToday().substring(0, 7), 12);

  Future<void> _pickChangeMonth(BuildContext context, SipChangeFields change) async {
    final first = shiftSipMonth(_startMonth, 1);
    if (first.compareTo(_lastMonth) > 0) return;
    final picked = await pickMonth(context, title: 'Amount changed from', initial: change.month, first: first, last: _lastMonth);
    if (picked != null) {
      change.month = picked;
      onChanged();
    }
  }

  Future<void> _addSkip(BuildContext context) async {
    final latest = fields.sipSkips.isEmpty ? istToday().substring(0, 7) : ([...fields.sipSkips]..sort()).last;
    final picked = await pickMonth(context, title: 'Skipped a month', initial: latest, first: _startMonth, last: _lastMonth);
    if (picked != null && !fields.sipSkips.contains(picked)) {
      fields.sipSkips
        ..add(picked)
        ..sort();
      onChanged();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Changes along the way',
          style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
        ),
        const SizedBox(height: 2),
        Text(
          'Raised or lowered the amount, or missed a month? Add it and every figure counts it.',
          style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
        ),
        for (final (i, change) in fields.sipChanges.indexed) ...[
          const SizedBox(height: 12),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: MonthField(
                  key: ValueKey('sip-change-month-$i'),
                  label: 'From',
                  month: change.month,
                  onPick: () => _pickChangeMonth(context, change),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: LabelledField(
                  fieldKey: ValueKey('sip-change-amount-$i'),
                  label: 'New amount',
                  controller: change.amount,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  prefix: '₹ ',
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(bottom: 2),
                child: IconButton(
                  tooltip: 'Remove this change',
                  icon: DsIcon(DsIcons.x, size: 18, color: c.tx3),
                  onPressed: () {
                    fields.removeChange(change);
                    onChanged();
                  },
                ),
              ),
            ],
          ),
        ],
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            for (final month in fields.sipSkips)
              InputChip(
                label: Text('Skipped ${sipMonthLabel(month)}'),
                deleteIcon: DsIcon(DsIcons.x, size: 14, color: c.tx2),
                onDeleted: () {
                  fields.sipSkips.remove(month);
                  onChanged();
                },
                deleteButtonTooltipMessage: 'Not skipped',
              ),
            ActionChip(
              key: const ValueKey('sip-add-change'),
              avatar: DsIcon(DsIcons.plus, size: 16, color: c.ac),
              label: const Text('Amount changed from…'),
              onPressed: () {
                fields.addChange();
                onChanged();
              },
            ),
            ActionChip(
              key: const ValueKey('sip-add-skip'),
              avatar: DsIcon(DsIcons.plus, size: 16, color: c.ac),
              label: const Text('Skipped a month'),
              onPressed: () => _addSkip(context),
            ),
          ],
        ),
      ],
    );
  }
}
