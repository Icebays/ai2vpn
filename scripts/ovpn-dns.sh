#!/bin/sh
# OpenVPN --up hook: write the DNS servers pushed by the VPN server to /etc/resolv.conf.
# If the user configured DNS servers in the web UI (A2V_DNS), the app writes those instead.
[ -n "$A2V_DNS" ] && exit 0
servers=""
i=1
while :; do
  eval opt="\$foreign_option_$i"
  [ -z "$opt" ] && break
  case "$opt" in
    "dhcp-option DNS "*) servers="$servers ${opt#dhcp-option DNS }" ;;
  esac
  i=$((i + 1))
done
[ -z "$servers" ] && servers="1.1.1.1 9.9.9.9"
{
  for s in $servers; do echo "nameserver $s"; done
  echo "options timeout:2 attempts:2"
} > /etc/resolv.conf
exit 0
