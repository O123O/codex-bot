#!/bin/sh
set -eu
umask 077

authorized_key_source=/run/qiyan/authorized_key.pub
host_key=/var/lib/ssh-host-keys/ssh_host_ed25519_key

install -d -m 0755 /run/sshd
install -d -m 0700 -o codex -g codex /home/codex/.codex /home/codex/projects
install -d -m 0700 -o root -g root /var/lib/ssh-host-keys

ssh-keygen -l -f "$authorized_key_source" >/dev/null
install -m 0600 -o codex -g codex "$authorized_key_source" /home/codex/.ssh/authorized_keys

if [ ! -f "$host_key" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$host_key"
fi
chown root:root "$host_key"
chmod 0600 "$host_key"
if [ -f "$host_key.pub" ]; then
  chown root:root "$host_key.pub"
  chmod 0644 "$host_key.pub"
fi

/usr/sbin/sshd -t -f /etc/ssh/sshd_config
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
