import unittest

from ledger import limits, transfers
from support import make_accounts, make_db, make_tokens, principal


class LimitLookupTests(unittest.TestCase):
    def test_known_roles_have_their_own_ceilings(self):
        self.assertEqual(limits.daily_limit_for("clerk"), 500_000)
        self.assertEqual(limits.transfer_ceiling_for("clerk"), 250_000)

    def test_an_unknown_role_falls_back_to_the_default(self):
        self.assertEqual(limits.daily_limit_for("intern"), limits.DEFAULT_DAILY_LIMIT_CENTS)
        self.assertEqual(
            limits.transfer_ceiling_for("intern"), limits.DEFAULT_TRANSFER_CEILING_CENTS
        )


class DailyLimitTests(unittest.TestCase):
    def setUp(self):
        self.conn = make_db()
        self.alice, self.bob = make_accounts(self.conn, opening=1_000_000)
        make_tokens(self.conn)
        self.clerk = principal(self.conn, "clerk")

    def move(self, amount_cents):
        transfers.execute_transfer(
            self.conn, self.alice.id, self.bob.id, amount_cents, actor=self.clerk.name
        )

    def test_a_transfer_over_the_per_transfer_ceiling_is_refused(self):
        with self.assertRaises(limits.LimitExceeded):
            limits.check_transfer(self.conn, self.clerk, 250_001)
        limits.check_transfer(self.conn, self.clerk, 250_000)

    def test_the_daily_ceiling_is_exclusive(self):
        self.move(150_000)
        self.move(150_000)
        # 300_000 moved, 500_000 limit: the last cent under the limit is fine, the
        # transfer that lands exactly on the limit is not.
        limits.check_transfer(self.conn, self.clerk, 199_999)
        with self.assertRaises(limits.LimitExceeded):
            limits.check_transfer(self.conn, self.clerk, 200_000)

    def test_usage_only_counts_the_callers_own_transfers(self):
        transfers.execute_transfer(
            self.conn, self.alice.id, self.bob.id, 120_000, actor="Someone Else"
        )
        self.assertEqual(limits.moved_today(self.conn, self.clerk.name), 0)
        self.move(50_000)
        self.assertEqual(limits.moved_today(self.conn, self.clerk.name), 50_000)

    def test_summary_reports_what_is_left(self):
        self.move(50_000)
        summary = limits.summary(self.conn, self.clerk)
        self.assertEqual(summary["used_cents"], 50_000)
        self.assertEqual(summary["remaining_cents"], 450_000)
        self.assertEqual(summary["per_transfer_ceiling_cents"], 250_000)

    def test_a_batch_is_measured_as_one_day_of_movement(self):
        self.move(200_000)
        limits.check_batch(self.conn, self.clerk, [100_000, 100_000])
        with self.assertRaises(limits.LimitExceeded):
            limits.check_batch(self.conn, self.clerk, [150_000, 150_000])


if __name__ == "__main__":
    unittest.main()
