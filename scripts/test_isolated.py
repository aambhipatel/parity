"""Run the public synthetic suite against copied source and disposable storage."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    root = Path(__file__).resolve().parents[1]
    if '--worker' in sys.argv:
        if os.environ.get('APP_SYNTHETIC_TEST_ROOT') != str(Path.cwd().resolve()):
            raise SystemExit('Worker requires the copying runner.')
        import socket
        import unittest
        from unittest.mock import MagicMock, patch
        import pandas as pd
        ticker = MagicMock()
        ticker.info = ticker.fast_info = {'regularMarketPrice': 1.0}
        ticker.history.return_value = pd.DataFrame({'Close': [1.0]})
        with patch('yfinance.Ticker', return_value=ticker), \
             patch('yfinance.download', return_value=pd.DataFrame()), \
             patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden')):
            result = unittest.TextTestRunner(verbosity=2).run(
                unittest.defaultTestLoader.discover('tests'))
        raise SystemExit(not result.wasSuccessful() or bool(result.skipped))
    scratch = root / 'scratch' / 'synthetic-tests'
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=scratch) as directory:
        work = Path(directory).resolve()
        for name in ('models', 'services', 'utils', 'controllers', 'scripts', 'tests'):
            shutil.copytree(root/name, work/name, ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copy2(root/'server.py', work/'server.py')
        env = dict(os.environ, APP_SYNTHETIC_TEST_ROOT=str(work), PYTHONDONTWRITEBYTECODE='1')
        (work/'temp').mkdir()
        env['TMP'] = env['TEMP'] = str(work/'temp')
        env['PYTHONPATH'] = os.pathsep.join([str(work), os.environ.get('PYTHONPATH', '')])
        result = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()), '--worker'],
                                cwd=work, env=env)
        raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
