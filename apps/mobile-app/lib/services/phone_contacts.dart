import 'dart:io' show Platform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_contacts/flutter_contacts.dart' as phone;
import '../models/models.dart';
import '../theme.dart';
import 'api_client.dart';

// Adding a person to SpendLog, from the phone's contacts or by name.
//
// The phone's own contact picker does the choosing, so SpendLog is handed
// the one person picked and never reads the address book. On Android the
// picker gives a name without any permission, but the number behind it
// needs READ_CONTACTS - and the number is what stops the same person
// being added twice. So the permission is asked for here, at the moment
// of picking and with the reason given, and saying no still works: the
// person comes back with a name and no number.

/// Saves someone on the server. Picking a number already there gives back
/// the person already there, and says so rather than making a second one.
Future<Contact?> createContact(
  BuildContext context, {
  required String name,
  String? phoneNumber,
}) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  try {
    final json = await ApiClient.instance.post('/contacts', {
      'name': name,
      if (phoneNumber != null && phoneNumber.trim().isNotEmpty) 'phone': phoneNumber.trim(),
    }) as Map<String, dynamic>;
    final contact = Contact.fromJson(json);
    if (json['existing'] == true) {
      messenger?.showSnackBar(SnackBar(content: Text('${contact.name} is already here - using them.')));
    }
    return contact;
  } catch (error) {
    messenger?.showSnackBar(SnackBar(
      content: Text(error is ApiException ? error.message : "Couldn't add them just now."),
    ));
    return null;
  }
}

/// Opens the phone's contact picker and adds whoever is chosen.
Future<Contact?> addContactFromPhone(BuildContext context) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  var withNumber = true;

  if (Platform.isAndroid) {
    withNumber = await phone.FlutterContacts.permissions.has(phone.PermissionType.read);
    if (!withNumber) {
      if (!context.mounted) return null;
      final allow = await showDialog<bool>(context: context, builder: (_) => const _WhyDialog());
      if (allow == null) return null;
      if (allow) {
        final status = await phone.FlutterContacts.permissions.request(phone.PermissionType.read);
        withNumber = status == phone.PermissionStatus.granted || status == phone.PermissionStatus.limited;
      }
    }
  }

  phone.Contact? picked;
  try {
    picked = await phone.FlutterContacts.native.showPicker(
      properties: withNumber ? {phone.ContactProperty.name, phone.ContactProperty.phone} : null,
    );
  } on PlatformException {
    // Asked for the number and refused after all - take the name alone
    // rather than nothing.
    try {
      picked = await phone.FlutterContacts.native.showPicker();
    } on PlatformException {
      messenger?.showSnackBar(
        const SnackBar(content: Text("Couldn't open your contacts. Add them by name instead.")),
      );
      return null;
    }
  }
  if (picked == null) return null;

  final number = picked.phones.isEmpty ? null : picked.phones.first.number;
  final name = (picked.displayName?.trim().isNotEmpty ?? false)
      ? picked.displayName!.trim()
      : (number ?? 'Someone');

  if (!context.mounted) return null;
  return createContact(context, name: name, phoneNumber: number);
}

/// Adds someone by typing their name, and a number if it is to hand.
Future<Contact?> addContactByName(BuildContext context, {String initialName = ''}) async {
  final entered = await showDialog<({String name, String phone})>(
    context: context,
    builder: (_) => ContactDialog(title: 'Add a person', initialName: initialName),
  );
  if (entered == null || !context.mounted) return null;
  return createContact(context, name: entered.name, phoneNumber: entered.phone);
}

/// Why the picker is about to ask for contacts, before Android asks.
class _WhyDialog extends StatelessWidget {
  const _WhyDialog();

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Their number too?'),
        content: Text(
          'You pick one person from your contacts. To keep their number with their name - so '
          'picking them again finds the same person - Android needs SpendLog to have contacts '
          'permission. SpendLog only reads the one person you pick, never your address book.',
          style: TextStyle(fontSize: 13, height: 1.45, color: context.c.ink70),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Name only')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Allow')),
        ],
      );
}

/// A name and an optional number: adding someone by hand, or changing
/// either later.
class ContactDialog extends StatefulWidget {
  const ContactDialog({
    super.key,
    required this.title,
    this.initialName = '',
    this.initialPhone = '',
    this.action = 'Add',
  });

  final String title;
  final String initialName;
  final String initialPhone;
  final String action;

  @override
  State<ContactDialog> createState() => _ContactDialogState();
}

class _ContactDialogState extends State<ContactDialog> {
  late final _name = TextEditingController(text: widget.initialName);
  late final _phone = TextEditingController(text: widget.initialPhone);

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  void _done() {
    if (_name.text.trim().isEmpty) return;
    Navigator.of(context).pop((name: _name.text.trim(), phone: _phone.text.trim()));
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text(widget.title),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: _name,
              autofocus: true,
              textCapitalization: TextCapitalization.words,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'Name'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(labelText: 'Phone (optional)'),
              onSubmitted: (_) => _done(),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(
            onPressed: _name.text.trim().isEmpty ? null : _done,
            child: Text(widget.action),
          ),
        ],
      );
}
