"""Guard public database tests; reference-data validation lives outside Git."""
import os
from pathlib import Path
import unittest

if os.environ.get('APP_SYNTHETIC_TEST_ROOT') != str(Path.cwd().resolve()):
    raise RuntimeError('Run python -B scripts/test_isolated.py; direct discovery is unsafe.')


class IsolatedTestCase(unittest.TestCase):
    pass
