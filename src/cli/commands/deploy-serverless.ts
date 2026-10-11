// postwisp — self-hosted Telegram email manager
// Copyright (C) 2026 Reza Harirchian
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Guided walkthrough for deploying the Telegram Serverless companion
// (tgcloud/). This command never deploys anything itself: the tgcloud CLI
// needs interactive login and the operator's own BotFather token, so the
// command checks prerequisites and prints the exact ordered steps.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { confirm, intro, isCancel, outro } from '@clack/prompts';
import type { DoctorCheck } from './doctor.js';

// The tgcloud project files this command expects, relative to the repo root.
export const TGCLOUD_FILES = [
  'tgcloud/schema.js',
  'tgcloud/handlers/message.js',
  'tgcloud/handlers/callback_query.js',
  'tgcloud/lib/pure.js',
  'tgcloud/lib/store.js',
  'tgcloud/lib/tg.js',
  'tgcloud/lib/resend.js',
] as const;

// The exact ordered steps, printed verbatim. Kept as data so tests can
// assert on the sequence without driving a terminal.
export function deployServerlessSteps(): string[] {
  return [
    '1. Log in the tgcloud CLI:\n       tgcloud login\n   Paste the CLI access token from BotFather (open BotFather, pick your\n   bot, enable Serverless, copy the CLI access token).',
    '2. Deploy the code:\n       tgcloud push\n   This uploads tgcloud/handlers and tgcloud/lib to Telegram\'s\n   infrastructure. Re-run push after every edit.',
    '3. Create the database tables:\n       tgcloud migrate\n   Applies tgcloud/schema.js (kv, emails, outbox, suppression, rules).',
    '4. Seed the secrets with a one-shot run (values stay on your machine,\n   never in the repo):\n       tgcloud run seed.js\n   where seed.js sets kv keys owner_id (your numeric Telegram user id),\n   resend_api_key, and from_addr (a Resend-verified sender).\n   See docs/SERVERLESS.md for the exact snippet.',
    '5. If you edited any tgcloud/ file after step 2, run tgcloud push\n   again so the deployed code matches the repo.',
    '6. Test: send /start to the bot in Telegram (the menu should appear),\n   then send a test email to your domain and tap "Save to inbox" on the\n   worker notification.',
  ];
}

export interface DeployServerlessDeps {
  runCli(args: string[]): { ok: boolean; output: string };
  fileExists(path: string): boolean;
  repoRoot: string;
  askConfirm(message: string): Promise<boolean>;
  log(line: string): void;
}

export interface DeployServerlessReport {
  tgcloudCli: { ok: boolean; detail: string };
  loggedIn: { ok: boolean; detail: string };
  projectFiles: { ok: boolean; missing: string[] };
}

function checkTgcloudCli(runCli: DeployServerlessDeps['runCli']): DeployServerlessReport['tgcloudCli'] {
  const result = runCli(['--version']);
  return result.ok
    ? { ok: true, detail: `installed (${result.output.trim()})` }
    : {
        ok: false,
        detail: 'not found — install it first: npm install -g @tgcloud/cli',
      };
}

function checkLogin(runCli: DeployServerlessDeps['runCli']): DeployServerlessReport['loggedIn'] {
  const result = runCli(['status']);
  return result.ok
    ? { ok: true, detail: 'logged in' }
    : {
        ok: false,
        detail: 'not logged in (or status failed) — run: tgcloud login',
      };
}

function checkProjectFiles(
  fileExists: DeployServerlessDeps['fileExists'],
  repoRoot: string,
): DeployServerlessReport['projectFiles'] {
  const missing = TGCLOUD_FILES.filter((rel) => !fileExists(join(repoRoot, rel)));
  return { ok: missing.length === 0, missing: [...missing] };
}

export function runDeployServerlessChecks(deps: DeployServerlessDeps): DeployServerlessReport {
  return {
    tgcloudCli: checkTgcloudCli(deps.runCli),
    loggedIn: checkLogin(deps.runCli),
    projectFiles: checkProjectFiles(deps.fileExists, deps.repoRoot),
  };
}

export async function runDeployServerless(deps: DeployServerlessDeps): Promise<void> {
  deps.log('postwisp serverless deploy walkthrough');
  deps.log('This command checks prerequisites and prints the steps; it never deploys by itself.');
  deps.log('');

  const report = runDeployServerlessChecks(deps);
  const mark = (ok: boolean): string => (ok ? '[ok]  ' : '[!]   ');
  deps.log(`${mark(report.tgcloudCli.ok)} tgcloud CLI: ${report.tgcloudCli.detail}`);
  deps.log(`${mark(report.loggedIn.ok)} tgcloud login: ${report.loggedIn.detail}`);
  deps.log(
    `${mark(report.projectFiles.ok)} tgcloud/ project files: ` +
      (report.projectFiles.ok
        ? `all ${TGCLOUD_FILES.length} present`
        : `missing: ${report.projectFiles.missing.join(', ')}`),
  );
  deps.log('');

  if (!report.tgcloudCli.ok || !report.loggedIn.ok || !report.projectFiles.ok) {
    deps.log('Fix the items marked [!] above, then run this command again.');
    deps.log('');
  }

  deps.log('Deploy steps (in order):');
  deps.log('');
  for (const step of deployServerlessSteps()) {
    deps.log(step);
    deps.log('');
  }

  const open = await deps.askConfirm('Show docs/SERVERLESS.md now?');
  if (open) {
    const docPath = join(deps.repoRoot, 'docs', 'SERVERLESS.md');
    try {
      const content = readFileSync(docPath, 'utf8');
      deps.log('');
      deps.log(content);
    } catch {
      deps.log(`Could not read ${docPath}.`);
    }
  }
}

// Informational doctor check: the serverless companion is optional, so a
// missing tgcloud CLI or missing project files is a warn, never a fail.
export function tgcloudPresenceCheck(deps: {
  commandAvailable(command: string): boolean;
  tgcloudDirPresent(repoRoot: string): boolean;
  repoRoot: string;
}): DoctorCheck {
  const cli = deps.commandAvailable('tgcloud');
  const project = deps.tgcloudDirPresent(deps.repoRoot);
  if (cli && project) {
    return {
      name: 'tgcloud serverless companion',
      status: 'ok',
      detail: 'tgcloud CLI installed; tgcloud/ project files present',
    };
  }
  const missing: string[] = [];
  if (!cli) missing.push('tgcloud CLI not installed');
  if (!project) missing.push('tgcloud/ project files not found in the repo');
  return {
    name: 'tgcloud serverless companion',
    status: 'warn',
    detail: `${missing.join('; ')} — the self-hosted bot is unaffected`,
    fix: 'Optional: run `postwisp deploy:serverless` and read docs/SERVERLESS.md to set up the serverless companion.',
  };
}

function defaultRepoRoot(): string {
  // dist/cli/commands/deploy-serverless.js -> repo root is three levels up.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function realRunCli(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync('tgcloud', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { ok: true, output };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    return { ok: false, output: typeof stderr === 'string' ? stderr : '' };
  }
}

function commandAvailable(command: string): boolean {
  try {
    execFileSync('command', ['-v', command], { stdio: 'ignore', shell: true });
    return true;
  } catch {
    return false;
  }
}

export function registerDeployServerless(program: Command): void {
  program
    .command('deploy:serverless')
    .description('Guided walkthrough for deploying the Telegram Serverless (tgcloud) companion')
    .action(async () => {
      const isTTY = process.stdout.isTTY === true;
      intro('postwisp deploy:serverless');
      try {
        await runDeployServerless({
          runCli: realRunCli,
          fileExists: (path) => existsSync(path),
          repoRoot: defaultRepoRoot(),
          askConfirm: async (message) => {
            if (!isTTY) return false;
            const answer = await confirm({ message });
            return !isCancel(answer) && answer === true;
          },
          log: (line) => console.log(line),
        });
      } catch (error) {
        if (isCancel(error)) {
          outro('Cancelled.');
          return;
        }
        throw error;
      }
      outro('Done.');
    });
}

export function tgcloudDoctorCheck(repoRoot: string): DoctorCheck {
  return tgcloudPresenceCheck({
    commandAvailable,
    tgcloudDirPresent: (root) => existsSync(join(root, 'tgcloud', 'schema.js')),
    repoRoot,
  });
}
