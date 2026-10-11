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

// Parses the List-Unsubscribe / List-Unsubscribe-Post headers (RFC 2369,
// RFC 8058) carried on inbound mail. Pure functions: no network, no store.

export interface UnsubTarget {
  kind: 'http' | 'mailto';
  // The raw URL or mailto URI from the header.
  url: string;
  // True when List-Unsubscribe-Post advertises one-click support, meaning
  // a POST with "List-Unsubscribe=One-Click" unsubscribes without a browser.
  oneClick: boolean;
}

// Header lookup is case-insensitive: providers normalize header names in
// different ways, and the stored record keeps whatever arrived.
function headerValue(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

// A List-Unsubscribe value is a comma-separated list of <url> entries (the
// angle brackets are optional in the wild). Returns every candidate URL in
// order so the caller can prefer https over mailto.
function splitCandidates(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      const m = /^<([^<>]+)>$/.exec(trimmed);
      return (m?.[1] ?? trimmed).trim();
    })
    .filter((u) => u.length > 0);
}

// Prefers an https/http URL (one tap, no email round-trip), then mailto.
// Returns null when the header is absent or holds no usable target.
export function findListUnsubscribe(headers: Record<string, string>): UnsubTarget | null {
  const raw = headerValue(headers, 'list-unsubscribe');
  if (!raw) return null;
  const candidates = splitCandidates(raw);
  const post = headerValue(headers, 'list-unsubscribe-post') ?? '';
  const oneClick = post.toLowerCase().includes('list-unsubscribe=one-click');
  const http = candidates.find((u) => /^https?:\/\//i.test(u));
  if (http) return { kind: 'http', url: http, oneClick };
  const mailto = candidates.find((u) => /^mailto:/i.test(u));
  if (mailto) return { kind: 'mailto', url: mailto, oneClick: false };
  return null;
}

// Extracts the bare address from a mailto URI, dropping any ?subject=
// parameters the header may carry.
export function mailtoAddress(mailtoUri: string): string | null {
  const m = /^mailto:([^?]+)/i.exec(mailtoUri.trim());
  const addr = m?.[1]?.trim();
  return addr && addr.length > 0 ? addr : null;
}
