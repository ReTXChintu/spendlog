import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import 'ds/ds.dart';

/// A kid's login, as the owner sees it.
class FamilyKid {
  final String id;
  final String name;
  final String email;
  final List<String> accountIds;

  const FamilyKid({required this.id, required this.name, required this.email, required this.accountIds});

  factory FamilyKid.fromJson(Map<String, dynamic> json) => FamilyKid(
        id: json['id'] as String,
        name: json['name'] as String? ?? '',
        email: json['email'] as String? ?? '',
        accountIds: (json['accountIds'] as List<dynamic>? ?? []).map((e) => e.toString()).toList(),
      );
}

/// The body of Settings' Family card: the owner's kids, and adding,
/// changing and removing their logins. Loads its own data so the rest of
/// Settings doesn't wait on it.
class FamilySection extends StatefulWidget {
  /// Opens Accounts, where an account is marked as pocket money.
  final Future<void> Function() onOpenAccounts;

  const FamilySection({super.key, required this.onOpenAccounts});

  @override
  State<FamilySection> createState() => _FamilySectionState();
}

class _FamilySectionState extends State<FamilySection> {
  bool _loading = true;
  String? _error;
  List<FamilyKid> _kids = [];
  List<Account> _accounts = [];
  bool _pushAvailable = true;

  List<Account> get _pocketAccounts => _accounts.where((a) => a.pocketMoney != null).toList();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/family/kids'),
        ApiClient.instance.get('/accounts'),
      ]);
      final family = results[0] as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _kids = (family['kids'] as List<dynamic>? ?? [])
            .map((k) => FamilyKid.fromJson(k as Map<String, dynamic>))
            .toList();
        _pushAvailable = family['pushAvailable'] as bool? ?? false;
        _accounts =
            (results[1] as List<dynamic>).map((a) => Account.fromJson(a as Map<String, dynamic>)).toList();
        _error = null;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e is ApiException ? e.message : "Couldn't load your family just now.";
        _loading = false;
      });
    }
  }

  String _accountNames(FamilyKid kid) {
    final names = [
      for (final id in kid.accountIds)
        if (_accounts.any((a) => a.id == id)) _accounts.firstWhere((a) => a.id == id).label,
    ];
    return names.isEmpty ? 'No pocket money account' : names.join(', ');
  }

  Future<void> _openAccounts() async {
    await widget.onOpenAccounts();
    await _load(); // an account may have just been marked as pocket money
  }

  Future<void> _addOrEdit([FamilyKid? kid]) async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => _KidDialog(kid: kid, accounts: _pocketAccounts, kids: _kids),
    );
    if (saved == true) await _load();
  }

  Future<void> _resetPassword(FamilyKid kid) async {
    final saved = await showDialog<bool>(context: context, builder: (_) => _ResetPasswordDialog(kid: kid));
    if (saved == true && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("${kid.name}'s password is changed. Give them the new one to sign in again.")),
      );
    }
  }

  Future<void> _remove(FamilyKid kid) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Remove ${kid.name}?'),
        content: Text(
          '${kid.name} is signed out and can no longer sign in. Their pocket money account and '
          'everything in it stays with you.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: FilledButton.styleFrom(backgroundColor: context.c.critFill, foregroundColor: Colors.white),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ApiClient.instance.delete('/family/kids/${kid.id}');
      await _load();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : "Couldn't remove ${kid.name}.")));
    }
  }

  @override
  Widget build(BuildContext context) {
    final note = TextStyle(fontSize: 12, height: 16 / 12, color: context.c.tx3);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 12),
        const DsCallout(
          tone: DsTone.ac,
          title: 'Give a child their own login to see and add their pocket money on this app. They can\'t '
              'see anything else, and can\'t create an account themselves.',
        ),
        if (_loading) ...[
          const SizedBox(height: 14),
          const LinearProgressIndicator(),
        ] else if (_error != null) ...[
          const SizedBox(height: 12),
          DsCallout(
            tone: DsTone.crit,
            title: _error!,
            action: Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton(onPressed: _load, child: const Text('Try again')),
            ),
          ),
        ] else ...[
          if (!_pushAvailable) ...[
            const SizedBox(height: 10),
            Text(
              "When a kid refreshes, SpendLog can't wake this phone to read new bank messages yet, "
              'so they only see what has already been uploaded.',
              style: note,
            ),
          ],
          for (final kid in _kids) _kidRow(kid),
          const SizedBox(height: 14),
          if (_pocketAccounts.isEmpty) ...[
            Text(
              'You have no pocket money accounts yet. Mark an account as pocket money in Accounts, '
              'then add a kid here.',
              style: note,
            ),
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton(onPressed: _openAccounts, child: const Text('Open accounts')),
            ),
          ] else
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton.icon(
                onPressed: () => _addOrEdit(),
                icon: const DsIcon(DsIcons.plus, size: 18),
                label: const Text('Add a kid'),
              ),
            ),
        ],
      ],
    );
  }

  Widget _kidRow(FamilyKid kid) {
    final c = context.c;
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.fromLTRB(14, 14, 4, 14),
      decoration: BoxDecoration(
        color: c.sf2,
        border: Border.all(color: c.ln),
        borderRadius: BorderRadius.circular(Ds.rXl),
      ),
      child: Row(
        children: [
          DsAvatar(kid.name, size: 40, tone: DsTone.warn),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  kid.name,
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
                Text(
                  kid.email,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: kMono.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    DsIcon(DsIcons.piggyBank, size: 14, color: c.tx2),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        _accountNames(kid),
                        style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          PopupMenuButton<String>(
            icon: DsIcon(DsIcons.moreVertical, color: c.tx2),
            onSelected: (action) {
              switch (action) {
                case 'edit':
                  _addOrEdit(kid);
                case 'password':
                  _resetPassword(kid);
                case 'remove':
                  _remove(kid);
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(
                value: 'edit',
                child: _MenuLine(icon: DsIcons.pencil, label: 'Edit'),
              ),
              const PopupMenuItem(
                value: 'password',
                child: _MenuLine(icon: DsIcons.lock, label: 'Reset password'),
              ),
              PopupMenuItem(
                value: 'remove',
                child: _MenuLine(icon: DsIcons.trash, label: 'Remove', colour: c.crit),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Adds a kid, or changes an existing one's name and accounts. The
/// password is only set here when adding; changing it is its own action
/// because it signs the kid out.
class _KidDialog extends StatefulWidget {
  final FamilyKid? kid;
  final List<Account> accounts;
  final List<FamilyKid> kids;

  const _KidDialog({this.kid, required this.accounts, required this.kids});

  @override
  State<_KidDialog> createState() => _KidDialogState();
}

class _KidDialogState extends State<_KidDialog> {
  late final _name = TextEditingController(text: widget.kid?.name ?? '');
  final _email = TextEditingController();
  final _password = TextEditingController();
  late final Set<String> _selected = {...?widget.kid?.accountIds};
  bool _showPassword = false;
  bool _saving = false;
  String? _error;

  bool get _adding => widget.kid == null;

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  /// The kid an account already belongs to, other than the one being edited.
  /// An account is one kid's alone, so the server would refuse it anyway.
  FamilyKid? _takenBy(Account account) {
    for (final kid in widget.kids) {
      if (kid.id != widget.kid?.id && kid.accountIds.contains(account.id)) return kid;
    }
    return null;
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final email = _email.text.trim();
    String? problem;
    if (name.isEmpty) {
      problem = 'Give them a name.';
    } else if (_adding && !email.contains('@')) {
      problem = 'Enter an email address for them to sign in with.';
    } else if (_adding && _password.text.length < 6) {
      problem = 'The password needs at least 6 characters.';
    } else if (_selected.isEmpty) {
      problem = 'Pick at least one pocket money account.';
    }
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      if (_adding) {
        await ApiClient.instance.post('/family/kids', {
          'name': name,
          'email': email,
          'password': _password.text,
          'accountIds': _selected.toList(),
        });
      } else {
        await ApiClient.instance.patch('/family/kids/${widget.kid!.id}', {
          'name': name,
          'accountIds': _selected.toList(),
        });
      }
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      setState(() {
        _saving = false;
        _error = e.statusCode == 409 ? 'That email is already used by another login.' : e.message;
      });
    } catch (_) {
      setState(() {
        _saving = false;
        _error = "Couldn't reach the server. Try again.";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final note = TextStyle(fontSize: 12, height: 16 / 12, color: context.c.tx3);

    return AlertDialog(
      title: Row(
        children: [
          const DsIconTile(DsIcons.users, tone: DsTone.ac),
          const SizedBox(width: 12),
          Expanded(child: Text(_adding ? 'Add a kid' : 'Edit ${widget.kid!.name}')),
        ],
      ),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Name'),
            ),
            if (_adding) ...[
              const SizedBox(height: 12),
              TextField(
                controller: _email,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                decoration: const InputDecoration(labelText: 'Email'),
              ),
              const SizedBox(height: 6),
              Text('Used only to sign in — nothing is sent to it.', style: note),
              const SizedBox(height: 12),
              TextField(
                controller: _password,
                obscureText: !_showPassword,
                autocorrect: false,
                enableSuggestions: false,
                // Revealed, it switches to Plex Mono so a 1 and an l differ.
                style: _showPassword ? kMono.copyWith(fontSize: 15) : null,
                decoration: InputDecoration(
                  labelText: 'Password',
                  helperText: 'At least 6 characters',
                  suffixIcon: DsEyeButton(
                    obscured: !_showPassword,
                    onPressed: () => setState(() => _showPassword = !_showPassword),
                  ),
                ),
              ),
            ],
            const SizedBox(height: 16),
            const DsLabel('Pocket money they can see'),
            const SizedBox(height: 4),
            for (final account in widget.accounts)
              Builder(builder: (context) {
                final takenBy = _takenBy(account);
                return CheckboxListTile(
                  value: _selected.contains(account.id),
                  onChanged: takenBy != null
                      ? null
                      : (on) => setState(() => on == true ? _selected.add(account.id) : _selected.remove(account.id)),
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(account.label),
                  subtitle: takenBy != null ? Text('Already ${takenBy.name}\'s') : null,
                );
              }),
            if (_error != null) ...[
              const SizedBox(height: 12),
              DsCallout(tone: DsTone.crit, title: _error!),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(_saving ? 'Saving…' : (_adding ? 'Add' : 'Save')),
        ),
      ],
    );
  }
}

/// A new password typed by the owner. The kid's current sign-in stops
/// working at once, so the dialog says so before it is saved.
class _ResetPasswordDialog extends StatefulWidget {
  final FamilyKid kid;

  const _ResetPasswordDialog({required this.kid});

  @override
  State<_ResetPasswordDialog> createState() => _ResetPasswordDialogState();
}

class _ResetPasswordDialogState extends State<_ResetPasswordDialog> {
  final _password = TextEditingController();
  bool _show = false;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_password.text.length < 6) {
      setState(() => _error = 'The password needs at least 6 characters.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ApiClient.instance.patch('/family/kids/${widget.kid.id}', {'password': _password.text});
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() {
        _saving = false;
        _error = e is ApiException ? e.message : "Couldn't reach the server. Try again.";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Row(
        children: [
          const DsIconTile(DsIcons.lock, tone: DsTone.ac),
          const SizedBox(width: 12),
          Expanded(child: Text('New password for ${widget.kid.name}')),
        ],
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${widget.kid.name} is signed out on their phone and signs in again with this one.',
            style: TextStyle(fontSize: 15, height: 22 / 15, color: context.c.tx2),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _password,
            obscureText: !_show,
            autocorrect: false,
            enableSuggestions: false,
            // Revealed, it switches to Plex Mono so a 1 and an l differ.
            style: _show ? kMono.copyWith(fontSize: 15) : null,
            decoration: InputDecoration(
              labelText: 'New password',
              helperText: 'At least 6 characters',
              suffixIcon: DsEyeButton(
                obscured: !_show,
                onPressed: () => setState(() => _show = !_show),
              ),
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            DsCallout(tone: DsTone.crit, title: _error!),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: _saving ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(_saving ? 'Saving…' : 'Change password'),
        ),
      ],
    );
  }
}

/// A popup-menu line: a 18 px icon and the label.
class _MenuLine extends StatelessWidget {
  final DsGlyph icon;
  final String label;
  final Color? colour;

  const _MenuLine({required this.icon, required this.label, this.colour});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        DsIcon(icon, size: 18, color: colour ?? c.tx2),
        const SizedBox(width: 12),
        Text(label, style: TextStyle(fontSize: 14, color: colour ?? c.tx)),
      ],
    );
  }
}
