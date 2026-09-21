import unittest

from ledger import accounts, refunds, transfers
from support import make_accounts, make_db, make_tokens, principal


class RefundTests(unittest.TestCase):
    def setUp(self):
        self.conn = make_db()
        self.alice, self.bob = make_accounts(self.conn)
        make_tokens(self.conn)
        self.admin = principal(self.conn, "admin")
        self.posted = transfers.execute_transfer(
            self.conn, self.alice.id, self.bob.id, 10_000, actor=self.admin.name
        )

    def test_a_full_refund_puts_both_accounts_back_where_they_started(self):
        result = refunds.refund_transfer(self.conn, self.admin, self.posted["id"],
                                         reason="duplicate charge")
        self.assertEqual(result["amount_cents"], 10_000)
        self.assertEqual(result["fee_cents"], 25)
        self.assertEqual(result["remaining_cents"], 0)
        self.assertEqual(accounts.get_account(self.conn, self.alice.id).balance_cents, 100_000)
        self.assertEqual(accounts.get_account(self.conn, self.bob.id).balance_cents, 100_000)

    def test_refunds_stack_up_to_the_original_amount(self):
        first = refunds.refund_transfer(self.conn, self.admin, self.posted["id"],
                                        amount_cents=4_000)
        self.assertEqual(first["remaining_cents"], 6_000)
        second = refunds.refund_transfer(self.conn, self.admin, self.posted["id"],
                                         amount_cents=6_000)
        self.assertEqual(second["remaining_cents"], 0)
        with self.assertRaises(refunds.InvalidRefund):
            refunds.refund_transfer(self.conn, self.admin, self.posted["id"], amount_cents=1)

    def test_a_refund_posts_a_refund_category_transfer_back_to_the_payer(self):
        result = refunds.refund_transfer(self.conn, self.admin, self.posted["id"])
        reversal = transfers.get_transfer(self.conn, result["transfer_id"])
        self.assertEqual(reversal["category"], "refund")
        self.assertEqual(reversal["source_id"], self.bob.id)
        self.assertEqual(reversal["dest_id"], self.alice.id)

    def test_a_refund_may_not_itself_be_refunded(self):
        result = refunds.refund_transfer(self.conn, self.admin, self.posted["id"])
        with self.assertRaises(refunds.InvalidRefund):
            refunds.refund_transfer(self.conn, self.admin, result["transfer_id"])

    def test_a_refund_bigger_than_the_original_is_rejected(self):
        with self.assertRaises(refunds.InvalidRefund):
            refunds.refund_transfer(self.conn, self.admin, self.posted["id"],
                                    amount_cents=10_001)

    def test_refunds_are_listed_against_the_original_transfer(self):
        refunds.refund_transfer(self.conn, self.admin, self.posted["id"], amount_cents=2_000)
        refunds.refund_transfer(self.conn, self.admin, self.posted["id"], amount_cents=3_000)
        listed = refunds.list_refunds(self.conn, self.posted["id"])
        self.assertEqual([row["amount_cents"] for row in listed], [3_000, 2_000])
        self.assertEqual(refunds.refunded_cents(self.conn, self.posted["id"]), 5_000)


if __name__ == "__main__":
    unittest.main()
