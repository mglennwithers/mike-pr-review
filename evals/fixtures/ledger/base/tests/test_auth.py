import unittest

from ledger import auth
from support import headers, make_db, make_tokens


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.conn = make_db()
        self.tokens = make_tokens(self.conn)

    def test_authenticate_returns_the_principal_for_an_active_token(self):
        principal = auth.authenticate(self.conn, self.tokens["admin"])
        self.assertEqual(principal.role, "admin")

    def test_unknown_and_revoked_tokens_do_not_authenticate(self):
        self.assertIsNone(auth.authenticate(self.conn, "nope"))
        auth.revoke_token(self.conn, self.tokens["clerk"])
        self.assertIsNone(auth.authenticate(self.conn, self.tokens["clerk"]))

    def test_bearer_token_is_read_case_insensitively(self):
        self.assertEqual(auth.bearer_token({"authorization": "Bearer abc"}), "abc")
        self.assertEqual(auth.bearer_token({"Authorization": "bearer abc"}), "abc")
        self.assertEqual(auth.bearer_token({"Authorization": "Basic abc"}), "")
        self.assertEqual(auth.bearer_token(None), "")

    def test_require_role_rejects_the_wrong_role(self):
        clerk = auth.principal_from_headers(self.conn, headers(self.tokens["clerk"]))
        auth.require_role(clerk, "admin", "clerk")
        with self.assertRaises(auth.PermissionDenied):
            auth.require_role(clerk, "admin")

    def test_auditors_may_not_move_money(self):
        auditor = auth.authenticate(self.conn, self.tokens["auditor"])
        with self.assertRaises(auth.PermissionDenied):
            auth.require_writable(auditor)
        auth.require_writable(auth.authenticate(self.conn, self.tokens["support"]))


if __name__ == "__main__":
    unittest.main()
