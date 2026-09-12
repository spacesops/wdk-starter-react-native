#!/bin/bash
# Test Electrs/Electrum connectivity using EXPO_PUBLIC_ELECTRS_* from .env
#
# Usage:
#   ./scripts/test-electrs.sh
#   ./scripts/test-electrs.sh [path-to-env]
#   ./scripts/test-electrs.sh --scripthash <64-char-hex>
#
# Reads:
#   EXPO_PUBLIC_ELECTRS_HOST
#   EXPO_PUBLIC_ELECTRS_PORT
#   EXPO_PUBLIC_ELECTRS_PROTOCOL   (tcp | tls | ssl; default tcp)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${1:-$PROJECT_ROOT/.env}"
SCRIPTHASH=""

if [[ "${1:-}" == "--scripthash" ]]; then
  SCRIPTHASH="${2:-}"
  ENV_FILE="$PROJECT_ROOT/.env"
elif [[ "${1:-}" == --* ]]; then
  echo "Unknown option: $1"
  exit 1
elif [[ -n "${1:-}" && -f "$1" ]]; then
  ENV_FILE="$1"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env file not found at $ENV_FILE"
  exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  if [[ "$line" =~ ^[[:space:]]*([^=]+)=(.*)$ ]]; then
    export "${BASH_REMATCH[1]}"="${BASH_REMATCH[2]}"
  fi
done < "$ENV_FILE"

HOST="${EXPO_PUBLIC_ELECTRS_HOST:-}"
PORT="${EXPO_PUBLIC_ELECTRS_PORT:-}"
PROTOCOL="${EXPO_PUBLIC_ELECTRS_PROTOCOL:-tcp}"

if [[ -z "$HOST" ]]; then
  echo "Error: EXPO_PUBLIC_ELECTRS_HOST not set in $ENV_FILE"
  exit 1
fi

if [[ -z "$PORT" ]]; then
  echo "Error: EXPO_PUBLIC_ELECTRS_PORT not set in $ENV_FILE"
  exit 1
fi

case "$PROTOCOL" in
  tcp|tls|ssl) ;;
  *)
    echo "Error: EXPO_PUBLIC_ELECTRS_PROTOCOL must be tcp, tls, or ssl (got: $PROTOCOL)"
    exit 1
    ;;
esac

echo "Testing Electrs / Electrum server"
echo "================================="
echo "Env file:  $ENV_FILE"
echo "Host:      $HOST"
echo "Port:      $PORT"
echo "Protocol:  $PROTOCOL"
echo "Network:   ${EXPO_PUBLIC_BITCOIN_NETWORK:-<not set>}"
echo ""

# Quick TCP reachability (works for tcp; tls still accepts TCP first)
if command -v nc >/dev/null 2>&1; then
  echo "1. TCP port check (nc -z -w 5)..."
  if nc -z -w 5 "$HOST" "$PORT" 2>/dev/null; then
    echo "   ✓ Port $PORT is open on $HOST"
  else
    echo "   ✗ Cannot reach $HOST:$PORT (firewall, tunnel, or host down?)"
    exit 1
  fi
  echo ""
else
  echo "1. Skipping nc port check (nc not installed)"
  echo ""
fi

echo "2. Electrum protocol (server.version + blockchain.headers.subscribe)..."

export ELECTRS_HOST="$HOST"
export ELECTRS_PORT="$PORT"
export ELECTRS_PROTOCOL="$PROTOCOL"
export ELECTRS_SCRIPTHASH="$SCRIPTHASH"

node <<'NODE'
const net = require('net');
const tls = require('tls');

const host = process.env.ELECTRS_HOST;
const port = Number(process.env.ELECTRS_PORT);
const protocol = (process.env.ELECTRS_PROTOCOL || 'tcp').toLowerCase();
const scripthash = (process.env.ELECTRS_SCRIPTHASH || '').trim();

function connect() {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    if (protocol === 'tls' || protocol === 'ssl') {
      const socket = tls.connect(
        { host, port, servername: host, rejectUnauthorized: false },
        () => resolve(socket)
      );
      socket.on('error', onError);
      return;
    }
    const socket = net.connect({ host, port }, () => resolve(socket));
    socket.on('error', onError);
  });
}

function electrumCall(socket, method, params, id) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timeout waiting for response to ${method}`));
    }, 15000);

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id === id) {
            clearTimeout(timeout);
            socket.removeListener('data', onData);
            if (msg.error) {
              reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
            } else {
              resolve(msg.result);
            }
            return;
          }
        } catch {
          // wait for full JSON line
        }
      }
    };

    socket.on('data', onData);
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

(async () => {
  let socket;
  try {
    socket = await connect();
    socket.setTimeout(15000);

    const version = await electrumCall(socket, 'server.version', ['spaces-wallet-test', '1.4'], 1);
    console.log(`   ✓ server.version → ${JSON.stringify(version)}`);

    const header = await electrumCall(socket, 'blockchain.headers.subscribe', [], 2);
    if (header && typeof header === 'object') {
      const height = header.height ?? '?';
      const hexLen = header.hex ? header.hex.length : 0;
      console.log(`   ✓ blockchain.headers.subscribe → height=${height}, header_bytes=${hexLen / 2}`);
    } else {
      console.log(`   ✓ blockchain.headers.subscribe → ${JSON.stringify(header)}`);
    }

    if (scripthash) {
      if (!/^[0-9a-fA-F]{64}$/.test(scripthash)) {
        throw new Error('--scripthash must be 64 hex characters');
      }
      const balance = await electrumCall(
        socket,
        'blockchain.scripthash.get_balance',
        [scripthash.toLowerCase()],
        3
      );
      console.log(`   ✓ blockchain.scripthash.get_balance → ${JSON.stringify(balance)}`);
    }

    socket.end();
    console.log('');
    console.log('Electrs test passed.');
  } catch (err) {
    if (socket && !socket.destroyed) socket.destroy();
    console.error('');
    console.error(`Electrs test failed: ${err.message}`);
    if (protocol === 'tcp') {
      console.error('Tip: if this server requires TLS, set EXPO_PUBLIC_ELECTRS_PROTOCOL=tls and port 50002.');
    }
    process.exit(1);
  }
})();
NODE
