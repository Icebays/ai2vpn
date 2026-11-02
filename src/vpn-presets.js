'use strict';
/** Help texts for common VPN providers + a NordLynx (NordVPN WireGuard) config generator. */

const PRESETS = [
  {
    id: 'surfshark',
    name: 'Surfshark',
    modes: ['wireguard', 'openvpn'],
    help:
      'WireGuard: my.surfshark.com → VPN → Manual setup → Router → WireGuard → "I don\'t have a key pair" → generate keys → pick a location → Download the .conf and paste it here.\n' +
      'OpenVPN: my.surfshark.com → Manual setup → Router → OpenVPN → copy the service username/password (NOT your login) and download a location .ovpn file.',
  },
  {
    id: 'nordvpn',
    name: 'NordVPN',
    modes: ['wireguard', 'openvpn'],
    help:
      'WireGuard (NordLynx): Nord Account → NordVPN → "Set up NordVPN manually" → generate an access token, then use the generator below.\n' +
      'OpenVPN: same page → copy the service credentials; download a server .ovpn from nordvpn.com/ovpn.',
  },
  {
    id: 'mullvad',
    name: 'Mullvad',
    modes: ['wireguard', 'openvpn'],
    help:
      'WireGuard: mullvad.net → Account → WireGuard configuration → Linux → generate key → choose a server → download the .conf.\n' +
      'OpenVPN: mullvad.net → OpenVPN configuration. Username = your account number, password = m.',
  },
  {
    id: 'protonvpn',
    name: 'Proton VPN',
    modes: ['wireguard', 'openvpn'],
    help:
      'WireGuard: account.protonvpn.com → Downloads → WireGuard configuration → platform Router/GNU-Linux → create & download.\n' +
      'OpenVPN: Account → OpenVPN/IKEv2 username (service credentials) + download a .ovpn from Downloads.',
  },
  {
    id: 'pia',
    name: 'Private Internet Access',
    modes: ['openvpn'],
    help: 'OpenVPN: download the PIA OpenVPN config bundle and paste one .ovpn here. Username/password = your PIA login (p1234567).',
  },
  {
    id: 'expressvpn',
    name: 'ExpressVPN',
    modes: ['openvpn'],
    help: 'OpenVPN: expressvpn.com → Set up other devices → Manual configuration → OpenVPN → copy the username/password and download a location .ovpn.',
  },
  {
    id: 'windscribe',
    name: 'Windscribe',
    modes: ['wireguard', 'openvpn'],
    help: 'windscribe.com → Config generators → WireGuard (or OpenVPN; OpenVPN also shows service credentials).',
  },
  {
    id: 'ivpn',
    name: 'IVPN',
    modes: ['wireguard', 'openvpn'],
    help: 'ivpn.net → Account → WireGuard → Configuration file generator (or OpenVPN; username = account ID, password = ivpn).',
  },
  {
    id: 'cyberghost',
    name: 'CyberGhost',
    modes: ['openvpn'],
    help: 'CyberGhost account → My Devices → Configure device → OpenVPN (router) → download the zip; paste the .ovpn (with certs inline) and the generated username/password.',
  },
  { id: 'custom', name: 'Other / self-hosted', modes: ['wireguard', 'openvpn'], help: 'Paste any standard WireGuard .conf or OpenVPN .ovpn (certificates must be inline).' },
];

async function getJson(url, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: ctl.signal });
    if (!r.ok) throw new Error(`${new URL(url).pathname}: HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** Build a WireGuard config for NordVPN from an access token. */
async function nordlynxConfig({ token, country }) {
  if (!token) throw new Error('NordVPN access token required');
  const auth = 'Basic ' + Buffer.from(`token:${token.trim()}`).toString('base64');
  const creds = await getJson('https://api.nordvpn.com/v1/users/services/credentials', { authorization: auth });
  const privateKey = creds.nordlynx_private_key;
  if (!privateKey) throw new Error('No nordlynx_private_key in NordVPN response (is the token valid?)');
  let q = 'filters[servers_technologies][identifier]=wireguard_udp&limit=1';
  if (country) {
    const countries = await getJson('https://api.nordvpn.com/v1/servers/countries');
    const c = countries.find((x) => x.code.toLowerCase() === country.toLowerCase() || x.name.toLowerCase() === country.toLowerCase());
    if (!c) throw new Error(`Unknown country '${country}'`);
    q += `&filters[country_id]=${c.id}`;
  }
  const servers = await getJson(`https://api.nordvpn.com/v1/servers/recommendations?${q}`);
  const s = servers[0];
  if (!s) throw new Error('NordVPN returned no WireGuard server');
  const tech = (s.technologies || []).find((t) => t.identifier === 'wireguard_udp');
  const pub = tech && (tech.metadata || []).find((m) => m.name === 'public_key');
  if (!pub) throw new Error('Server has no WireGuard public key');
  return {
    server: s.hostname,
    config: [
      `# NordLynx ${s.hostname} (${s.locations?.[0]?.country?.name || ''})`,
      '[Interface]',
      `PrivateKey = ${privateKey}`,
      'Address = 10.5.0.2/32',
      'DNS = 103.86.96.100, 103.86.99.100',
      '',
      '[Peer]',
      `PublicKey = ${pub.value}`,
      `Endpoint = ${s.station}:51820`,
      'AllowedIPs = 0.0.0.0/0',
      'PersistentKeepalive = 25',
      '',
    ].join('\n'),
  };
}

module.exports = { PRESETS, nordlynxConfig };
