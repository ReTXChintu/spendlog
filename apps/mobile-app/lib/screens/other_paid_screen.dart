import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../services/other_paid_check.dart';
import '../widgets/ds/ds.dart';
import '../widgets/state_block.dart';
import 'group_other_payment_screen.dart';

/// The evening check's "someone else paid" form, for its group: the
/// group's people loaded first, then the same form the group's own page
/// opens. Saving answers today's check.
class OtherPaidScreen extends StatefulWidget {
  const OtherPaidScreen({super.key});

  @override
  State<OtherPaidScreen> createState() => _OtherPaidScreenState();
}

class _OtherPaidScreenState extends State<OtherPaidScreen> {
  GroupDetail? _detail;
  String? _problem;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final settings = await OtherPaidCheck.instance.settings();
    if (!settings.hasGroup) {
      if (mounted) setState(() => _problem = 'Pick a group for the evening check in Settings → Reminders.');
      return;
    }
    try {
      final json = await ApiClient.instance.get('/groups/${settings.groupId}') as Map<String, dynamic>;
      if (mounted) setState(() => _detail = GroupDetail.fromJson(json));
    } catch (_) {
      if (mounted) setState(() => _problem = "Couldn't load ${settings.groupName}. Check your internet and try again.");
    }
  }

  @override
  Widget build(BuildContext context) {
    final detail = _detail;
    if (detail != null) {
      return GroupOtherPaymentScreen(detail: detail, onSaved: () => OtherPaidCheck.instance.markAnswered());
    }
    return Scaffold(
      backgroundColor: context.c.bg,
      appBar: AppBar(title: const Text('Someone else paid')),
      body: _problem == null
          ? const Center(child: DsSpinner())
          : StateBlock(
              icon: DsIcons.users,
              title: "Can't open the form",
              body: _problem!,
              actionLabel: 'Retry',
              onAction: () {
                setState(() => _problem = null);
                _load();
              },
            ),
    );
  }
}
