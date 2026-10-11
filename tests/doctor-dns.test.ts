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
import { runDnsDoctorChecks, type ResolveTxt } from '../src/cli/commands/doctor.js';

function fakeResolver(records: Record<string, string[][]>): ResolveTxt {
  return async (hostname: string) => {
    const hit = records[hostname];
    if (!hit) {
      const err = new Error(`queryTxt ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      throw err;
    }
    return hit;
  };
}

const BASE = {
  'mail.example.com': [['v=spf1 include:amazonses.com ~all']],
  'resend._domainkey.mail.example.com': [['v=DKIM1; k=rsa; p=MIIB...']],
  '_dmarc.mail.example.com': [['v=DMARC1; p=none;']],
};

const INPUT = {
  domains: ['mail.example.com'],
  provider: 'resend' as const,
};

describe('runDnsDoctorChecks', () => {
  it('reports ok when SPF, DKIM and DMARC are all published', async () => {
    const checks = await runDnsDoctorChecks({ ...INPUT, resolveTxt: fakeResolver(BASE) });
    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
    expect(checks.map((c) => c.name)).toEqual([
      'SPF for mail.example.com',
      'DKIM for mail.example.com',
      'DMARC for mail.example.com',
    ]);
  });

  it('fails SPF with the exact record to publish when it is missing', async () => {
    const { 'mail.example.com': _drop, ...rest } = BASE;
    const checks = await runDnsDoctorChecks({ ...INPUT, resolveTxt: fakeResolver(rest) });
    const spf = checks.find((c) => c.name.startsWith('SPF'));
    expect(spf?.status).toBe('fail');
    expect(spf?.fix).toContain('v=spf1 include:amazonses.com ~all');
  });

  it('fails SPF when TXT records exist but none is an SPF record', async () => {
    const records = { ...BASE, 'mail.example.com': [['some other txt']] };
    const checks = await runDnsDoctorChecks({ ...INPUT, resolveTxt: fakeResolver(records) });
    const spf = checks.find((c) => c.name.startsWith('SPF'));
    expect(spf?.status).toBe('fail');
    expect(spf?.detail).toContain('none is an SPF record');
  });

  it('fails DKIM naming the selector hostname to publish at', async () => {
    const { 'resend._domainkey.mail.example.com': _drop, ...rest } = BASE;
    const checks = await runDnsDoctorChecks({ ...INPUT, resolveTxt: fakeResolver(rest) });
    const dkim = checks.find((c) => c.name.startsWith('DKIM'));
    expect(dkim?.status).toBe('fail');
    expect(dkim?.fix).toContain('resend._domainkey.mail.example.com');
  });

  it('fails DMARC with the record to publish and a policy upgrade hint', async () => {
    const { '_dmarc.mail.example.com': _drop, ...rest } = BASE;
    const checks = await runDnsDoctorChecks({ ...INPUT, resolveTxt: fakeResolver(rest) });
    const dmarc = checks.find((c) => c.name.startsWith('DMARC'));
    expect(dmarc?.status).toBe('fail');
    expect(dmarc?.fix).toContain('v=DMARC1; p=none;');
    expect(dmarc?.fix).toContain('p=quarantine');
  });

  it('checks every configured domain', async () => {
    const checks = await runDnsDoctorChecks({
      ...INPUT,
      domains: ['mail.example.com', 'other.example.com'],
      resolveTxt: fakeResolver(BASE),
    });
    expect(checks).toHaveLength(6);
  });

  it('uses the Mailgun API selector instead of the hardcoded pair', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      seen.push(url);
      return new Response(
        JSON.stringify({
          sending_dns_records: [
            {
              name: 'k2._domainkey.mail.example.com',
              record_type: 'TXT',
              valid: 'valid',
              value: 'v=DKIM1; k=rsa; p=MIIB...',
            },
          ],
        }),
        { status: 200 },
      );
    };
    const records = {
      ...BASE,
      'k2._domainkey.mail.example.com': [['v=DKIM1; k=rsa; p=MIIB...']],
    };
    const checks = await runDnsDoctorChecks({
      domains: ['mail.example.com'],
      provider: 'mailgun',
      resolveTxt: fakeResolver(records),
      mailgunApiKey: 'key-test',
      fetchImpl,
    });
    expect(seen[0]).toContain('api.mailgun.net/v3/domains/mail.example.com');
    const dkim = checks.find((c) => c.name.startsWith('DKIM'));
    // k2 is not in the hardcoded ['mxvault', 'mailo'] pair: only the API
    // lookup can find it.
    expect(dkim?.status).toBe('ok');
    expect(dkim?.detail).toContain('k2._domainkey.mail.example.com');
  });

  it('falls back to the known selectors when the Mailgun API is unreachable', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('no network');
    };
    const records = {
      ...BASE,
      'mxvault._domainkey.mail.example.com': [['v=DKIM1; k=rsa; p=MIIB...']],
    };
    const checks = await runDnsDoctorChecks({
      domains: ['mail.example.com'],
      provider: 'mailgun',
      resolveTxt: fakeResolver(records),
      mailgunApiKey: 'key-test',
      fetchImpl,
    });
    const dkim = checks.find((c) => c.name.startsWith('DKIM'));
    expect(dkim?.status).toBe('ok');
    expect(dkim?.detail).toContain('mxvault._domainkey.mail.example.com');
  });
});
