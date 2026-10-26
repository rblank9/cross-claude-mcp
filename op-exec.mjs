// Boot-time 1Password env injection for Node: `node op-exec.mjs -- <cmd...>`.
// Same contract as op_exec.py: one items.get, env-shaped fields exported, the
// service-account credential dropped, then the original command runs as a child
// with signals forwarded and its exit code propagated. Vendored; sha256-pinned.
import { spawn } from 'node:child_process';

const FIELD_RE = /^[A-Z][A-Z0-9_]*$/;
const TOKEN_VAR = 'OP_SERVICE_' + 'ACCOUNT_TOKEN';

export async function load({
  env = process.env,
  createClient,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (line) => console.error(line),
  attempts = 5,
} = {}) {
  const credential = env[TOKEN_VAR];
  if (!credential) {
    if (env.OP_REQUIRED === '1') {
      throw new Error('op-secrets: refusing to start, OP_REQUIRED is 1 and no service account credential is set');
    }
    log('op-secrets: no service account credential, using plain env');
    return [];
  }
  for (const v of ['OP_VAULT_ID', 'OP_ITEM_ID']) {
    if (!env[v]) throw new Error(`op-secrets: ${v} is unset`);
  }
  if (!createClient) {
    const sdk = await import('@1password/sdk');
    createClient = (opts) => (sdk.createClient ?? sdk.default.createClient)(opts);
  }
  let item;
  for (let i = 1; i <= attempts; i++) {
    try {
      const client = await createClient({ auth: credential, integrationName: 'op-exec', integrationVersion: '1.0.0' });
      item = await client.items.get(env.OP_VAULT_ID, env.OP_ITEM_ID);
      break;
    } catch (e) {
      log(`op-secrets: attempt ${i}/${attempts} failed: ${e.message}`);
      if (i === attempts) throw new Error(`op-secrets: failed after ${attempts} attempts: ${e.message}`);
      await sleep(1000 * 2 ** (i - 1));
    }
  }
  const names = [];
  for (const f of item.fields ?? []) {
    if (typeof f.title === 'string' && FIELD_RE.test(f.title) && typeof f.value === 'string' && f.value !== '') {
      env[f.title] = f.value;
      names.push(f.title);
    }
  }
  if (names.length === 0) throw new Error('op-secrets: item has no env-shaped fields');
  delete env[TOKEN_VAR];
  names.sort();
  log(`op-secrets: loaded ${names.length} fields from 1Password: ${names.join(',')}`);
  return names;
}

export async function main(argv = process.argv.slice(2), { env = { ...process.env }, createClient, sleep, spawnFn = spawn } = {}) {
  if (argv[0] === '--') argv = argv.slice(1);
  if (argv.length === 0) {
    console.error('usage: node op-exec.mjs -- <command> [args...]');
    return 2;
  }
  try {
    await load({ env, createClient, sleep });
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  const child = spawnFn(argv[0], argv.slice(1), { env, stdio: 'inherit' });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  return await new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1))));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
