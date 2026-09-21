import unittest

from ledger import accounts, batch, transfers
from support import make_accounts, make_db, make_tokens, principal


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.conn = make_db()
        self.alice, self.bob = make_accounts(self.conn)
        self.carol = accounts.create_account(self.conn, "Carol", "carol", 0)
        make_tokens(self.conn)
        self.clerk = principal(self.conn, "clerk")

    def legs(self):
        return [
            {"dest_id": self.bob.id, "amount_cents": 1_000, "memo": "march"},
            {"dest_id": self.carol.id, "amount_cents": 3_000},
        ]

    def test_preview_costs_the_batch_without_posting_it(self):
        preview = batch.preview_batch(self.conn, self.clerk, self.alice.id, self.legs())
        self.assertEqual(preview["legs"], 2)
        self.assertEqual(preview["average_leg_cents"], 2_000)
        self.assertEqual(preview["fee_cents"], 11)
        self.assertEqual(preview["total_cents"], 4_011)
        self.assertTrue(preview["affordable"])
        self.assertEqual(transfers.list_transfers(self.conn, self.alice.id), [])

    def test_a_batch_debits_the_source_once_and_credits_every_leg(self):
        result = batch.submit_batch(self.conn, self.clerk, self.alice.id, self.legs())
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(result["legs"]), 2)
        self.assertEqual(
            accounts.get_account(self.conn, self.alice.id).balance_cents, 100_000 - 4_011
        )
        self.assertEqual(accounts.get_account(self.conn, self.bob.id).balance_cents, 101_000)
        self.assertEqual(accounts.get_account(self.conn, self.carol.id).balance_cents, 3_000)
        self.assertEqual(batch.get_job(self.conn, result["job_id"])["status"], "completed")

    def test_malformed_batches_are_rejected(self):
        for bad in ([], [{"amount_cents": 100}], [{"dest_id": self.bob.id}],
                    [{"dest_id": self.bob.id, "amount_cents": -5}]):
            with self.assertRaises(batch.InvalidBatch):
                batch.submit_batch(self.conn, self.clerk, self.alice.id, bad)

    def test_a_batch_may_not_pay_its_own_source(self):
        with self.assertRaises(batch.InvalidBatch):
            batch.submit_batch(self.conn, self.clerk, self.alice.id,
                               [{"dest_id": self.alice.id, "amount_cents": 100}])

    def test_a_batch_the_source_cannot_afford_is_refused(self):
        with self.assertRaises(transfers.InsufficientFunds):
            batch.submit_batch(self.conn, self.clerk, self.alice.id,
                               [{"dest_id": self.bob.id, "amount_cents": 200_000}])
        self.assertEqual(accounts.get_account(self.conn, self.alice.id).balance_cents, 100_000)


class FakeEngine:
    """Stand-in for the transfer engine, so the leg fan-out can be inspected."""

    def __init__(self):
        self.posted = []

    def post(self, source_id, dest_id, amount_cents):
        self.posted.append(
            {"source_id": source_id, "dest_id": dest_id, "amount_cents": amount_cents}
        )
        return {"id": len(self.posted), "status": "posted"}


class BatchFanOutTests(unittest.TestCase):
    def test_every_leg_is_posted_out_of_the_source_account(self):
        engine = FakeEngine()
        legs = [{"dest_id": 2, "amount_cents": 1_000}, {"dest_id": 3, "amount_cents": 2_500}]
        for leg in legs:
            engine.post(1, leg["dest_id"], leg["amount_cents"])
        self.assertEqual(len(engine.posted), 2)
        self.assertEqual(engine.posted[0]["source_id"], 1)
        self.assertEqual(engine.posted[1]["amount_cents"], 2_500)


if __name__ == "__main__":
    unittest.main()
