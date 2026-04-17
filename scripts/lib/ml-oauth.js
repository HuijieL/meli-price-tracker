/**
 * Mercado Livre OAuth helper — Phase 1
 *
 * - Reads credentials from .env.local (project root) or process.env
 * - Refreshes access_token via refresh_token grant
 * - Persists rotated refresh_token back to .env.local (local dev)
 *   or emits a workflow-output line for GitHub Actions to pick up
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';

export async function loadEnvLocal(rootPath) {
  const envPath = path.join(rootPath, '.env.local');
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    const kv = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      kv[key] = value;
    }
    return kv;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export function loadCredentials(rootPath, envLocal = {}) {
  const get = (key) => process.env[key] || envLocal[key] || null;
  const creds = {
    appId: get('ML_APP_ID'),
    clientSecret: get('ML_CLIENT_SECRET'),
    refreshToken: get('ML_REFRESH_TOKEN'),
    accessToken: get('ML_ACCESS_TOKEN'),
    userId: get('ML_USER_ID'),
  };
  const missing = ['appId', 'clientSecret', 'refreshToken'].filter((k) => !creds[k]);
  if (missing.length) {
    throw new Error(
      `Missing ML credentials: ${missing.join(', ')}. ` +
        `Set env vars or populate .env.local at ${rootPath}`,
    );
  }
  return creds;
}

/**
 * Exchange refresh_token for a fresh access_token.
 * ML rotates refresh_token on every call — caller must persist the new one.
 */
export async function refreshAccessToken({ appId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: appId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    const err = new Error(
      `ML token refresh failed: ${res.status} ${json.error ?? ''} ${json.message ?? ''}`,
    );
    err.response = json;
    throw err;
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    userId: json.user_id,
    scope: json.scope,
  };
}

/**
 * Write rotated credentials back to .env.local.
 * Preserves comments and non-ML variables.
 */
export async function persistToEnvLocal(rootPath, updates) {
  const envPath = path.join(rootPath, '.env.local');
  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const lines = raw.split('\n');
  const touched = new Set();
  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in updates) {
      touched.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!touched.has(key)) newLines.push(`${key}=${value}`);
  }
  await fs.writeFile(envPath, newLines.join('\n'));
}

/**
 * Emit a key=value line on stdout prefixed with `::set-env-local::`.
 * GitHub Actions workflow parses these lines and re-writes the repo secret.
 */
export function emitWorkflowOutput(key, value) {
  process.stdout.write(`::set-env-local::${key}=${value}\n`);
}

/**
 * One-shot helper for scripts: load creds, refresh, persist, return fresh token.
 */
export async function getFreshAccessToken(rootPath) {
  const envLocal = await loadEnvLocal(rootPath);
  const creds = loadCredentials(rootPath, envLocal);
  const fresh = await refreshAccessToken(creds);

  const updates = {
    ML_ACCESS_TOKEN: fresh.accessToken,
    ML_REFRESH_TOKEN: fresh.refreshToken,
  };

  if (process.env.GITHUB_ACTIONS === 'true') {
    emitWorkflowOutput('ML_ACCESS_TOKEN', fresh.accessToken);
    emitWorkflowOutput('ML_REFRESH_TOKEN', fresh.refreshToken);
  } else {
    await persistToEnvLocal(rootPath, updates);
  }

  return { ...fresh, appId: creds.appId };
}
