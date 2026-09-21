import unittest

from ledger import accounts, scheduling
from support import days_from_now, make_accounts, make_db, make_tokens, principal


class SchedulingTests(unittest.TestCase):
    def setUp(self):
        self.conn = make_db()
        self.alice, self.bob = make_accounts(self.conn)
        make_tokens(self.conn)
        self.support = principal(self.conn, "support")

    def schedule(self, **kwargs):
        return scheduling.create_schedule(
            self.conn, self.support, self.alice.id, self.bob.id,
            kwargs.pop("amount_cents", 2_500), **kwargs
        )

    def test_a_one_off_schedule_posts_and_retires(self):
        created = self.schedule(memo="rent")
        result = scheduling.run_due(self.conn, self.support)
        self.assertEqual(result["ran"], 1)
        self.assertEqual(accounts.get_account(self.conn, self.bob.id).balance_cents, 102_500)
        after = scheduling.get_schedule(self.conn, created["id"])
        self.assertEqual(after["status"], "completed")
        self.assertIsNotNone(after["last_run_at"])

    def test_a_repeating_schedule_moves_on_to_its_next_run(self):
        created = self.schedule(interval_days=7)
        scheduling.run_due(self.conn, self.support)
        after = scheduling.get_schedule(self.conn, created["id"])
        self.assertEqual(after["status"], "active")
        self.assertGreater(after["next_run_at"], created["next_run_at"])
        self.assertEqual(scheduling.due_schedules(self.conn), [])

    def test_a_future_schedule_is_not_due_yet(self):
        self.schedule(first_run_at=days_from_now(1))
        self.assertEqual(scheduling.run_due(self.conn, self.support)["ran"], 0)
        self.assertEqual(accounts.get_account(self.conn, self.bob.id).balance_cents, 100_000)

    def test_a_paused_schedule_is_skipped_until_it_is_resumed(self):
        created = self.schedule()
        scheduling.set_schedule_status(self.conn, self.support, created["id"], "paused")
        self.assertEqual(scheduling.run_due(self.conn, self.support)["ran"], 0)
        scheduling.set_schedule_status(self.conn, self.support, created["id"], "active")
        self.assertEqual(scheduling.run_due(self.conn, self.support)["ran"], 1)

    def test_schedules_reject_nonsense(self):
        with self.assertRaises(scheduling.InvalidSchedule):
            scheduling.create_schedule(self.conn, self.support, self.alice.id,
                                       self.alice.id, 100)
        with self.assertRaises(scheduling.InvalidSchedule):
            self.schedule(interval_days=-1)
        with self.assertRaises(scheduling.InvalidSchedule):
            self.schedule(interval_days=9_999)

    def test_listing_filters_by_status(self):
        first = self.schedule()
        self.schedule(amount_cents=1_000)
        scheduling.set_schedule_status(self.conn, self.support, first["id"], "cancelled")
        self.assertEqual(len(scheduling.list_schedules(self.conn, "active")), 1)
        self.assertEqual(len(scheduling.list_schedules(self.conn)), 2)


if __name__ == "__main__":
    unittest.main()
