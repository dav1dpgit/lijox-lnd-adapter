#!/usr/bin/env bash
# vps-setup.sh — run ONCE on the rented server, as root:  bash vps-setup.sh <NODE_PUBLIC_KEY>
# Installs WireGuard, makes this server's key pair, writes /etc/wireguard/wg0.conf from
# the template beside this script (or a built-in copy), opens forwarding of TCP 9735 to
# the home node, starts the tunnel, and prints this server's public key.
set -euo pipefail
NODE_PUB="${1:-}"
if [[ -z "$NODE_PUB" ]]; then echo "usage: bash vps-setup.sh <NODE_PUBLIC_KEY>   (from /etc/wireguard/node.pub on the home node)"; exit 1; fi
if [[ $EUID -ne 0 ]]; then echo "run as root"; exit 1; fi
apt-get update -qq && apt-get install -y -qq wireguard iptables >/dev/null
umask 077
mkdir -p /etc/wireguard
if [[ ! -f /etc/wireguard/vps.key ]]; then wg genkey > /etc/wireguard/vps.key; fi
wg pubkey < /etc/wireguard/vps.key > /etc/wireguard/vps.pub
VPS_PRIV="$(cat /etc/wireguard/vps.key)"
# the public interface: the one that carries the default route
PUB_IF="$(ip -o -4 route show to default | awk '{print $5}' | head -1)"
if [[ -z "$PUB_IF" ]]; then echo "could not find the public interface; set PUBLIC_IFACE by hand in wg0.conf"; PUB_IF="eth0"; fi
TEMPLATE="$(dirname "$0")/wg0-vps.conf"
if [[ -f "$TEMPLATE" ]]; then CONF="$(cat "$TEMPLATE")"; else
CONF='[Interface]
Address = 10.9.0.1/24
ListenPort = 51820
PrivateKey = <VPS_PRIVATE_KEY>
PostUp   = sysctl -w net.ipv4.ip_forward=1; iptables -t nat -A PREROUTING -i <PUBLIC_IFACE> -p tcp --dport 9735 -j DNAT --to-destination 10.9.0.2:9735; iptables -t nat -A POSTROUTING -o wg0 -j MASQUERADE
PostDown = iptables -t nat -D PREROUTING -i <PUBLIC_IFACE> -p tcp --dport 9735 -j DNAT --to-destination 10.9.0.2:9735; iptables -t nat -D POSTROUTING -o wg0 -j MASQUERADE

[Peer]
PublicKey = <NODE_PUBLIC_KEY>
AllowedIPs = 10.9.0.2/32'
fi
CONF="${CONF//<VPS_PRIVATE_KEY>/$VPS_PRIV}"
CONF="${CONF//<PUBLIC_IFACE>/$PUB_IF}"
CONF="${CONF//<NODE_PUBLIC_KEY>/$NODE_PUB}"
if [[ -f /etc/wireguard/wg0.conf ]]; then cp /etc/wireguard/wg0.conf "/etc/wireguard/wg0.conf.bak-$(date +%F-%H%M%S)"; fi
printf '%s\n' "$CONF" > /etc/wireguard/wg0.conf
chmod 600 /etc/wireguard/wg0.conf
systemctl enable --now wg-quick@wg0 >/dev/null 2>&1 || (systemctl restart wg-quick@wg0)
# a host firewall, if ufw is present: allow ssh, the tunnel port and 9735
if command -v ufw >/dev/null 2>&1; then ufw allow 22/tcp >/dev/null; ufw allow 51820/udp >/dev/null; ufw allow 9735/tcp >/dev/null; fi
echo "public interface: $PUB_IF"
echo "VPS public key: $(cat /etc/wireguard/vps.pub)"
echo "tunnel: $(wg show wg0 2>/dev/null | head -3 | tr '\n' ' ')"
echo "next: on the home node write /etc/wireguard/wg0.conf from wg0-node.conf with this public key and <VPS_IP>=$(curl -s -4 https://icanhazip.com 2>/dev/null || echo '<VPS_IP>'), then: sudo systemctl enable --now wg-quick@wg0"
