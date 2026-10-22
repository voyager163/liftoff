"""Check the installed CA bundle for GHSA-6q48-6c7w-9gw2 without network access."""

from importlib.metadata import version
import ssl

import certifi

assert version("certifi") == "2026.10.19"
context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
context.load_verify_locations(cafile=certifi.where())
assert context.verify_mode == ssl.CERT_REQUIRED
assert context.check_hostname
trusted_names = {
    value
    for certificate in context.get_ca_certs()
    for relative_name in certificate["subject"]
    for key, value in relative_name
    if key == "commonName"
}
assert "emSign ECC Root CA - G3" not in trusted_names, (
    "The compromised emSign ECC Root CA - G3 is still trusted."
)
assert {
    "emSign ECC Root CA - C3",
    "emSign Root CA - C1",
    "emSign Root CA - G1",
    "ISRG Root X1",
}.issubset(trusted_names), "The patched bundle must retain unaffected trusted roots."
print("Certifi 2026.10.19 rejects the compromised root and retains unaffected roots.")
