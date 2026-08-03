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

import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { toast } from './dom.js';
import { track, trackError, flush } from './telemetry.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Let the window settle before touching the network on launch. */
const STARTUP_DELAY_MS = 8000;

let busy = false;

/**
 * @param {boolean} manual  A user-initiated check reports "you're up to date"
 *                          and surfaces errors. A background check stays quiet.
 */
export async function checkForUpdates(manual = false) {
  if (busy) return;
  busy = true;
  try {
    if (manual) toast('Checking for updates…');
    const update = await check();

    if (!update) {
      track('update_check', { result: 'current', trigger: manual ? 'manual' : 'auto' });
      if (manual) await message('HTML Editor is up to date.', { title: 'No updates' });
      return;
    }

    track('update_available', { version: update.version });

    const notes = (update.body || '').trim();
    const wanted = await ask(
      `Version ${update.version} is available — you have ${update.currentVersion}.` +
        (notes ? `\n\n${notes.slice(0, 400)}` : '') +
        '\n\nDownload and install it now?',
      { title: 'Update available', okLabel: 'Install', cancelLabel: 'Later' }
    );

    if (!wanted) {
      track('update_declined', { version: update.version });
      return;
    }

    let total = 0;
    let seen = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength || 0;
        toast('Downloading update…', 60_000);
      } else if (event.event === 'Progress') {
        seen += event.data.chunkLength || 0;
        if (total) {
          toast(`Downloading update… ${Math.round((seen / total) * 100)}%`, 60_000);
        }
      } else if (event.event === 'Finished') {
        toast('Installing…', 60_000);
      }
    });

    track('update_installed', { version: update.version });

    const now = await ask(
      `Version ${update.version} is installed. Restart now to use it?`,
      { title: 'Restart to finish', okLabel: 'Restart', cancelLabel: 'Later' }
    );
    if (now) {
      // relaunch() ends the process, so commit the queue first or the
      // install is never reported — the one event most worth having.
      await flush();
      await relaunch();
    }
    else toast('The update will apply next time you open the app.', 4000);
  } catch (e) {
    trackError('update_failed', String(e).slice(0, 200));
    if (manual) {
      await message(`Could not check for updates.\n\n${e}`, {
        title: 'Update failed',
        kind: 'error'
      });
    }
    // A background failure is silent on purpose: an offline or firewalled
    // machine should not be nagged every day.
  } finally {
    busy = false;
  }
}

/** Check shortly after launch, then once a day for long-running sessions. */
export function startUpdateSchedule() {
  setTimeout(() => checkForUpdates(false), STARTUP_DELAY_MS);
  setInterval(() => checkForUpdates(false), DAY_MS);
}
