/**
 * Self-update.
 *
 * The app downloads a prebuilt, signed bundle for the running platform and
 * installs it — it never asks anyone to clone or rebuild from source, and it
 * never compiles anything on the user's machine. Tauri picks the right artifact
 * from the release manifest for the current OS and architecture.
 *
 * Every bundle is signed with a private key held only in CI, and the public key
 * is compiled into the app, so a tampered or substituted download is rejected
 * before it is ever run.
 */

import { invoke } from '@tauri-apps/api/core';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { $, toast } from './dom.js';
import { track, trackError, flush } from './telemetry.js';

const RELEASES = 'https://github.com/jainnitin/html-editor/releases';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Let the window settle before touching the network on launch. */
const STARTUP_DELAY_MS = 8000;

const dlg = () => $('updatedlg');
let busy = false;

/**
 * Release bodies carry boilerplate for people browsing GitHub — download
 * instructions, checksum notes — that means nothing inside the app, where the
 * download is already handled. Keep the substance, drop the rest.
 */
function cleanNotes(body) {
  const noise = /^(#{1,6}\s|see the assets|download the installer|full changelog|\*\*full changelog)/i;
  return (body || '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => !noise.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const fmtSize = (bytes) =>
  bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '';

/**
 * Present the update and, if accepted, install it.
 * @returns {Promise<boolean>} whether the user chose to install.
 */
function present(update) {
  return new Promise((resolve) => {
    const d = dlg();
    const notes = cleanNotes(update.body);

    $('upd-title').textContent = `Version ${update.version} is available`;
    $('upd-sub').innerHTML = `You're on <b>${update.currentVersion}</b>. Updates install in seconds and keep your work open.`;

    const notesEl = $('upd-notes');
    notesEl.textContent = notes;
    notesEl.hidden = !notes;

    const link = $('upd-whatsnew');
    link.hidden = false;
    link.onclick = (e) => {
      e.preventDefault();
      track('update_notes_opened', { version: update.version });
      invoke('open_external_url', { url: `${RELEASES}/tag/v${update.version}` }).catch(() => {});
    };

    $('upd-progress').hidden = true;
    $('upd-fill').style.width = '0%';
    $('upd-pct').textContent = '0%';

    const go = $('upd-go');
    const later = $('upd-later');
    go.disabled = false;
    go.textContent = 'Install update';
    later.disabled = false;

    const finish = (accepted) => {
      go.onclick = null;
      later.onclick = null;
      resolve(accepted);
    };

    go.onclick = () => finish(true);
    later.onclick = () => {
      d.close();
      finish(false);
    };

    d.showModal();
  });
}

/** Swap the dialog into its downloading state; buttons stay put, no flicker. */
function showProgress() {
  $('upd-progress').hidden = false;
  $('upd-go').disabled = true;
  $('upd-go').textContent = 'Downloading…';
  $('upd-later').disabled = true;
}

function setProgress(pct, label) {
  $('upd-fill').style.width = `${pct}%`;
  $('upd-pct').textContent = label ?? `${pct}%`;
}

/**
 * @param {boolean} manual A user-initiated check reports "you're up to date"
 *                         and surfaces errors. A background check stays quiet.
 */
export async function checkForUpdates(manual = false) {
  if (busy) return;
  busy = true;
  try {
    if (manual) toast('Checking for updates…');
    const update = await check();

    if (!update) {
      track('update_check', { result: 'current', trigger: manual ? 'manual' : 'auto' });
      if (manual) {
        await message("You're running the latest version.", { title: 'No updates' });
      }
      return;
    }

    track('update_available', { version: update.version });

    if (!(await present(update))) {
      track('update_declined', { version: update.version });
      return;
    }

    showProgress();

    let total = 0;
    let seen = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength || 0;
        setProgress(0, fmtSize(total) || '0%');
      } else if (event.event === 'Progress') {
        seen += event.data.chunkLength || 0;
        if (total) setProgress(Math.min(99, Math.round((seen / total) * 100)));
      } else if (event.event === 'Finished') {
        setProgress(100);
        $('upd-go').textContent = 'Installing…';
      }
    });

    track('update_installed', { version: update.version });
    dlg().close();

    const now = await ask(
      `HTML Editor ${update.version} is ready.\n\nRestart now to start using it?`,
      { title: 'Update installed', okLabel: 'Restart now', cancelLabel: 'On next launch' }
    );
    if (now) {
      // relaunch() ends the process, so commit the queue first or the install
      // is never reported — the one event most worth having.
      await flush();
      await relaunch();
    } else {
      toast('The update will apply next time you open the app.', 4000);
    }
  } catch (e) {
    const raw = String(e);
    trackError('update_failed', raw.slice(0, 200));
    try {
      dlg().close();
    } catch {
      /* not open */
    }
    if (manual) await message(explain(raw), { title: 'Update failed', kind: 'error' });
    // A background failure is silent on purpose: an offline or firewalled
    // machine should not be nagged every day.
  } finally {
    busy = false;
  }
}

/**
 * Turn an updater error into something worth reading. The raw text names
 * internal concepts like the manifest's platform table, which tells a user
 * nothing about what to do next.
 */
function explain(raw) {
  if (/platforms/i.test(raw)) {
    return (
      'A new version is being published right now and the build for this ' +
      'platform is not ready yet.\n\nTry again in a few minutes.'
    );
  }
  if (/network|dns|connect|timed? ?out|resolve/i.test(raw)) {
    return `Could not reach the update server.\n\nCheck your connection and try again.\n\n${raw}`;
  }
  return `Could not check for updates.\n\n${raw}`;
}

/** Check shortly after launch, then once a day for long-running sessions. */
export function startUpdateSchedule() {
  setTimeout(() => checkForUpdates(false), STARTUP_DELAY_MS);
  setInterval(() => checkForUpdates(false), DAY_MS);
}
