# piper-e2e-app

Synthetic test app used by PIPER's end-to-end test suite.

This directory is mounted into the SSH fixture container at `/opt/piper-e2e-app/`
and the `app.log` is also copied to `/var/log/piper-e2e/app.log` so PIPER actions
can probe it via `logs.tail` and `system.list_dir`.
