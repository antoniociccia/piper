FROM debian:bookworm-slim

# A realistic prod-host toolset — what PIPER expects to find when it SSHes in.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server \
      ca-certificates \
      curl \
      vim-tiny \
      htop \
      lsof \
      jq \
      sysstat \
      procps \
      iproute2 \
      net-tools \
      less \
      iputils-ping \
      sudo \
      tzdata && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /run/sshd

# Standard "deploy" user. Key-auth only. Passwordless sudo (NOPASSWD) so
# PIPER's reactive `sudo -n` elevation works without a TTY password prompt —
# the docker shim refuses non-root callers, and sudo is the escape hatch.
RUN useradd -m -s /bin/bash -G sudo deploy && \
    passwd -l deploy && \
    echo 'deploy ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/deploy && \
    chmod 440 /etc/sudoers.d/deploy

# Pinned host keys: generated once by demo/setup.sh and baked into the image
# so the fingerprint stays stable across rebuilds.
COPY host-keys/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key
COPY host-keys/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ed25519_key.pub
COPY host-keys/ssh_host_rsa_key /etc/ssh/ssh_host_rsa_key
COPY host-keys/ssh_host_rsa_key.pub /etc/ssh/ssh_host_rsa_key.pub
RUN chmod 600 /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_rsa_key && \
    chmod 644 /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_rsa_key.pub

# Authorized key for the deploy user.
COPY keys/piper-demo.pub /home/deploy/.ssh/authorized_keys

# Hardened sshd: no passwords, no root, no agent forwarding.
RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && \
    sed -i 's/^#\?AllowAgentForwarding.*/AllowAgentForwarding no/' /etc/ssh/sshd_config && \
    sed -i 's/^#\?X11Forwarding.*/X11Forwarding no/' /etc/ssh/sshd_config && \
    sed -i 's|^#\?PrintMotd.*|PrintMotd yes|' /etc/ssh/sshd_config

# Bake in the "production server" filesystem: motd, app dir, logs, entrypoint.
COPY fakefs/etc/motd /etc/motd
COPY fakefs/opt/orderly/ /opt/orderly/
COPY fakefs/var/log/orderly/ /var/log/orderly/
COPY fakefs/var/log/nginx/ /var/log/nginx/
COPY fakefs/etc/cron.d/orderly-backup /etc/cron.d/orderly-backup
COPY fakefs/usr/local/sbin/demo-entrypoint.sh /usr/local/sbin/demo-entrypoint.sh

# An expired TLS certificate for the nginx vhost. The file is a placeholder —
# the evidence PIPER actually reads is the [emerg] line in
# /var/log/nginx/error.log — but the path has to exist, with a stale mtime, so
# `system.file_stat` corroborates the log instead of reporting "no such file".
RUN mkdir -p /etc/nginx/ssl && \
    printf '%s\n' '-----BEGIN CERTIFICATE-----' \
      'PIPER-DEMO-PLACEHOLDER-CERTIFICATE-NOT-A-REAL-KEYPAIR' \
      '-----END CERTIFICATE-----' > /etc/nginx/ssl/orderly.crt && \
    touch -d '2025-04-30 00:00:00' /etc/nginx/ssl/orderly.crt && \
    chmod 644 /etc/nginx/ssl/orderly.crt

# A log that outgrew its rotation. Real bytes on disk, so `ls -la` and
# `system.file_stat` report a genuinely large file rather than a made-up size.
RUN head -c 48000000 /dev/urandom | base64 > /var/log/orderly/debug-trace.log && \
    chmod 644 /var/log/orderly/debug-trace.log

# `piper-docker-shim` — DEMO STUB. NOT DOCKER. Static-output emulator that
# mimics the SHAPE of `docker ps / logs / inspect / compose ps|up|restart` so
# PIPER's catalog can target the demo host without a real Docker daemon.
# It refuses non-root callers (like a real Docker socket), which is what
# triggers PIPER's reactive-sudo proposal during the demo.
# See the header of demo/fakefs/usr/local/bin/piper-docker-shim for the
# trademark / fair-use disclosure. A `docker` symlink is provided ONLY so
# PIPER's argv (`docker ps …`) resolves; the shim never claims to BE Docker.
COPY fakefs/usr/local/bin/piper-docker-shim /usr/local/bin/piper-docker-shim
RUN ln -s /usr/local/bin/piper-docker-shim /usr/local/bin/docker

# Ownership + perms.
RUN chown -R deploy:deploy /home/deploy/.ssh /opt/orderly && \
    chmod 700 /home/deploy/.ssh && \
    chmod 600 /home/deploy/.ssh/authorized_keys && \
    chmod 755 /usr/local/sbin/demo-entrypoint.sh /usr/local/bin/piper-docker-shim && \
    chmod 644 /var/log/orderly/app.log /var/log/orderly/worker.log /var/log/nginx/access.log

EXPOSE 22
CMD ["/usr/local/sbin/demo-entrypoint.sh"]
