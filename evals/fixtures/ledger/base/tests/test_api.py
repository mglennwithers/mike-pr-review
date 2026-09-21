import unittest

from ledger import api
from support import headers, make_accounts, make_db, make_tokens


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.conn = make_db()
        self.alice, self.bob = make_accounts(self.conn)
        self.tokens = make_tokens(self.conn)

    def call(self, method, path, role="admin", body=None, query=None):
        return api.handle(self.conn, method, path, headers(self.tokens[role]), body, query)

    def test_requests_without_a_token_are_rejected(self):
        status, payload = api.handle(self.conn, "GET", "/accounts", {}, None)
        self.assertEqual(status, 401)
        self.assertIn("error", payload)

    def test_accounts_can_be_listed_and_filtered_by_owner(self):
        status, payload = self.call("GET", "/accounts")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["accounts"]), 2)
        _, filtered = self.call("GET", "/accounts", query={"owner": "bob"})
        self.assertEqual([a["name"] for a in filtered["accounts"]], ["Bob"])

    def test_creating_a_transfer_posts_it(self):
        status, payload = self.call(
            "POST", "/transfers", role="clerk",
            body={"source_id": self.alice.id, "dest_id": self.bob.id, "amount_cents": 2_500},
        )
        self.assertEqual(status, 201)
        self.assertEqual(payload["amount_cents"], 2_500)

    def test_auditors_cannot_post_transfers(self):
        status, _ = self.call(
            "POST", "/transfers", role="auditor",
            body={"source_id": self.alice.id, "dest_id": self.bob.id, "amount_cents": 100},
        )
        self.assertEqual(status, 403)

    def test_only_admins_can_change_an_account_status(self):
        status, _ = self.call("POST", f"/accounts/{self.bob.id}/status",
                              role="support", body={"status": "frozen"})
        self.assertEqual(status, 403)
        status, payload = self.call("POST", f"/accounts/{self.bob.id}/status",
                                    body={"status": "frozen"})
        self.assertEqual((status, payload["status"]), (200, "frozen"))

    def test_unknown_routes_are_404(self):
        self.assertEqual(self.call("GET", "/nope")[0], 404)


if __name__ == "__main__":
    unittest.main()
