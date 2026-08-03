/**
 * Anonymous usage telemetry.
 *
 * Sent straight to the Application Insights ingestion REST API with `fetch`,
 * which keeps this dependency-free — no SDK on either side.
 *
 * What is never sent: file paths, file names, document content, hostnames,
 * usernames, or anything typed into the editor. Sizes and counts are reported
 * as buckets rather than exact figures so a document cannot be fingerprinted.
 *
 * Every event carries `cloud_RoleName = "html-editor"`, which is what keeps it
 * separable from other apps reporting into the same resource.
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Supplied at build time so no endpoint or key is committed:
 *
 *   VITE_AI_INGEST=https://<region>.in.applicationinsights.azure.com/v2/track
 *   VITE_AI_IKEY=<instrumentation key>
 *
 * With either missing telemetry stays off, which is the default for a source
 * build and for anyone running their own copy.
 */
const INGEST = import.meta.env.VITE_AI_INGEST || '';
const IKEY = import.meta.env.VITE_AI_IKEY || '';
const ROLE = 'html-editor';

const FLUSH_AFTER_MS = 20_000;
const FLUSH_AT_COUNT = 20;

const session = crypto.randomUUID();
const queue = [];

let enabled = true;
let installId = '';
let env = { os: 'unknown', arch: 'unknown', version: '0.0.0' };
let started = Date.now();
let timer = null;

/**
 * A stable, non-reversible id for a document.
 *
 * Lets distinct files be counted — "how many reports has this helped edit?" —
 * without a path or name ever leaving the machine. The install id is mixed in
 * so the same file on two machines does not produce the same hash, which would
 * otherwise let documents be correlated across users.
 */
export async function docId(path) {
  try {
    const data = new TextEncoder().encode(`${installId}:${path}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)]
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}

/** Report magnitudes as buckets: useful in aggregate, useless for identifying. */
export function bucket(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  for (const edge of [1, 5, 10, 50, 100, 500, 1000, 5000]) {
    if (n <= edge) return `<=${edge}`;
  }
  return '>5000';
}

function envelope(name, properties = {}, measurements = {}, error) {
  return {
    name: error
      ? 'Microsoft.ApplicationInsights.Exception'
      : 'Microsoft.ApplicationInsights.Event',
    time: new Date().toISOString(),
    iKey: IKEY,
    tags: {
      'ai.cloud.role': ROLE,
      'ai.cloud.roleInstance': env.os,
      'ai.application.ver': env.version,
      'ai.session.id': session,
      'ai.user.id': installId,
      'ai.internal.sdkVersion': `html-editor:${env.version}`
    },
    data: error
      ? {
          baseType: 'ExceptionData',
          baseData: {
            ver: 2,
            exceptions: [{
              typeName: error.type,
              message: error.message,
              hasFullStack: false,
              parsedStack: []
            }],
            properties: { app: ROLE, ...properties }
          }
        }
      : {
          baseType: 'EventData',
          baseData: {
            ver: 2,
            name,
            properties: { app: ROLE, os: env.os, arch: env.arch, ...properties },
            measurements
          }
        }
  };
}

/** Exported so callers can commit the queue before the process goes away. */
export async function flush() {
  clearTimeout(timer);
  timer = null;
  if (!enabled || !queue.length) return;

  const batch = queue.splice(0, queue.length);
  try {
    await fetch(INGEST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      keepalive: true
    });
  } catch {
    // Telemetry must never interfere with the app. A failed batch is dropped
    // rather than retried, so a flaky network cannot grow the queue forever.
  }
}

function enqueue(env_) {
  if (!enabled) return;
  queue.push(env_);
  if (queue.length >= FLUSH_AT_COUNT) {
    flush();
  } else if (!timer) {
    timer = setTimeout(flush, FLUSH_AFTER_MS);
  }
}

/** Record a named event. Properties must already be bucketed or categorical. */
export function track(name, properties, measurements) {
  enqueue(envelope(name, properties, measurements));
}

/** Record a handled failure. The message is a fixed string, never user data. */
export function trackError(type, message, properties) {
  enqueue(envelope(null, properties, null, { type, message }));
}

export async function init(settings) {
  enabled = settings?.telemetry !== false && !!INGEST && !!IKEY;
  if (!enabled) return;

  installId = settings?.install_id || '';
  if (!installId) {
    installId = crypto.randomUUID();
    invoke('set_install_id', { id: installId }).catch(() => {});
  }

  env = await invoke('environment').catch(() => env);
  started = Date.now();

  track('app_started', { version: env.version });

  // Commit pending events at natural pause points rather than on a fixed clock.
  window.addEventListener('blur', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}

/** Called on the way out, so a session always ends with a duration. */
export function shutdown() {
  track('app_closed', {}, { session_minutes: Math.round((Date.now() - started) / 60_000) });
  return flush();
}
