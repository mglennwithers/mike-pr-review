import unittest

from ledger import money


class RoundingTests(unittest.TestCase):
    def test_round_half_up_rounds_a_half_away_from_zero(self):
        self.assertEqual(money.round_half_up(5, 2), 3)
        self.assertEqual(money.round_half_up(-5, 2), -3)
        self.assertEqual(money.round_half_up(4, 2), 2)

    def test_pro_rata_splits_without_losing_cents(self):
        # Half of 175 cents rounds up, not down.
        self.assertEqual(money.pro_rata_cents(175, 5_000, 10_000), 88)
        self.assertEqual(money.pro_rata_cents(100, 2_900, 10_000), 29)

    def test_fee_is_never_zero_on_a_real_amount(self):
        self.assertEqual(money.fee_cents(0, 25), 0)
        self.assertEqual(money.fee_cents(1, 25), 1)
        self.assertEqual(money.fee_cents(100_000, 25), 250)

    def test_formatting_and_parsing(self):
        self.assertEqual(money.format_cents(1234), "12.34")
        self.assertEqual(money.format_cents(-5), "-0.05")
        for bad in (10.5, True, "12"):
            with self.assertRaises(ValueError):
                money.parse_cents(bad)


if __name__ == "__main__":
    unittest.main()
