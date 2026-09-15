import unittest

from check_secrets import scan

# Test inputs are assembled at runtime so this file never contains a credential-shaped literal.
FAKE_GITHUB = "ghp" + "_" + "a1B2" * 9
FAKE_AWS = "AKIA" + "ABCDEFGHIJKLMNOP"
FAKE_ASSIGN = "NATIVE_LAND_API_KEY=" + "x7" * 10
FAKE_PEM = "-----BEGIN RSA " + "PRIVATE KEY-----"


class ScanTest(unittest.TestCase):
    def test_key_named_files_fail(self):
        for name in ["CARTO_BASEMAPS_KEY", "app/.env/STRIPE_SECRET", "deploy_token.txt", "x/GH_TOKEN.json"]:
            self.assertTrue(scan(name, ""), name)
        for name in ["keyboard.ts", "app/src/schema/columns.ts", "docs/tokens.md", "pipeline/key_test.py"]:
            self.assertFalse(scan(name, ""), name)

    def test_credential_content_fails(self):
        for text in [FAKE_GITHUB, f"aws = {FAKE_AWS}", FAKE_ASSIGN, FAKE_PEM]:
            self.assertTrue(scan("notes.txt", text), text[:12])

    def test_references_and_allowlisted_lines_pass(self):
        ok = [
            "CARTO_BASEMAPS_KEY: ${{ vars.CARTO_BASEMAPS_KEY }}",
            "const key = import.meta.env.CARTO_BASEMAPS_KEY;",
            "CARTO_BASEMAPS_KEY=... npm run build",
            f"{FAKE_ASSIGN}  # secret-scan: allow",
            '"data": "BAMCAf7///////9/AAAAgA=="',
        ]
        for text in ok:
            self.assertFalse(scan("x.yml", text), text)


if __name__ == "__main__":
    unittest.main()
