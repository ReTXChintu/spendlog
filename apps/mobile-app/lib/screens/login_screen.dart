import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../services/kid_service.dart';
import '../theme.dart';
import 'home_shell.dart';
import 'kid/kid_home_shell.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, this.notice});

  /// Shown above the buttons, e.g. why a kid was just signed out.
  final String? notice;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  bool _loading = false;
  String? _error;

  // A kid has no Google sign-in: their parent made them an email and password.
  bool _kidMode = false;
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _showPassword = false;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _kidSignIn() async {
    final email = _email.text.trim();
    if (email.isEmpty || _password.text.isEmpty) {
      setState(() => _error = 'Enter your email and password.');
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await KidService.instance.signIn(email, _password.text);
      if (mounted) {
        Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const KidHomeShell()));
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = "Couldn't reach SpendLog. Check your internet and try again.");
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

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
      // The reason is shown rather than swallowed: this app is sideloaded,
      // so there is no console to check when sign-in fails on a phone.
      setState(() => _error = e is SignInException ? e.message : "Sign-in didn't go through: $e");
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  List<Widget> _kidForm() {
    final c = context.c;
    return [
      Text(
        'Sign in with the email and password your parent set up for you.',
        style: TextStyle(fontSize: 13, height: 1.45, color: c.ink70),
      ),
      const SizedBox(height: 14),
      TextField(
        key: const Key('kid-email'),
        controller: _email,
        keyboardType: TextInputType.emailAddress,
        autocorrect: false,
        textInputAction: TextInputAction.next,
        decoration: const InputDecoration(labelText: 'Email', border: OutlineInputBorder()),
      ),
      const SizedBox(height: 10),
      TextField(
        key: const Key('kid-password'),
        controller: _password,
        obscureText: !_showPassword,
        textInputAction: TextInputAction.done,
        onSubmitted: (_) => _kidSignIn(),
        decoration: InputDecoration(
          labelText: 'Password',
          border: const OutlineInputBorder(),
          suffixIcon: IconButton(
            tooltip: _showPassword ? 'Hide password' : 'Show password',
            icon: Icon(_showPassword ? Icons.visibility_off_outlined : Icons.visibility_outlined),
            onPressed: () => setState(() => _showPassword = !_showPassword),
          ),
        ),
      ),
      const SizedBox(height: 14),
      if (_loading)
        const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator()))
      else
        FilledButton(onPressed: _kidSignIn, child: const Text('Sign in')),
      const SizedBox(height: 4),
      TextButton(
        onPressed: _loading
            ? null
            : () => setState(() {
                  _kidMode = false;
                  _error = null;
                }),
        child: const Text('Back to Google sign-in'),
      ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: context.c.darkPanel,
      body: SafeArea(
        // Scrollable so the kid's email form still fits with the keyboard up.
        child: LayoutBuilder(
          builder: (context, constraints) => SingleChildScrollView(
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: constraints.maxHeight),
              child: IntrinsicHeight(child: _layout(context)),
            ),
          ),
        ),
      ),
    );
  }

  Widget _layout(BuildContext context) {
    return Column(
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
                  if (widget.notice != null && _error == null) ...[
                    Text(
                      widget.notice!,
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: context.c.warn),
                    ),
                    const SizedBox(height: 12),
                  ],
                  if (_kidMode)
                    ..._kidForm()
                  else ...[
                  if (_loading)
                    const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator()))
                  else
                    FilledButton.icon(
                      onPressed: _signIn,
                      icon: const Icon(Icons.login, size: 18),
                      label: const Text('Sign in with Google'),
                    ),
                  const SizedBox(height: 4),
                  TextButton(
                    onPressed: _loading ? null : () => setState(() {
                      _kidMode = true;
                      _error = null;
                    }),
                    child: const Text("I'm a kid — sign in with email"),
                  ),
                  const SizedBox(height: 10),
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
                  ],
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
    );
  }
}
