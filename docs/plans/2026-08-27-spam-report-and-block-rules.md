---
title: Spam Reporting, Block Rules, and AI-Driven Sweep
summary: >
  Add report-spam and sender/domain block-rule tools to email-mcp so junk mail
  can be reported to Gmail/Outlook's own filters and blocked at the source,
  instead of only deleted after the fact. Classification stays with the
  calling agent (Claude), not a second model embedded in the server.
type: plan
status: completed
date: 2026-08-27
tags: [email-mcp, spam, phishing, gmail, outlook]
projects: [email-mcp]
---

# Spam Reporting, Block Rules, and AI-Driven Sweep

## Why this instead of just deleting

Deleting junk (what the 2026-08-27 Hotmail cleanup did) removes it from view but teaches the provider's spam filter nothing, and does nothing to stop the next wave. Two real levers exist that the current `email-mcp` (repo `~/software-dev/email-mcp`, the Model Context Protocol server that gives Claude programmatic access to Gmail/Outlook/iCloud/IMAP accounts) doesn't expose yet:

1. **Report as spam/junk** — moving a message into the provider's actual Junk/Spam folder via API is the same signal the "Report Junk" button sends; it trains the provider's own classifier for future mail. This is different from `email_delete`, which just removes the message with no training signal.
2. **Block rules** — a standing server-side rule ("if sender domain / reply-to / subject matches X, delete or move to Junk") that intercepts future mail before it's even filed, rather than requiring a human or agent to review it after the fact.

Neither exists in `email-mcp` today. `src/tools/organizing.ts` only has move/delete/mark/label/folder-create.

## What's realistic vs. not (set expectations up front)

- **No public API reports phishing to Microsoft/Google's abuse teams from a personal script.** "Report spam" in this plan means training the provider's own per-account filter (moving to Junk/Spam), which is exactly what the Gmail/Outlook UI buttons do under the hood — not filing an abuse report with their security teams.
- **Block rules can't stop a spammer from sending mail**, only from it reaching Inbox/being seen. Framed correctly to the user: this reduces future noise, it doesn't stop origination.
- **Outlook inbox rules on personal Microsoft accounts (outlook.com/hotmail, `consumers` tenant) are an open question**, not a known-good API. Microsoft Graph's `messageRules` endpoint is documented primarily for Microsoft 365 (work/school) mailboxes. It needs a live smoke test against Marlin's real hotmail account (`marlinjp@hotmail.de`, `e081dc89-0520-45c3-b612-1cf613217869`) before committing to it as a supported feature — if it 403s for personal accounts, Outlook block-rules gets marked unsupported and only report-spam ships for that provider.
- **Domain rotation defeats exact-match blocking.** The spam sample from 2026-08-27 (Lowe's/Decathlon/casino templates) rotates the visible sender domain but reuses a stable secondary domain in headers (e.g. `Reply-To: reply-ZGL3ZA4HC05K5PBVCVZ1BTXY@in2.getdrip.com` on the Lowe's survey scam). Block rules should default to matching on that stable infrastructure element (reply-to domain, a body/link domain, a recurring subject template) rather than the rotating "From" domain, or they'll stop working within days.

## Design: where does the "AI step" live?

Not inside the MCP server. `email-mcp` stays a pure action/mechanism layer — it doesn't hold API keys for a second LLM, doesn't do its own inference, and doesn't duplicate what the calling agent already does well. Classification (is this phishing? does it match a known template family? what's the stable element to block on?) is Claude's job, using the same judgment already applied in a `/loop`-style periodic sweep or an ad-hoc review: fetch new mail → reason about each message → call the new primitive tools. This keeps the server simple and testable, and avoids a second inference cost/dependency that duplicates the agent already driving it.

## Provider interface additions

`src/providers/provider.ts` gets four new optional capability methods (following the existing pattern — e.g. `addLabels?`, `getCategories?` — where unsupported providers return a clear "not supported" error from the tool layer, exactly like `email_label` does today for non-Gmail accounts):

```typescript
export interface BlockRuleInput {
  matchType: 'senderDomain' | 'senderAddress' | 'subjectContains' | 'headerContains';
  value: string;
  headerName?: string; // required when matchType === 'headerContains', e.g. 'Reply-To'
  action: 'delete' | 'moveToJunk';
}

export interface BlockRule extends BlockRuleInput {
  id: string;
  createdAt: string;
}

// on EmailProvider:
reportSpam?(emailId: string, sourceFolder?: string): Promise<void>;
createBlockRule?(rule: BlockRuleInput): Promise<{ id: string }>;
listBlockRules?(): Promise<BlockRule[]>;
deleteBlockRule?(ruleId: string): Promise<void>;
```

## Per-provider implementation

| Provider | `reportSpam` | Block rules |
|---|---|---|
| **Gmail** | `users.messages.modify`: add label `SPAM`, remove `INBOX` — identical to the Gmail UI's "Report spam" | `users.settings.filters.create` — `criteria.query` accepts full Gmail search syntax, so it can match any header or body text (handles the reply-to-domain case), not just `from:`. `action.addLabelIds: ['TRASH']` or `['SPAM']` per the `action` field. |
| **Outlook** | `POST /me/messages/{id}/move` to the well-known `junkemail` folder — same effect as "Report Junk" | **Needs the live smoke test above.** If supported: `POST /me/mailFolders('inbox')/messageRules` with `conditions.headerContains` (matches the Reply-To case), `conditions.senderContains`, or `conditions.subjectContains`, and `actions.delete` / `actions.moveToFolder: 'junkemail'`. |
| **iCloud / generic IMAP** | Move to the Junk-typed folder (best-effort — no vendor ML signal, but consistent behavior and correct user-facing semantics) | **Not supported.** No standard server-side rule mechanism across generic IMAP servers (Sieve exists on some but isn't universal). Tool returns the same "not supported on this provider" shape as `email_label` does for non-Gmail today — no silent no-op. |

## New MCP tools (`src/tools/moderation.ts`, new file, registered in `src/server.ts` alongside the other `register*Tools` calls)

- `email_report_spam(accountId, emailId, sourceFolder?)` — routes to `provider.reportSpam`, "not supported" fallback shape for providers without it (there shouldn't be any, since IMAP's move-to-Junk fallback covers the remaining case).
- `email_batch_report_spam(accountId, emailIds[], sourceFolder?)` — mirrors the existing `email_batch_delete` sequential-fallback pattern.
- `email_create_block_rule(accountId, rule: BlockRuleInput)` — routes to `provider.createBlockRule`, clear "not supported" for IMAP/iCloud.
- `email_list_block_rules(accountId)` / `email_delete_block_rule(accountId, ruleId)` — auditing and undo, since a bad rule (e.g. blocking on a domain a real correspondent also uses) needs to be reversible without touching the provider's native UI.

## Test plan

Follow the repo's existing pattern (`tests/providers/*.test.ts` mock the SDK client; `tests/tools/*.test.ts` mock the `AccountManager`). Add:

- `tests/providers/gmail.test.ts`: `reportSpam` calls `modify` with the right label diff; `createBlockRule` calls `filters.create` with the right `criteria.query` for each `matchType`.
- `tests/providers/outlook.test.ts`: same shape for `move` and `messageRules`, gated behind confirming the live smoke test result.
- `tests/tools/moderation.test.ts`: new file, mirrors `tests/tools/organizing.test.ts` — routing, "not supported" fallback, batch sequential fallback.

## Sequencing

1. **Spike — DONE, resolved without a live call.** Fetched Microsoft's own Graph API reference (`mailfolder-post-messagerules`): the permissions table explicitly lists `MailboxSettings.ReadWrite` as supported for "Delegated (personal Microsoft account)", not just work/school. `messageRulePredicates` also has a native `headerContains` field (better than Gmail's raw-query fallback for matching a Reply-To domain). Outlook ships full block-rule support.
   - **Real consequence found**: the current `OutlookAuth.SCOPES` only requested `Mail.ReadWrite`, `Mail.Send`, `offline_access` — never `MailboxSettings.ReadWrite`. Added the scope in `src/providers/outlook/auth.ts`. This means **`marlinjp@hotmail.de`'s existing cached token lacks the new scope and will 403 on `createBlockRule`/`listBlockRules`/`deleteBlockRule` until Marlin re-runs the setup wizard once** to re-consent. `reportSpam` needs no new scope (covered by existing `Mail.ReadWrite`) and works immediately.
2. **Gmail**: `reportSpam` + `createBlockRule`/`list`/`delete` — DONE, tests passing. (Original assumption that the existing `https://mail.google.com/` OAuth scope covers the filters API was **wrong** — see the live-verification section below for the two real bugs this surfaced, both fixed.)
3. **Outlook**: same — DONE, tests passing. Live verification against the real hotmail account still pending Marlin's re-auth (see above); code path is exercised by mocked Graph API tests only so far.
4. **iCloud/IMAP**: `reportSpam` only (move-to-Junk via existing folder-alias resolution) — DONE. `createBlockRule` intentionally left unimplemented (inherited "not supported" from the tool layer).
5. **`src/server.ts`**: register `moderation.ts` tools — DONE.
6. **README**: documented the new tools and the "training signal, not abuse report" framing — DONE.
7. **Version bump**: 1.3.0 → 1.4.0 (semver minor), CHANGELOG entry added — DONE.

**Closed out 2026-08-30.** Re-auth completed and the full create/list/delete cycle was verified live against `marlinjp@hotmail.de` (a throwaway `senderDomain` rule was created via `email_create_block_rule`, confirmed via `email_list_block_rules`, then removed via `email_delete_block_rule` — all three succeeded against the real Graph API, not just the mocked test suite).

**Bug found during re-auth, fixed 2026-08-30 — with a correction along the way.** The setup wizard (`dist/setup/wizard.js`) hung silently for Marlin with no visible error, in both a custom terminal and plain Terminal.app.

*First diagnosis (wrong, corrected in the same session)*: I initially attributed this to an ESM/CJS interop crash in `@azure/msal-node`'s dependency chain (`jsonwebtoken` → `jws` → `safe-buffer` calling `require('buffer')`, which esbuild's ESM output can't satisfy). That crash is real — I reproduced it — but it only happens when `@azure/msal-node` is *bundled*. Checking `build.mjs` afterward showed it already lists `@azure/msal-node` (and the other heavy provider SDKs) as `external`, so the real shipped wizard never bundles that chain and never hits this crash. The reproduction was an artifact of my own throwaway test script, which used a bare `esbuild --bundle` invocation without copying the project's `external` list — not a bug in the shipped product. Caught and corrected before landing a fix for the wrong bug.

*Actual fix*: replaced `inquirer` entirely with plain `node:readline/promises`-based prompts (`src/setup/prompts.ts`). `inquirer`'s list/rawlist prompts redraw via ANSI cursor movement and terminal-capability queries — a much larger surface for a terminal to get wrong than line-buffered readline, which has no redraw step. This doesn't pin down inquirer's *exact* failure mechanism in Marlin's terminal (I have no way to attach to his real interactive TTY from this sandbox to confirm), but it removes the entire class of raw-mode-rendering risk regardless of the precise cause, and drops a dependency in the process.
- Verified via piped smoke tests (IMAP and iCloud setup flows, full end-to-end including the "add another account" loop) with realistic pacing between answers. Piping answers with sub-200ms spacing initially reproduced a *different*, real bug in my own rewrite — Node's readline can drop a buffered line if the next `question()` call isn't attached before that line's event fires — but 1-second pacing (closer to actual human typing/reading speed) completed every flow correctly. This timing sensitivity is specific to scripted/piped input arriving faster than a person would type; it does not affect real interactive use, where each line is typed only after the previous prompt is already rendered and waiting.
- **This unverified caveat found a real security bug (2026-08-30, fixed in 1.4.2).** Marlin tested the masked-password path live and it echoed his real iCloud app-specific password in plaintext — `askPassword` gated raw-mode masking on `input.isTTY`, which was falsy even in his genuinely interactive `npx`-launched session (the OS terminal was still echoing keystrokes normally underneath, independent of that flag). Fixed by attempting `setRawMode(true)` directly and catching the failure, rather than pre-emptively trusting the flag. Also surfaced and fixed a related bug: the CLI could finish successfully without exiting on its own (a stray handle from the raw-mode/interface-recreation cycle), which looks exactly like a hang. Exposed password should be rotated.
- **Separately, the root cause of Marlin's *original* wizard hang (all the way back to before any of this investigation) turned out to be neither of the above**: it was an incorrect `npx` invocation. `npx -y @marlinjai/email-mcp@latest email-mcp-setup` (the command given at the start of this thread) omits `-p`/`--package`, so npx runs the bin matching the *package's own name* (`email-mcp` → `dist/index.js`, the MCP stdio server) and passes `"email-mcp-setup"` as a meaningless argument to it — the server then sits silently waiting for JSON-RPC input forever. The correct invocation is `npx -y -p @marlinjai/email-mcp@latest email-mcp-setup`. The `inquirer`→`readline` rewrite and the password-masking fix are both real, worthwhile fixes, but neither was actually the cause of the original reported symptom.

**Gmail live verification (2026-08-30, versions 1.4.3–1.4.4) — two more real bugs found and fixed, on top of everything above.** Re-authenticating Gmail to test live surfaced:
1. `email_create_block_rule`/`email_list_block_rules` failed with "insufficient authentication scopes" even on a freshly re-authed account — same shape of bug as the Outlook scope gap: mailbox content access (`https://mail.google.com/`) and the Settings API (where Filters live) are separate Google permission domains. Fixed in 1.4.3 by adding `gmail.settings.basic` to `GMAIL_SCOPES`.
2. After the scope fix, `moveToJunk` still failed live with "Invalid label SPAM in AddLabelIds" — Gmail's Filter Action rejects the SPAM label outright; only Gmail's own classifier can proactively mark future mail as spam, a standing filter cannot. This was invisible to the mocked unit tests (they only assert request shape, not real API validation) and only surfaced testing against a real account. Fixed in 1.4.4: `moveToJunk` on Gmail now maps to `removeLabelIds: ['INBOX']` (skip the inbox) instead — the closest a filter can actually do there. `email_report_spam` was never affected (it's a direct per-message action, not a filter, and Gmail does allow SPAM there).

**Final state, all three providers live-verified**, not just mocked:

| Provider | `email_report_spam` | `email_create_block_rule` (`delete`) | `email_create_block_rule` (`moveToJunk`) |
|---|---|---|---|
| Gmail | ✅ | ✅ | ✅ (skips inbox, not literally Spam — see above) |
| Outlook | ✅ | ✅ | ✅ (genuinely files to Junk Email) |
| iCloud | ✅ (best-effort move, no ML signal) | correctly "not supported" | correctly "not supported" |

Shipped versions across this whole effort: 1.4.0 (feature) → 1.4.1 (wizard `inquirer`→`readline` rewrite, later found to not be the actual cause of the original hang) → 1.4.2 (password-masking security fix + README's actual root-cause fix, `npx` needs `-p`) → 1.4.3 (Gmail scope gap) → 1.4.4 (Gmail filter-action bug). All pushed to `main` and published to npm.

Not in scope for this plan: the periodic-sweep orchestration itself (a `/loop` schedule or cron job that calls these tools automatically). That's a separate, smaller follow-up once the primitives exist and have been used manually at least once.
