"""Characterize every accounting statement, not only mutation entry points."""
from isolated_support import IsolatedTestCase
import json
from pathlib import Path
from diagnostic_ast import fingerprints


class TestAccountingAST(IsolatedTestCase):
    def test_all_calculation_modules_match_pre_diagnostic_ast(self):
        expected = json.loads((Path(__file__).parent / 'accounting_ast.json').read_text(encoding='utf-8'))
        for name, hashes in expected.items():
            with self.subTest(module=name):
                self.assertEqual(fingerprints(Path(name).read_text(encoding='utf-8')), hashes)

    def test_projection_detects_changed_accounting_assignment(self):
        source = Path('services/options_fifo.py').read_text(encoding='utf-8')
        changed = source.replace("pos['realized_pl'] = Decimal('0.0')", "pos['realized_pl'] = Decimal('1.0')", 1)
        self.assertNotEqual(fingerprints(source), fingerprints(changed))
