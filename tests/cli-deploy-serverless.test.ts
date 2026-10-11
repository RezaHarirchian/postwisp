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

import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import {
  TGCLOUD_FILES,
  deployServerlessSteps,
  registerDeployServerless,
  runDeployServerless,
  runDeployServerlessChecks,
  tgcloudPresenceCheck,
  type DeployServerlessDeps,
} from '../src/cli/commands/deploy-serverless.js';

function deps(overrides: Partial<DeployServerlessDeps> = {}): DeployServerlessDeps {
  return {
    runCli: () => ({ ok: true, output: 'tgcloud 1.0.0' }),
    fileExists: () => true,
    repoRoot: '/repo',
    askConfirm: async () => false,
    log: () => {},
    ...overrides,
  };
}

describe('deployServerlessSteps', () => {
  it('lists the steps in deploy order', () => {
    const steps = deployServerlessSteps();
    expect(steps).toHaveLength(6);
    expect(steps[0]).toMatch(/tgcloud login/);
    expect(steps[1]).toMatch(/tgcloud push/);
    expect(steps[2]).toMatch(/tgcloud migrate/);
    expect(steps[3]).toMatch(/seed/i);
    expect(steps[5]).toMatch(/\/start/);
  });
});

describe('runDeployServerlessChecks', () => {
  it('reports everything ok when the CLI, login, and files are present', () => {
    const report = runDeployServerlessChecks(deps());
    expect(report.tgcloudCli.ok).toBe(true);
    expect(report.loggedIn.ok).toBe(true);
    expect(report.projectFiles.ok).toBe(true);
    expect(report.projectFiles.missing).toEqual([]);
  });

  it('flags a missing tgcloud CLI', () => {
    const report = runDeployServerlessChecks(
      deps({ runCli: (args) => (args[0] === '--version' ? { ok: false, output: '' } : { ok: true, output: '' }) }),
    );
    expect(report.tgcloudCli.ok).toBe(false);
    expect(report.tgcloudCli.detail).toMatch(/install/i);
  });

  it('flags a failed login', () => {
    const report = runDeployServerlessChecks(
      deps({ runCli: (args) => (args[0] === 'status' ? { ok: false, output: '' } : { ok: true, output: '' }) }),
    );
    expect(report.loggedIn.ok).toBe(false);
    expect(report.loggedIn.detail).toMatch(/tgcloud login/);
  });

  it('lists missing project files', () => {
    const report = runDeployServerlessChecks(
      deps({ fileExists: (path) => !path.endsWith('schema.js') }),
    );
    expect(report.projectFiles.ok).toBe(false);
    expect(report.projectFiles.missing).toEqual(['tgcloud/schema.js']);
  });
});

describe('runDeployServerless', () => {
  it('prints the checks and the ordered steps without deploying anything', async () => {
    const lines: string[] = [];
    await runDeployServerless(deps({ log: (line) => lines.push(line) }));
    const output = lines.join('\n');
    expect(output).toMatch(/tgcloud CLI/);
    expect(output).toMatch(/tgcloud login/);
    expect(output).toMatch(/tgcloud push/);
    expect(output).toMatch(/tgcloud migrate/);
  });

  it('covers every expected tgcloud project file', () => {
    expect(TGCLOUD_FILES).toContain('tgcloud/schema.js');
    expect(TGCLOUD_FILES).toContain('tgcloud/handlers/message.js');
    expect(TGCLOUD_FILES).toContain('tgcloud/handlers/callback_query.js');
  });
});

describe('tgcloudPresenceCheck', () => {
  const base = { repoRoot: '/repo' };

  it('is ok when the CLI and the project are present', () => {
    const check = tgcloudPresenceCheck({
      ...base,
      commandAvailable: () => true,
      tgcloudDirPresent: () => true,
    });
    expect(check.status).toBe('ok');
  });

  it('warns (never fails) when the CLI is missing', () => {
    const check = tgcloudPresenceCheck({
      ...base,
      commandAvailable: () => false,
      tgcloudDirPresent: () => true,
    });
    expect(check.status).toBe('warn');
    expect(check.fix).toMatch(/deploy:serverless/);
  });

  it('warns when the project files are missing', () => {
    const check = tgcloudPresenceCheck({
      ...base,
      commandAvailable: () => true,
      tgcloudDirPresent: () => false,
    });
    expect(check.status).toBe('warn');
  });
});

describe('registerDeployServerless', () => {
  it('registers the deploy:serverless command', () => {
    const program = new Command();
    registerDeployServerless(program);
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('deploy:serverless');
  });
});
