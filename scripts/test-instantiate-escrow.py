#!/usr/bin/env python3
"""Exercise deploy argument handling without a node, signing key, or transaction."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("instantiate-escrow.sh")
CW721 = "cosmos12gsv9tmjhhg86wg9fnd9cnju28jx3fxva9cn8dh9meketkfxxajqmg3exz"
ADMIN = "cosmos1reece3m8g4m3d0qrpj93rnnseudnpzhrey64rr"


class InstantiateEscrowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        directory = Path(self.tmp.name)
        self.calls = directory / "calls.jsonl"
        gaiad = directory / "gaiad"
        gaiad.write_text("""#!/usr/bin/env python3
import json, os, sys
with open(os.environ['MOCK_GAIAD_CALLS'], 'a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1:3] == ['debug', 'addr'] and os.environ.get('MOCK_BAD_CHECKSUM'):
    sys.exit(1)
""")
        gaiad.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{directory}:{os.environ['PATH']}",
                    "CW721": CW721, "ADMIN": ADMIN, "FROM_KEY": "test-only-key",
                    "NODE": "https://node.example.invalid", "MOCK_GAIAD_CALLS": str(self.calls)}

    def run_script(self, *args, env=None):
        return subprocess.run(["bash", str(SCRIPT), *args], env=env or self.env,
                              capture_output=True, text=True)

    def transactions(self):
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []
        return [call for call in calls if call[0] == "tx"]

    def test_explicit_production_collection_and_temporary_wasm_admin(self):
        result = self.run_script("812", "Bad Kids escrow")
        self.assertEqual(result.returncode, 0, result.stderr)
        [args] = self.transactions()
        self.assertEqual(args[:4], ["tx", "wasm", "instantiate", "812"])
        self.assertEqual(json.loads(args[4]), {"cw721": CW721, "admin": ADMIN})
        for flag, value in [("--label", "Bad Kids escrow"), ("--from", "test-only-key"),
                            ("--node", "https://node.example.invalid"), ("--chain-id", "cosmoshub-4")]:
            self.assertEqual(args[args.index(flag) + 1], value)
        self.assertEqual(args[args.index("--admin") + 1], ADMIN)
        self.assertNotIn("--no-admin", args)

    def test_missing_configuration_never_sends(self):
        for name in ["CW721", "ADMIN", "FROM_KEY"]:
            with self.subTest(name=name):
                env = dict(self.env)
                env.pop(name)
                self.assertNotEqual(self.run_script("812", env=env).returncode, 0)
        self.assertEqual(self.transactions(), [])

    def test_invalid_id_or_address_never_sends(self):
        for code_id in ["0", "-1", "12x", ""]:
            self.assertNotEqual(self.run_script(code_id).returncode, 0)
        self.assertNotEqual(self.run_script("812", env={**self.env, "CW721": 'cosmos1bad"'}).returncode, 0)
        self.assertNotEqual(self.run_script("812", env={**self.env, "MOCK_BAD_CHECKSUM": "1"}).returncode, 0)
        self.assertEqual(self.transactions(), [])


if __name__ == "__main__":
    unittest.main()
