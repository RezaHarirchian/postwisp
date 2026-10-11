#!/usr/bin/env node
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

import { Command } from 'commander';
import { loadConfig } from '../core/config.js';
import { VERSION } from '../core/version.js';
import { statusText } from './commands/status.js';
import { cloudflareGuideText } from './commands/cloudflare.js';
import { registerSetup } from './commands/setup.js';
import { registerPair } from './commands/pair.js';
import { registerLogs } from './commands/logs.js';
import { registerConfigCmd } from './commands/config.js';
import { registerDomains } from './commands/domains.js';
import { registerWebhooks } from './commands/webhooks.js';
import { registerDoctor } from './commands/doctor.js';
import { registerDeployServerless } from './commands/deploy-serverless.js';
import { registerUpdate, maybeNotifyUpdate } from './commands/update.js';
import { showMenu } from './menu.js';

const program = new Command();

program.name('postwisp').description('Self-hosted Telegram bot for two-way email management').version(VERSION);

function runStatusCommand(): void {
  console.log(statusText(loadConfig()));
}

// The placeholder URL stands in for the public address; only the operator
// knows the real hostname and whether it is HTTPS-terminated.
function runCloudflareCommand(): void {
  console.log(cloudflareGuideText(null));
}

program.command('status').description('Show whether postwisp is working, in plain language').action(runStatusCommand);

program
  .command('cloudflare')
  .description('Show how to deploy the Cloudflare Email Worker for inbound mail')
  .action(runCloudflareCommand);

registerSetup(program);
registerPair(program);
registerLogs(program);
registerConfigCmd(program);
registerDomains(program);
registerWebhooks(program);
registerDoctor(program);
registerDeployServerless(program);
registerUpdate(program);

// Bare `postwisp` opens the guided menu; a choice re-enters the parser as
// the equivalent command so menu and CLI stay the same code path.
program.action(async () => {
  await showMenu(async (command) => {
    // The menu calls it "telegram"; the command is "pair".
    const name = command === 'telegram' ? 'pair' : command;
    await program.parseAsync(['node', 'postwisp', name]);
  });
});

program
  .parseAsync(process.argv)
  .then(() => maybeNotifyUpdate())
  .catch((error: unknown) => {
    // Users get what happened, not a stack trace.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
