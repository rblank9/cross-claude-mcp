#!/usr/bin/env node
// cc-bridge-keys: per-identity keypair, bearer, and receiver allowlist for the cross-claude bridge.
// Trust bootstrapping is out-of-band only (ssh or local shell), never over the bridge.

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  assertId,
  bearerSha256,
  defaultIdentity,
  ensureIdentity,
  loadIdentity,
  loadTrusted,
  loadTrustedRaw,
  writeTrusted,
} from "./trust.mjs";

const USAGE = `usage:
  cc-bridge-keys init [--identity ID] [--force]
  cc-bridge-keys show [--identity ID]
  cc-bridge-keys trust <id> <pubkey-b64> [--teammate --channels a,b]
  cc-bridge-keys untrust <id>
  cc-bridge-keys list
  cc-bridge-keys server-keys [--identity ID]`;

function fail(message, code = 1) {
  process.stderr.write(`cc-bridge-keys: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const opts = { identity: null, force: false, teammate: false, channels: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--identity") {
      if (i + 1 >= argv.length) fail("--identity needs a value", 2);
      opts.identity = argv[++i];
    } else if (a === "--force") {
      opts.force = true;
    } else if (a === "--teammate") {
      opts.teammate = true;
    } else if (a === "--channels") {
      if (i + 1 >= argv.length) fail("--channels needs a value", 2);
      opts.channels = argv[++i];
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

function resolveIdentity(opts) {
  const id = opts.identity ?? defaultIdentity(process.env, os.homedir(), os.hostname());
  try {
    return assertId(id);
  } catch {
    fail(`invalid identity id "${id}"`, 2);
  }
}

function validPubkey(b64) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(b64, "base64"),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function printIdentity(id, withCreated, created) {
  const ident = loadIdentity(id);
  if (!ident) fail("no identity: run cc-bridge-keys init", 1);
  const lines = [`id: ${id}`, `pubkey: ${ident.pub}`, `bearer_sha256: ${bearerSha256(id)}`];
  if (withCreated) lines.push(`created: ${created}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdInit(opts) {
  const id = resolveIdentity(opts);
  const r = ensureIdentity(id, { force: opts.force });
  process.stdout.write(
    `id: ${r.id}\npubkey: ${r.pub}\nbearer_sha256: ${r.bearerSha256}\ncreated: ${r.created}\n`
  );
}

function cmdShow(opts) {
  printIdentity(resolveIdentity(opts), false, false);
}

function cmdTrust(args, opts) {
  const [id, pub] = args;
  if (!id || !pub) fail("usage: cc-bridge-keys trust <id> <pubkey-b64> [--teammate --channels a,b]", 2);
  try {
    assertId(id);
  } catch {
    fail(`invalid identity id "${id}"`, 2);
  }
  const normalized = pub.trim();
  if (!validPubkey(normalized)) fail("pubkey is not a valid base64 ed25519 SPKI key", 2);
  let entry = normalized;
  if (opts.teammate) {
    const channels = String(opts.channels ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    if (channels.length === 0) fail("--teammate needs --channels a,b (exact channel names)", 2);
    for (const c of channels) {
      if (c.startsWith("dm-")) fail(`refusing teammate channel "${c}": dm-* inboxes are never shared`, 2);
      if (c.includes("*")) fail(`refusing teammate channel "${c}": wildcards are not allowed`, 2);
    }
    entry = { pub: normalized, tier: "teammate", channels };
  } else if (opts.channels) {
    fail("--channels requires --teammate", 2);
  }
  const trusted = loadTrustedRaw();
  trusted[id] = entry;
  writeTrusted(trusted);
  process.stdout.write(`trusted: ${id}${opts.teammate ? ` (teammate: ${entry.channels.join(",")})` : ""}\n`);
}

function cmdUntrust(args) {
  const [id] = args;
  if (!id) fail("usage: cc-bridge-keys untrust <id>", 2);
  const trusted = loadTrustedRaw();
  if (!Object.prototype.hasOwnProperty.call(trusted, id)) {
    process.stdout.write(`not trusted: ${id}\n`);
    return;
  }
  delete trusted[id];
  writeTrusted(trusted);
  process.stdout.write(`untrusted: ${id}\n`);
}

function cmdList() {
  const ids = Object.keys(loadTrusted()).sort();
  process.stdout.write(ids.length ? `${ids.join("\n")}\n` : "(none)\n");
}

function cmdServerKeys(opts) {
  const id = resolveIdentity(opts);
  if (!loadIdentity(id)) fail("no identity: run cc-bridge-keys init", 1);
  process.stdout.write(`${JSON.stringify({ [id]: bearerSha256(id) })}\n`);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) fail(USAGE, 2);
  const { positional, opts } = parseArgs(rest);
  switch (command) {
    case "init":
      return cmdInit(opts);
    case "show":
      return cmdShow(opts);
    case "trust":
      return cmdTrust(positional, opts);
    case "untrust":
      return cmdUntrust(positional);
    case "list":
      return cmdList();
    case "server-keys":
      return cmdServerKeys(opts);
    default:
      fail(`unknown command "${command}"\n${USAGE}`, 2);
  }
}

const isDirectRun = () => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isDirectRun()) {
  try {
    main();
  } catch (err) {
    fail(err.message, 1);
  }
}
