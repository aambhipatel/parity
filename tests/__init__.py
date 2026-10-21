"""Make default unittest discovery fail clearly outside the copying runner."""
import os
from pathlib import Path

if os.environ.get('APP_SYNTHETIC_TEST_ROOT') != str(Path.cwd().resolve()):
    raise RuntimeError('Run python -B scripts/test_isolated.py; direct discovery is unsafe.')
