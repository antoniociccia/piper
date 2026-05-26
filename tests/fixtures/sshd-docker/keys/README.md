# Test-only SSH keypair

This directory holds an ed25519 keypair (`piper-e2e-test` + `.pub`) used ONLY by the
PIPER end-to-end test suite to authenticate against the local `piper-e2e-sshd`
Docker container.

The keypair is **regenerated on first run** by `scripts/e2e-setup.sh` and is
git-ignored. It has no value outside this fixture and is not used to authenticate
against any real system. Never use it for anything else.
