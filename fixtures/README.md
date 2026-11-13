# Test fixtures

Everything under `malicious/` and `rugpull/after/` imitates real attack patterns so that the
rules have something to fire on. The fixtures are inert:

- they are never installed, built or executed (the scanner is static, and so are the tests);
- dependencies are not declared or not installed, so the servers cannot start;
- every host uses the reserved `.invalid` top-level domain (RFC 2606), which never resolves.

Everything under `clean/` and `rugpull/before/` must produce zero findings.
