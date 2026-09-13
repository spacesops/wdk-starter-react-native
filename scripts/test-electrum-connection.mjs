#!/usr/bin/env node
/**
 * Validate Electrum / Electrs reachability using the same env vars as the app
 * (get-chains-config.ts → bitcoin.host / port / protocol / network).
 *
 * Usage:
 *   node scripts/test-electrum-connection.mjs
 *   node scripts/test-electrum-connection.mjs --env /path/to/.env
 *   node scripts/test-electrum-connection.mjs --address bc1p...
 *   npm run test:electrum
 */

import fs from 'fs';
import path from 'path';
import net from 'net';
import tls from 'tls';
import dns from 'dns/promises';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as ecc from '@bitcoinerlab/secp256k1';
import { address as btcAddress, initEccLib, networks } from 'bitcoinjs-lib';

initEccLib(ecc);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_ENV = path.join(PROJECT_ROOT, '.env');
const REQUEST_TIMEOUT_MS = 15_000;
const TCP_TIMEOUT_MS = 5_000;

function parseArgs(argv) {
  const options = {
    envFile: DEFAULT_ENV,
    address: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--env') {
      options.envFile = argv[++i] ?? '';
    } else if (arg === '--address') {
      options.address = (argv[++i] ?? '').trim();
    } else if (!arg.startsWith('-') && fs.existsSync(arg)) {
      options.envFile = arg;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/test-electrum-connection.mjs [options] [path-to-.env]

Options:
  --env <file>       Path to .env (default: project .env)
  --address <addr>   Also run scripthash balance + UTXO queries (purchase compose path)
  -h, --help         Show this help

Reads (same as src/config/get-chains-config.ts):
  EXPO_PUBLIC_ELECTRS_HOST
  EXPO_PUBLIC_ELECTRS_PORT
  EXPO_PUBLIC_ELECTRS_PROTOCOL   tcp | tls | ssl
  EXPO_PUBLIC_BITCOIN_NETWORK    bitcoin | testnet | regtest
`);
}

function loadEnvFile(envFile) {
  if (!envFile || !fs.existsSync(envFile)) {
    throw new Error(`.env file not found: ${envFile || '(empty path)'}`);
  }

  const vars = {};
  const text = fs.readFileSync(envFile, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
    process.env[key] = value;
  }
  return vars;
}

function resolveBitcoinElectrumConfig(env) {
  const host = (env.EXPO_PUBLIC_ELECTRS_HOST ?? '').trim();
  const portRaw = (env.EXPO_PUBLIC_ELECTRS_PORT ?? '').trim();
  const protocol = (env.EXPO_PUBLIC_ELECTRS_PROTOCOL ?? 'tcp').trim().toLowerCase();
  const network = (env.EXPO_PUBLIC_BITCOIN_NETWORK ?? 'bitcoin').trim().toLowerCase();

  if (!host) {
    throw new Error('EXPO_PUBLIC_ELECTRS_HOST is not set in .env');
  }
  if (!portRaw) {
    throw new Error('EXPO_PUBLIC_ELECTRS_PORT is not set in .env');
  }

  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`EXPO_PUBLIC_ELECTRS_PORT must be a valid port (got: ${portRaw})`);
  }

  if (!['tcp', 'tls', 'ssl'].includes(protocol)) {
    throw new Error(
      `EXPO_PUBLIC_ELECTRS_PROTOCOL must be tcp, tls, or ssl (got: ${protocol})`
    );
  }

  if (!['bitcoin', 'testnet', 'regtest'].includes(network)) {
    throw new Error(
      `EXPO_PUBLIC_BITCOIN_NETWORK must be bitcoin, testnet, or regtest (got: ${network})`
    );
  }

  return { host, port, protocol, network };
}

function bitcoinJsNetwork(networkName) {
  switch (networkName) {
    case 'testnet':
      return networks.testnet;
    case 'regtest':
      return networks.regtest;
    default:
      return networks.bitcoin;
  }
}

function toScriptHash(address, networkName) {
  const script = btcAddress.toOutputScript(address, bitcoinJsNetwork(networkName));
  const hash = crypto.createHash('sha256').update(script).digest();
  return Buffer.from(hash).reverse().toString('hex');
}

function tcpProbe(host, port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function openSocket({ host, port, protocol, useSni = true }) {
  return new Promise((resolve, reject) => {
    if (protocol === 'tls' || protocol === 'ssl') {
      const tlsOptions = {
        host,
        port,
        rejectUnauthorized: false,
      };
      if (useSni) {
        tlsOptions.servername = host;
      }
      const socket = tls.connect(tlsOptions, () => resolve(socket));
      socket.once('error', reject);
      return;
    }

    const socket = net.connect({ host, port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

class ElectrumSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.buffer = '';
    this.pending = new Map();
    this.closed = false;

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', (err) => this._failAll(err));
  }

  _onData(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (msg.id == null) continue;
      const handler = this.pending.get(msg.id);
      if (!handler) continue;
      this.pending.delete(msg.id);
      if (msg.error) {
        handler.reject(new Error(`${handler.method}: ${JSON.stringify(msg.error)}`));
      } else {
        handler.resolve(msg.result);
      }
    }
  }

  _onClose() {
    this.closed = true;
    this._failAll(new Error('Connection to server lost, please retry'));
  }

  _failAll(err) {
    for (const [, handler] of this.pending) {
      handler.reject(err);
    }
    this.pending.clear();
  }

  async call(method, params = []) {
    if (this.closed) {
      throw new Error('Connection to server lost, please retry');
    }

    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  close() {
    if (!this.closed) {
      this.socket.end();
    }
  }
}

async function runStep(index, title, fn) {
  process.stdout.write(`${index}. ${title}... `);
  try {
    const detail = await fn();
    if (detail) {
      console.log(`✓ ${detail}`);
    } else {
      console.log('✓');
    }
    return true;
  } catch (err) {
    console.log('✗');
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const env = loadEnvFile(options.envFile);
  const config = resolveBitcoinElectrumConfig(env);

  console.log('Electrum connection test (Spaces Wallet .env)');
  console.log('===========================================');
  console.log(`Env file:   ${options.envFile}`);
  console.log(`Host:       ${config.host}`);
  console.log(`Port:       ${config.port}`);
  console.log(`Protocol:   ${config.protocol}`);
  console.log(`Network:    ${config.network}`);
  console.log(`TLS SNI:    servername=${config.host} (matches wdk-wallet-btc)`);
  if (options.address) {
    console.log(`Address:    ${options.address}`);
  }
  console.log('');

  const results = [];
  let session = null;

  results.push(
    await runStep(1, 'DNS resolve', async () => {
      const records = await dns.lookup(config.host, { all: true });
      const addrs = records.map((r) => `${r.address} (${r.family === 6 ? 'IPv6' : 'IPv4'})`);
      return addrs.join(', ');
    })
  );

  results.push(
    await runStep(2, 'TCP port reachable', async () => {
      await tcpProbe(config.host, config.port);
      return `${config.host}:${config.port}`;
    })
  );

  results.push(
    await runStep(3, 'TLS handshake (with SNI)', async () => {
      const socket = await openSocket({ ...config, useSni: true });
      const proto = socket.getProtocol?.() ?? 'tls';
      socket.end();
      return proto;
    })
  );

  results.push(
    await runStep(4, 'Electrum server.version', async () => {
      const socket = await openSocket({ ...config, useSni: true });
      session = new ElectrumSession(socket);
      const version = await session.call('server.version', [
        '@spacesops/wdk-wallet-btc',
        '1.4',
      ]);
      return JSON.stringify(version);
    })
  );

  results.push(
    await runStep(5, 'blockchain.headers.subscribe', async () => {
      const header = await session.call('blockchain.headers.subscribe', []);
      if (header && typeof header === 'object') {
        const height = header.height ?? '?';
        const bytes = header.hex ? header.hex.length / 2 : 0;
        return `height=${height}, header_bytes=${bytes}`;
      }
      return JSON.stringify(header);
    })
  );

  results.push(
    await runStep(6, 'blockchain.estimatefee (conf target 1)', async () => {
      const rate = await session.call('blockchain.estimatefee', [1]);
      if (rate === -1) {
        throw new Error('Fee estimation unavailable (-1)');
      }
      const satsPerVb = Math.round(rate * 100_000);
      return `${rate} BTC/kB (~${satsPerVb} sat/vB)`;
    })
  );

  results.push(
    await runStep(7, 'Sequential RPC burst (purchase compose path)', async () => {
      const fee = await session.call('blockchain.estimatefee', [1]);
      const header = await session.call('blockchain.headers.subscribe', []);
      const height = header?.height ?? '?';
      return `estimatefee=${fee}, headers.height=${height}`;
    })
  );

  if (options.address) {
    const scriptHash = toScriptHash(options.address, config.network);
    results.push(
      await runStep(8, 'blockchain.scripthash.get_balance', async () => {
        const balance = await session.call('blockchain.scripthash.get_balance', [
          scriptHash,
        ]);
        return `${JSON.stringify(balance)} (scripthash=${scriptHash.slice(0, 8)}…)`;
      })
    );

    results.push(
      await runStep(9, 'blockchain.scripthash.listunspent', async () => {
        const utxos = await session.call('blockchain.scripthash.listunspent', [
          scriptHash,
        ]);
        const count = Array.isArray(utxos) ? utxos.length : 0;
        const funded = Array.isArray(utxos)
          ? utxos.reduce((sum, u) => sum + (Number(u?.value) || 0), 0)
          : 0;
        return `${count} UTXO(s), ${funded} sats total`;
      })
    );
  }

  if (session) {
    session.close();
  }

  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log('');
  if (passed === total) {
    console.log(`All ${total} checks passed. Electrum is reachable with app connection settings.`);
    process.exit(0);
  }

  console.log(`${passed}/${total} checks passed.`);
  if (config.protocol === 'tcp') {
    console.log('Tip: if this server requires TLS, set EXPO_PUBLIC_ELECTRS_PROTOCOL=tls (port 50002).');
  }
  console.log('Tip: run with --address <bc1p…> to test UTXO fetch (required for send/purchase compose).');
  process.exit(1);
}

main().catch((err) => {
  console.error('');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
