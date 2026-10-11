# Provider interface (frozen at v1)

The contract every mail provider adapter must satisfy lives in
`src/providers/interface.ts`. The bot layer (`src/bot/`, `src/server/`)
programs against those types only: it never imports a provider module
directly and never branches on provider names. All provider-specific
knowledge (endpoints, auth schemes, webhook signature formats, payload
shapes) stays inside the adapter.

## The contract

- `EmailProvider` · the adapter surface: `send`, `getInboundEmail`,
  `downloadAttachment`, `listSentEmails`, `verifyWebhook`, plus `name`
  and `capabilities`.
- `SendInput` / `SendResult` · what `send()` takes and returns. The id in
  `SendResult` is the provider's own message id; the bot keys the sent log
  on it, and delivery webhooks report back the same id.
- `InboundEmail` · full content of one received email. `downloadUrl`
  entries are signed, short-lived URLs; the bot downloads bytes through
  `downloadAttachment` and never shows the URL itself.
- `EmailEvent` · the normalized inbound event the bot layer consumes. No
  provider-specific fields leak through.
- `SentEmail` · one row of the sending log.
- `DeliveryEvent` · a delivery outcome for a message we sent
  (`delivered` | `bounced` | `complained` | `failed`). Every provider's
  webhook route normalizes its delivery events to this shape so a single
  handler serves all providers.

## Freeze policy

`src/providers/interface.ts` is frozen at v1. A breaking change ·
renaming or removing a member, changing a signature, narrowing an
accepted shape · requires all of:

1. a major version bump of postwisp,
2. a migration note appended below describing what changed and how
   adapters and callers must adapt,
3. updates to every adapter in the same commit.

Additive changes (new optional members, new provider modules) are not
breaking and do not need a major bump.

### Migration notes

None yet. The interface has not changed since the v1 freeze.

## Writing a new adapter

1. Create `src/providers/<name>.ts` with the AGPL-3.0-or-later header
   (copy it from `src/providers/resend.ts`) and a class
   `<Name>Provider implements EmailProvider` with `name = '<name>'`.
2. Implement every method against the provider's documented API. Read the
   provider's docs; never invent endpoints, field names, or signature
   schemes. Where the docs are silent, read defensively and cite the gap
   in a comment.
3. `verifyWebhook` must compare signatures with `timingSafeEqual`,
   reject missing or malformed signatures, and return
   `{ ok: false, reason }` (never throw) so the route can log the reason.
4. Map the provider's delivery events to `DeliveryEvent`; ignore event
   types with no equivalent by returning `undefined` from your mapper.
5. Set `capabilities` honestly: `scheduling` only if the provider's send
   API supports deferred delivery, `batch` only if it offers a dedicated
   bulk/batch send with per-recipient tracking (plain multi-recipient `to`
   does not count · every adapter supports that with `batch: false`).
6. Add a route file `src/server/<name>-webhook.ts` mirroring
   `src/server/resend-webhook.ts`: verify, dedupe via
   `hasWebhookEvent` / `noteWebhookEvent`, normalize, hand off to
   `onEvent` / `onDelivery`. Never log the signing secret or raw payload.
7. Add the config keys, wire the provider into `src/index.ts`, and extend
   `tests/provider-conformance.test.ts` plus the contract matrix in
   `tests/provider-contract.test.ts`.
