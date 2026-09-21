import unittest

from ledger import accounts, transfers
from support import make_accounts, make_db


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.conn = make_db()
        self.alice, self.bob = make_accounts(self.conn)

    def test_transfer_moves_money_and_charges_the_fee_to_the_source(self):
        result = transfers.execute_transfer(self.conn, self.alice.id, self.bob.id, 10_000)
        self.assertEqual(result["fee_cents"], 25)
        self.assertEqual(accounts.get_account(self.conn, self.alice.id).balance_cents, 89_975)
        self.assertEqual(accounts.get_account(self.conn, self.bob.id).balance_cents, 110_000)

    def test_transfer_is_rejected_when_the_fee_would_overdraw(self):
        poor = accounts.create_account(self.conn, "Poor", "poor", 10_000)
        with self.assertRaises(transfers.InsufficientFunds):
            transfers.execute_transfer(self.conn, poor.id, self.bob.id, 10_000)
        self.assertEqual(accounts.get_account(self.conn, poor.id).balance_cents, 10_000)

    def test_transfer_into_a_frozen_account_is_rejected(self):
        accounts.set_status(self.conn, self.bob.id, "frozen")
        with self.assertRaises(accounts.InvalidAccount):
            transfers.execute_transfer(self.conn, self.alice.id, self.bob.id, 500)
        self.assertEqual(accounts.get_account(self.conn, self.alice.id).balance_cents, 100_000)
        self.assertEqual(accounts.get_account(self.conn, self.bob.id).balance_cents, 100_000)

    def test_transfer_out_of_a_frozen_account_is_rejected(self):
        accounts.set_status(self.conn, self.alice.id, "frozen")
        with self.assertRaises(accounts.InvalidAccount):
            transfers.execute_transfer(self.conn, self.alice.id, self.bob.id, 500)

    def test_non_positive_amounts_are_rejected(self):
        for amount in (0, -1):
            with self.assertRaises(transfers.InvalidTransfer):
                transfers.execute_transfer(self.conn, self.alice.id, self.bob.id, amount)

    def test_a_rejected_transfer_leaves_no_row_behind(self):
        with self.assertRaises(transfers.InsufficientFunds):
            transfers.execute_transfer(self.conn, self.alice.id, self.bob.id, 500_000)
        self.assertEqual(transfers.list_transfers(self.conn, self.alice.id), [])

    def test_history_is_newest_first_and_signed_per_account(self):
        first = transfers.execute_transfer(self.conn, self.alice.id, self.bob.id, 1_000)
        second = transfers.execute_transfer(self.conn, self.bob.id, self.alice.id, 400)
        history = transfers.list_transfers(self.conn, self.alice.id)
        self.assertEqual([row["id"] for row in history], [second["id"], first["id"]])
        self.assertEqual(transfers.signed_amount_for(history[1], self.alice.id), -1_003)
        self.assertEqual(transfers.signed_amount_for(history[0], self.alice.id), 400)


if __name__ == "__main__":
    unittest.main()
