import time
import unittest

import jwt


class OptionsIsolationRegression(unittest.TestCase):
    def test_reused_options_do_not_disable_verified_claims(self):
        self.assertEqual(jwt.__version__, "2.15.1")
        secret = "fixture-only-secret-at-least-thirty-two-bytes"
        expired = jwt.encode({"exp": int(time.time()) - 3600}, secret, algorithm="HS256")
        for decode in (jwt.decode, jwt.decode_complete):
            with self.subTest(decode=decode.__name__):
                options = {"verify_signature": False}
                decode(expired, options=options)
                self.assertEqual(options, {"verify_signature": False})
                options["verify_signature"] = True
                with self.assertRaises(jwt.ExpiredSignatureError):
                    decode(expired, secret, algorithms=["HS256"], options=options)
                self.assertEqual(options, {"verify_signature": True})


if __name__ == "__main__":
    unittest.main()
