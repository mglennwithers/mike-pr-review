import unittest

from ledger import api, transfers
from support import WINDOW_END, WINDOW_START, headers, make_accounts, make_db, make_tokens


class NewRouteTests(unittest.TestCase):
    def setUp(self):
        self.conn = make_db()
        self.alice, self.bob = make_accounts(self.conn)
        self.tokens = make_tokens(self.conn)

    def call(self, method, path, role="admin", body=None, query=None):
        return api.handle(self.conn, method, path, headers(self.tokens[role]), body, query)

    def test_whoami_describes_the_caller(self):
        status, payload = self.call("GET", "/whoami", role="support")
        self.assertEqual(status, 200)
        self.assertEqual(payload["role"], "support")
        self.assertFalse(payload["can_refund"])

    def test_limits_me_reports_the_daily_allowance(self):
        status, payload = self.call("GET", "/limits/me", role="clerk")
        self.assertEqual(status, 200)
        self.assertEqual(payload["daily_limit_cents"], 500_000)
        self.assertEqual(payload["used_cents"], 0)

    def test_a_transfer_over_the_daily_limit_comes_back_as_429(self):
        status, payload = self.call(
            "POST", "/transfers", role="clerk",
            body={"source_id": self.alice.id, "dest_id": self.bob.id,
                  "amount_cents": 400_000},
        )
        self.assertEqual(status, 429)
        self.assertIn("error", payload)

    def test_a_batch_posts_every_leg(self):
        status, payload = self.call(
            "POST", "/transfers/batch", role="clerk",
            body={"source_id": self.alice.id,
                  "legs": [{"dest_id": self.bob.id, "amount_cents": 1_000}]},
        )
        self.assertEqual(status, 201)
        self.assertEqual(len(payload["legs"]), 1)

    def test_auditors_may_not_submit_batches(self):
        status, _ = self.call(
            "POST", "/transfers/batch", role="auditor",
            body={"source_id": self.alice.id,
                  "legs": [{"dest_id": self.bob.id, "amount_cents": 1_000}]},
        )
        self.assertEqual(status, 403)

    def test_clerks_may_not_create_schedules(self):
        status, _ = self.call(
            "POST", "/schedules", role="clerk",
            body={"source_id": self.alice.id, "dest_id": self.bob.id, "amount_cents": 500},
        )
        self.assertEqual(status, 403)

    def test_a_schedule_can_be_created_and_run(self):
        status, schedule = self.call(
            "POST", "/schedules", role="support",
            body={"source_id": self.alice.id, "dest_id": self.bob.id, "amount_cents": 500},
        )
        self.assertEqual(status, 201)
        status, result = self.call("POST", "/schedules/run", role="support", body={})
        self.assertEqual((status, result["ran"]), (200, 1))
        self.assertEqual(result["results"][0]["schedule_id"], schedule["id"])

    def test_an_admin_can_refund_a_posted_transfer(self):
        posted = transfers.execute_transfer(self.conn, self.alice.id, self.bob.id, 5_000,
                                            actor="Admin")
        status, payload = self.call("POST", "/refunds",
                                    body={"transfer_id": posted["id"], "reason": "goodwill"})
        self.assertEqual(status, 201)
        self.assertEqual(payload["amount_cents"], 5_000)

    def test_a_statement_comes_back_as_csv_with_totals(self):
        transfers.execute_transfer(self.conn, self.alice.id, self.bob.id, 1_000,
                                   actor="Admin")
        status, payload = self.call(
            "GET", f"/accounts/{self.alice.id}/statement",
            query={"start": WINDOW_START, "end": WINDOW_END},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["content_type"], "text/csv")
        self.assertIn("transfer_id", payload["body"])
        self.assertEqual(payload["totals"]["debited_cents"], 1_000)

    def test_a_statement_needs_a_window(self):
        status, _ = self.call("GET", f"/accounts/{self.alice.id}/statement")
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
