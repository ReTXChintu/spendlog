import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:spendlog/main.dart';

void main() {
  testWidgets('shows the sign-in screen when there is no stored session', (tester) async {
    // No stored token, so the startup gate should land on login.
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(const SpendLogApp());
    await tester.pumpAndSettle();

    expect(find.text('Sign in with Google'), findsOneWidget);
  });
}
