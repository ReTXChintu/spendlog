import 'package:flutter/material.dart';
import '../services/api_client.dart';
import '../services/auth_service.dart';
import '../services/kid_service.dart';
import '../widgets/ds/ds.dart';
import 'home_shell.dart';
import 'kid/kid_home_shell.dart';

Widget _ownerHome(BuildContext context) => const HomeShell();

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, this.notice, this.ownerHome = _ownerHome});

  /// Shown above the buttons, e.g. why a kid was just signed out.
  final String? notice;

  /// Where an owner lands once signed in. Swapped in tests, which have no
  /// SMS listener or push to start.
  final WidgetBuilder ownerHome;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  bool _loading = false;
  String? _error;

  // A kid never uses the shared account sign-in: their parent made them an
  // email and password that only work here.
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
        Navigator.of(context).pushReplacement(MaterialPageRoute(builder: widget.ownerHome));
      }
    } catch (e) {
      // The reason is shown rather than swallowed: this app is sideloaded,
      // so there is no console to check when sign-in fails on a phone.
      setState(() => _error = e is SignInException ? e.message : "Sign-in didn't go through: $e");
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// A 52 px spinner slot, so the card doesn't jump while signing in.
  Widget _busy() => const SizedBox(height: 52, child: Center(child: DsSpinner()));

  ButtonStyle get _bigButton => FilledButton.styleFrom(
        minimumSize: const Size(64, 52),
        textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 15, fontWeight: FontWeight.w600),
      );

  List<Widget> _kidForm() {
    final c = context.c;
    return [
      Text(
        'Sign in with the email and password your parent set up for you.',
        style: TextStyle(fontSize: 15, height: 22 / 15, color: c.tx2),
      ),
      const SizedBox(height: 20),
      DsField(
        label: 'Email',
        child: TextField(
          key: const Key('kid-email'),
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          textInputAction: TextInputAction.next,
          decoration: const InputDecoration(hintText: 'you@example.com'),
        ),
      ),
      const SizedBox(height: 16),
      DsField(
        label: 'Password',
        child: TextField(
          key: const Key('kid-password'),
          controller: _password,
          obscureText: !_showPassword,
          enableSuggestions: false,
          autocorrect: false,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _kidSignIn(),
          // Revealed in Plex Mono, so an l and a 1 can be told apart.
          style: _showPassword ? kMono.copyWith(fontSize: 15, color: c.tx) : null,
          decoration: InputDecoration(
            suffixIcon: Padding(
              padding: const EdgeInsets.only(right: 2),
              child: DsEyeButton(
                obscured: !_showPassword,
                onPressed: () => setState(() => _showPassword = !_showPassword),
              ),
            ),
          ),
        ),
      ),
      const SizedBox(height: 20),
      if (_loading) _busy() else FilledButton(style: _bigButton, onPressed: _kidSignIn, child: const Text('Sign in')),
      const SizedBox(height: 4),
      TextButton(
        onPressed: _loading
            ? null
            : () => setState(() {
                  _kidMode = false;
                  _error = null;
                }),
        child: const Text('Back to sign-in'),
      ),
    ];
  }

  List<Widget> _ownerForm() {
    final c = context.c;
    return [
      Text(
        'Sign in',
        style: TextStyle(fontSize: 22, height: 28 / 22, fontWeight: FontWeight.w600, color: c.tx),
      ),
      const SizedBox(height: 20),
      if (_loading)
        _busy()
      else
        FilledButton.icon(
          style: _bigButton,
          onPressed: _signIn,
          icon: const Icon(Icons.login, size: 20),
          label: const Text('Sign in with your account'),
        ),
      const SizedBox(height: 4),
      TextButton(
        onPressed: _loading
            ? null
            : () => setState(() {
                  _kidMode = true;
                  _error = null;
                }),
        child: const Text("I'm a kid — sign in with email"),
      ),
      const SizedBox(height: 12),
      // The neutral notice (§6.2): stated plainly, not a warning.
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(color: c.sunk, borderRadius: BorderRadius.circular(Ds.rLg)),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: DsIcon(DsIcons.info, size: 18, color: c.tx2),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                'One account for SpendLog, Trippin and InFrame. Your first sign-in creates your '
                'ledger.',
                style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
              ),
            ),
          ],
        ),
      ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: context.c.bg,
      body: SafeArea(
        // Scrollable so the kid's email form still fits with the keyboard up.
        child: SingleChildScrollView(child: _layout(context)),
      ),
    );
  }

  Widget _layout(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // The brand panel, shortened for a phone (§6.2): logo, headline and
        // the one line that says what the app does.
        Container(
          padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
          decoration: BoxDecoration(
            color: c.sf2,
            border: Border(bottom: BorderSide(color: c.ln)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const DsLogo(),
              const SizedBox(height: 24),
              Text(
                'Track every rupee, every day.',
                style: TextStyle(
                  fontSize: 28,
                  height: 34 / 28,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.56,
                  color: c.tx,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Connect your bank messages once — every transaction after that files itself.',
                style: TextStyle(fontSize: 15, height: 22 / 15, color: c.tx2),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
          child: Align(
            alignment: Alignment.topCenter,
            // The sign-in card is one of the few things allowed a width
            // cap (440); on a phone it is simply full width.
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  DsCard(
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (widget.notice != null && _error == null) ...[
                          DsCallout(tone: DsTone.warn, title: widget.notice!),
                          const SizedBox(height: 16),
                        ],
                        if (_kidMode) ..._kidForm() else ..._ownerForm(),
                      ],
                    ),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    DsAlertCard(title: _error!),
                  ],
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
