import 'package:flutter/material.dart';
import '../services/auth_service.dart';
import '../theme.dart';
import 'home_shell.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  bool _loading = false;
  String? _error;

  Future<void> _signIn() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final success = await AuthService.instance.signIn();
      if (success && mounted) {
        Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomeShell()));
      }
    } catch (e) {
      setState(() => _error = "Sign-in didn't go through. Please try again.");
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: context.c.darkPanel,
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Image.asset('assets/app_icon.png', width: 76, height: 76),
                    const SizedBox(height: 18),
                    const Text(
                      'SpendLog',
                      style: TextStyle(fontSize: 30, fontWeight: FontWeight.w800, color: Colors.white),
                    ),
                    const SizedBox(height: 10),
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 40),
                      child: Text(
                        'Track every rupee, every day. Connect your bank messages once — every transaction '
                        'after that files itself.',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 13.5, height: 1.55, color: Color(0xFFC7D0E8)),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            Container(
              width: double.infinity,
              decoration: BoxDecoration(
                color: context.c.surface,
                borderRadius: const BorderRadius.vertical(top: Radius.circular(T.rLg)),
              ),
              padding: const EdgeInsets.fromLTRB(24, 26, 24, 30),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (_loading)
                    const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator()))
                  else
                    FilledButton.icon(
                      onPressed: _signIn,
                      icon: const Icon(Icons.login, size: 18),
                      label: const Text('Sign in with Google'),
                    ),
                  const SizedBox(height: 14),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: context.c.brand50,
                      borderRadius: BorderRadius.circular(T.rSm),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Icon(Icons.mail_outline, size: 15, color: context.c.brandDark),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            'Google will also ask for read-only Gmail access in this step, so email-based '
                            'transaction alerts get picked up.',
                            style: TextStyle(fontSize: 12.5, height: 1.45, color: context.c.ink70),
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(color: context.c.debit50, borderRadius: BorderRadius.circular(T.rSm)),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(Icons.error_outline, size: 15, color: context.c.debit),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              _error!,
                              style: TextStyle(fontSize: 12.5, color: context.c.debit),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
