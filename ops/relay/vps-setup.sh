#!/usr/bin/env bash
# vps-setup.sh — run ONCE on the rented server, as root:  bash vps-setup.sh <NODE_PUBLIC_KEY>
# Installs WireGuard and HAProxy, makes this server's key pair, writes /etc/wireguard/wg0.conf from the template
# beside this script (or a built-in copy), puts haproxy.cfg in place (a dated backup of the distribution's file),
# starts both, and prints this server's public key. Nothing here ends TLS or keeps logs of who connected.
set -euo pipefail
NODE_PUB="${1:-}"
if [[ -z "$NODE_PUB" ]]; then echo "usage: bash vps-setup.sh <NODE_PUBLIC_KEY>   (from /etc/wireguard/node.pub on the home node)"; exit 1; fi
if [[ $EUID -ne 0 ]]; then echo "run as root"; exit 1; fi
apt-get update -qq && apt-get install -y -qq wireguard haproxy >/dev/null
umask 077
mkdir -p /etc/wireguard
if [[ ! -f /etc/wireguard/vps.key ]]; then wg genkey > /etc/wireguard/vps.key; fi
wg pubkey < /etc/wireguard/vps.key > /etc/wireguard/vps.pub
VPS_PRIV="$(cat /etc/wireguard/vps.key)"
HERE="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="$HERE/wg0-vps.conf"
if [[ -f "$TEMPLATE" ]]; then CONF="$(grep -v '^#' "$TEMPLATE")"; else
CONF='[Interface]
Address = 10.9.0.1/24
ListenPort = 51820
PrivateKey = <VPS_PRIVATE_KEY>

[Peer]
PublicKey = <NODE_PUBLIC_KEY>
AllowedIPs = 10.9.0.2/32'
fi
CONF="${CONF//<VPS_PRIVATE_KEY>/$VPS_PRIV}"
CONF="${CONF//<NODE_PUBLIC_KEY>/$NODE_PUB}"
if [[ -f /etc/wireguard/wg0.conf ]]; then cp /etc/wireguard/wg0.conf "/etc/wireguard/wg0.conf.bak-$(date +%F-%H%M%S)"; fi
printf '%s\n' "$CONF" > /etc/wireguard/wg0.conf
chmod 600 /etc/wireguard/wg0.conf
systemctl enable --now wg-quick@wg0 >/dev/null 2>&1 || systemctl restart wg-quick@wg0
# HAProxy: the two blind relays (:443 with PROXY protocol v2, :9735 plain) to 10.9.0.2
if [[ -f "$HERE/haproxy.cfg" ]]; then
  cp /etc/haproxy/haproxy.cfg "/etc/haproxy/haproxy.cfg.bak-$(date +%F-%H%M%S)" 2>/dev/null || true
  install -m 644 "$HERE/haproxy.cfg" /etc/haproxy/haproxy.cfg
  haproxy -c -f /etc/haproxy/haproxy.cfg
  systemctl enable --now haproxy >/dev/null 2>&1; systemctl restart haproxy
else
  echo "haproxy.cfg not found beside this script — put it at /etc/haproxy/haproxy.cfg by hand, then: systemctl restart haproxy"
fi
# a host firewall, if ufw is present: ssh, the tunnel port, and the two relayed ports
if command -v ufw >/dev/null 2>&1; then ufw allow 22/tcp >/dev/null; ufw allow 51820/udp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 9735/tcp >/dev/null; fi
echo "VPS public key: $(cat /etc/wireguard/vps.pub)"
echo "tunnel: $(wg show wg0 2>/dev/null | head -3 | tr '\n' ' ')"
echo "haproxy: $(systemctl is-active haproxy)"
echo "next: on the home node write /etc/wireguard/wg0.conf from wg0-node.conf with this public key and <VPS_IP>=$(curl -s -4 https://icanhazip.com 2>/dev/null || echo '<VPS_IP>'), then: sudo systemctl enable --now wg-quick@wg0"
