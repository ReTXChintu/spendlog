import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/screens/login_screen.dart';
import 'package:spendlog/services/api_client.dart';
import 'package:spendlog/services/auth_service.dart';
import 'package:spendlog/widgets/ds/ds.dart';

/// Stands in for the browser tab AppAuth opens at the identity server.
class _FakeAuthenticator implements OidcAuthenticator {
  _FakeAuthenticator({this.idToken = 'id-token-from-identity-server', this.error, this.endSessionError});

  final String? idToken;
  final SignInException? error;
  final Object? endSessionError;
  int signIns = 0;
  final List<String> endedSessions = [];

  @override
  Future<String?> signIn() async {
    signIns++;
    if (error != null) throw error!;
    return idToken;
  }

  @override
  Future<void> endSession(String idTokenHint) async {
    endedSessions.add(idTokenHint);
    if (endSessionError != null) throw endSessionError!;
  }
}

Widget _app() => MaterialApp(
      theme: buildTheme(Brightness.light),
      home: LoginScreen(ownerHome: (_) => const Scaffold(body: Text('owner home'))),
    );

/// With the request attached, as a real reply has: ApiClient reads its path
/// to tell a wrong kid password from an ended session.
http.Response _json(Object body, [int status = 200, http.BaseRequest? request]) => http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
      request: request,
    );

void main() {
  late _FakeAuthenticator fake;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    fake = _FakeAuthenticator();
    AuthService.instance.authenticator = fake;
  });

  tearDown(() => AuthService.instance.authenticator = const AppAuthAuthenticator());

  testWidgets('offers one sign-in button and the kid option, and nothing from Google', (tester) async {
    await tester.pumpWidget(_app());

    expect(find.text('Sign in with your account'), findsOneWidget);
    expect(find.text("I'm a kid — sign in with email"), findsOneWidget);
    expect(find.textContaining('Google'), findsNothing);
  });

  testWidgets('sends the identity server\'s ID token to SpendLog and goes in', (tester) async {
    final requests = <http.Request>[];
    await http.runWithClient(() async {
      await tester.pumpWidget(_app());
      await tester.tap(find.text('Sign in with your account'));
      await tester.pumpAndSettle();
    }, () => MockClient((request) async {
          requests.add(request);
          return _json({
            'token': 'spendlog-session',
            'user': {'id': 'u1', 'email': 'me@example.com', 'name': 'Me'},
            'gmailConnected': false,
          });
        }));

    expect(fake.signIns, 1);
    expect(requests, hasLength(1));
    expect(requests.single.method, 'POST');
    expect(requests.single.url.path, endsWith('/auth/oidc/mobile'));
    expect(jsonDecode(requests.single.body), {'idToken': 'id-token-from-identity-server'});

    expect(await ApiClient.getToken(), 'spendlog-session');
    expect(find.text('owner home'), findsOneWidget);
  });

  testWidgets('says why when the identity server sign-in fails', (tester) async {
    fake = _FakeAuthenticator(error: SignInException("Couldn't reach the sign-in service. Check your internet and try again."));
    AuthService.instance.authenticator = fake;

    await tester.pumpWidget(_app());
    await tester.tap(find.text('Sign in with your account'));
    await tester.pumpAndSettle();

    expect(find.text("Couldn't reach the sign-in service. Check your internet and try again."), findsOneWidget);
    expect(await ApiClient.getToken(), isNull);
    expect(find.text('owner home'), findsNothing);
  });

  testWidgets('shows SpendLog\'s own reason when it refuses the account', (tester) async {
    await http.runWithClient(() async {
      await tester.pumpWidget(_app());
      await tester.tap(find.text('Sign in with your account'));
      await tester.pumpAndSettle();
    }, () => MockClient((request) async => _json({
          'error': "That email is used for a kid's login on SpendLog, so it can't be used to sign in here.",
        }, 403)));

    expect(find.text("That email is used for a kid's login on SpendLog, so it can't be used to sign in here."),
        findsOneWidget);
    expect(await ApiClient.getToken(), isNull);
  });

  testWidgets('a cancelled sign-in just stays put, with no error', (tester) async {
    fake = _FakeAuthenticator(idToken: null);
    AuthService.instance.authenticator = fake;

    await tester.pumpWidget(_app());
    await tester.tap(find.text('Sign in with your account'));
    await tester.pumpAndSettle();

    expect(fake.signIns, 1);
    expect(find.text('Sign in with your account'), findsOneWidget);
    expect(find.byType(DsAlertCard), findsNothing);
  });

  testWidgets('the kid path is untouched: email and password to /kid/login', (tester) async {
    final requests = <http.Request>[];
    await http.runWithClient(() async {
      await tester.pumpWidget(_app());
      await tester.tap(find.text("I'm a kid — sign in with email"));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('kid-email')), 'kid@example.com');
      await tester.enterText(find.byKey(const Key('kid-password')), 'pocketmoney');
      await tester.tap(find.text('Sign in'));
      await tester.pump();
      await tester.pump();
    }, () => MockClient((request) async {
          requests.add(request);
          return _json({'error': "That email and password don't match."}, 401, request);
        }));
    await tester.pumpAndSettle();

    expect(fake.signIns, 0, reason: 'the identity server is never involved');
    expect(requests.single.url.path, endsWith('/kid/login'));
    expect(jsonDecode(requests.single.body), {'email': 'kid@example.com', 'password': 'pocketmoney'});
    expect(find.text("That email and password don't match."), findsOneWidget);
  });

  group('signing out', () {
    test('ends the identity server session with the last ID token', () async {
      await http.runWithClient(() => AuthService.instance.signIn(),
          () => MockClient((_) async => _json({'token': 'session', 'user': {}, 'gmailConnected': false})));
      expect(await ApiClient.getToken(), 'session');

      await AuthService.instance.signOut();
      expect(fake.endedSessions, ['id-token-from-identity-server']);
      expect(await ApiClient.getToken(), isNull);
    });

    test('still signs the phone out when the identity server cannot be reached', () async {
      fake = _FakeAuthenticator(endSessionError: Exception('offline'));
      AuthService.instance.authenticator = fake;
      await http.runWithClient(() => AuthService.instance.signIn(),
          () => MockClient((_) async => _json({'token': 'session', 'user': {}, 'gmailConnected': false})));

      await AuthService.instance.signOut();
      expect(fake.endedSessions, hasLength(1));
      expect(await ApiClient.getToken(), isNull);
    });
  });
}
