import unittest

from ledger import statements, transfers
from support import WINDOW_END, WINDOW_START, make_accounts, make_db, make_tokens, principal


class StatementTests(unittest.TestCase):
    def setUp(self):
        self.conn = make_db()
        self.alice, self.bob = make_accounts(self.conn)
        make_tokens(self.conn)
        self.clerk = principal(self.conn, "clerk")
        transfers.execute_transfer(self.conn, self.alice.id, self.bob.id, 10_000,
                                   memo="invoice 7", actor=self.clerk.name)
        transfers.execute_transfer(self.conn, self.bob.id, self.alice.id, 2_500,
                                   memo="partial", category="settlement",
                                   actor=self.clerk.name)

    def export(self, **kwargs):
        return statements.export_statement(
            self.conn, self.alice.id, WINDOW_START, WINDOW_END, **kwargs
        )

    def test_month_bounds_cover_the_whole_month(self):
        self.assertEqual(
            statements.month_bounds(2024, 2),
            ("2024-02-01 00:00:00", "2024-03-01 00:00:00"),
        )
        with self.assertRaises(statements.InvalidStatement):
            statements.month_bounds(2024, 13)

    def test_the_csv_has_a_header_and_one_line_per_transfer(self):
        lines = self.export().strip().split("\n")
        self.assertEqual(lines[0].split(",")[:3], ["date", "transfer_id", "direction"])
        self.assertEqual(len(lines), 3)
        self.assertIn("out", lines[1])
        self.assertIn("in", lines[2])

    def test_amounts_are_rendered_as_decimal_strings(self):
        rows = statements.statement_rows(self.conn, self.alice.id, WINDOW_START, WINDOW_END)
        lines = statements.statement_lines(self.conn, self.alice.id, rows)
        self.assertEqual(lines[0]["amount"], "100.00")
        self.assertEqual(lines[0]["fee"], "0.25")
        self.assertEqual(lines[0]["counterparty"], "Bob")
        self.assertEqual(lines[0]["balance_effect"], "-100.25")

    def test_totals_net_out_credits_debits_and_fees(self):
        totals = statements.statement_totals(self.conn, self.alice.id,
                                             WINDOW_START, WINDOW_END)
        self.assertEqual(totals["transfers"], 2)
        self.assertEqual(totals["credited_cents"], 2_500)
        self.assertEqual(totals["debited_cents"], 10_000)
        self.assertEqual(totals["fee_cents"], 25)
        self.assertEqual(totals["net"], "-75.25")

    def test_a_statement_can_be_narrowed_to_one_category(self):
        rows = statements.statement_rows(self.conn, self.alice.id, WINDOW_START,
                                         WINDOW_END, category="settlement")
        self.assertEqual([row["memo"] for row in rows], ["partial"])


if __name__ == "__main__":
    unittest.main()
