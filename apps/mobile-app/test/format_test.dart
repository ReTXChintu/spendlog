import 'package:flutter_test/flutter_test.dart';
import 'package:spendlog/utils/format.dart';

void main() {
  group('ordinalDay', () {
    test('says every day of the month without throwing', () {
      // The bug this exists for. The suffix table has four entries and the
      // lookup is by last digit, so days ending 4 to 9 indexed past the
      // end of it — and in Dart that throws rather than giving undefined.
      // A card billing on the 24th took the whole accounts screen down
      // with a RangeError, and the days that work are exactly the ones
      // anybody would think to try.
      for (var day = 1; day <= 31; day += 1) {
        expect(() => ordinalDay(day), returnsNormally, reason: 'day $day');
      }
    });

    test('gets the four suffixes right', () {
      expect(ordinalDay(1), '1st');
      expect(ordinalDay(2), '2nd');
      expect(ordinalDay(3), '3rd');
      expect(ordinalDay(4), '4th');
      expect(ordinalDay(9), '9th');
    });

    test('says th through the teens, which end in 1, 2 and 3 but are not', () {
      expect(ordinalDay(11), '11th');
      expect(ordinalDay(12), '12th');
      expect(ordinalDay(13), '13th');
    });

    test('picks the suffix back up in the twenties', () {
      expect(ordinalDay(21), '21st');
      expect(ordinalDay(22), '22nd');
      expect(ordinalDay(23), '23rd');
      // The six that used to throw.
      expect(ordinalDay(24), '24th');
      expect(ordinalDay(25), '25th');
      expect(ordinalDay(26), '26th');
      expect(ordinalDay(27), '27th');
      expect(ordinalDay(28), '28th');
      expect(ordinalDay(29), '29th');
      expect(ordinalDay(30), '30th');
      expect(ordinalDay(31), '31st');
    });
  });
}
