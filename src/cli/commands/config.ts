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

import type { Command } from 'commander';
import {
  CONFIG_COMMAND_KEYS,
  ConfigError,
  configFilePath,
  describeChanges,
  displayConfigValue,
  loadConfig,
  parseConfigValue,
  redactedConfig,
  saveConfigFile,
} from '../../core/config.js';

export interface ConfigCmdDeps {
  configPath: string;
  out: (line: string) => void;
}

function isKnownKey(key: string): boolean {
  return (CONFIG_COMMAND_KEYS as readonly string[]).includes(key);
}

// Prints every key; secret values are rendered as [redacted] via
// redactedConfig, never echoed.
export function printAllConfig(deps: ConfigCmdDeps): void {
  const redacted = redactedConfig(loadConfig({}, deps.configPath));
  for (const key of CONFIG_COMMAND_KEYS) {
    deps.out(`${key}: ${displayConfigValue(key, (redacted as Record<string, unknown>)[key])}`);
  }
}

export function printConfigValue(deps: ConfigCmdDeps, key: string): void {
  if (!isKnownKey(key)) {
    throw new ConfigError(`unknown config key "${key}". Valid keys: ${CONFIG_COMMAND_KEYS.join(', ')}`);
  }
  const redacted = redactedConfig(loadConfig({}, deps.configPath));
  deps.out(displayConfigValue(key, (redacted as Record<string, unknown>)[key]));
}

// Validates with the same rules as the config file, writes 0600, and
// reports what changed without echoing secret values.
export function setConfigValue(deps: ConfigCmdDeps, key: string, rawValue: string): void {
  const delta = parseConfigValue(key, rawValue);
  const before = loadConfig({}, deps.configPath);
  saveConfigFile(delta, deps.configPath);
  for (const line of describeChanges(before, delta)) deps.out(line);
  deps.out(`Saved to ${deps.configPath} (mode 0600).`);
}

export function registerConfigCmd(program: Command): void {
  const cmd = program
    .command('config')
    .description('Show or change postwisp configuration (secrets are never printed)');
  cmd
    .command('get <key>')
    .description('Print one config value')
    .action((key: string) => {
      printConfigValue({ configPath: configFilePath(), out: (line) => console.log(line) }, key);
    });
  cmd
    .command('set <key> <value>')
    .description('Set one config value (an empty value clears it)')
    .action((key: string, value: string) => {
      setConfigValue({ configPath: configFilePath(), out: (line) => console.log(line) }, key, value);
    });
  cmd.action(() => {
    printAllConfig({ configPath: configFilePath(), out: (line) => console.log(line) });
  });
}
