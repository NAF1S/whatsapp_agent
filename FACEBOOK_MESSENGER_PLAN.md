# Adding Facebook Messenger as a second channel — plan

> Status: **Phase 1 implemented and tested; NOT yet deployed; Phases 2–4 not started.**
> Researched 2026-10-16 against Meta's live docs.

## Implementation status (2026-10-16)

**Done, typechecked and tested (28/28 assertions passing):**

| Piece | File |
|---|---|
| Webhook route — GET handshake + POST events | `agent/src/channels/messenger/webhook.ts` |
| `X-Hub-Signature-256` verification (constant-time, raw-bytes) | `agent/src/channels/messenger/signature.ts` |
| Customer identity namespacing (`fb:<psid>`) | `agent/src/channels/messenger/identity.ts` |
| Graph API client — send, typing, mark_seen, attachment fetch | `agent/src/channels/messenger/client.ts` |
| Config block (deliberately **not** `required()`) | `agent/src/config.ts` |
| Optional `channel` field on the job payload | `agent/src/preprocessor/index.ts` |
| Route mounted **before** `express.json()` | `agent/src/index.ts` |
| Four new env vars, blank by default | `agent/.env.example` |

The test harness mounts **only the router** on a spare port — never `index.ts`, which would
start a second BullMQ worker and cause duplicate customer replies. It covers the handshake,
signature accept/reject (tampered body, wrong secret, missing header, non-hex), echo/delivery
suppression, Bengali round-tripping, and UTF-8 chunking of long messages.

**Phase 1 deliberately does not enqueue or reply.** The worker is not channel-aware yet;
handing it a Messenger job today would send a reply to a PSID via the WhatsApp bridge. The
webhook verifies, parses and logs — nothing else.

**Not deployed yet.** The route only becomes live after `pm2 restart hh-agent`, which briefly
interrupts customer replies. Not done during business hours on purpose.

**Still to do — Phase 2** (needs the real credentials to test):
1. Swap `manager.ts`'s inline `replace(/[^\d+]/g,'')` for `normalizeCustomerId()` — must be
   done at *every* call site, or a Messenger PSID collides with a phone number.
2. `channel` dispatch: `sendMessage(channel, to, …)` replacing the two hardcoded WhatsApp
   send sites (`worker.ts:117-130`, `tools.ts:281`).
3. Immediate acknowledgement + `sendTypingOn` before the brain runs (the 30-second policy).
4. Inbound attachment download via `fetchAttachment()`.
5. Enqueue from the webhook.

**Then Phases 3–4** — dashboard channel badges, channel-neutral prompt/vision/escalation text,
and optionally Instagram.
> Meta restructured these docs; the current home is
> `developers.facebook.com/documentation/business-messaging/messenger-platform/`
> (there is a machine-readable index at `…/messenger-platform/llms.txt`). Graph API **v26.0**.
> Anything I could not verify is marked **[UNCERTAIN]** — do not treat those as fact.

---

## 1. Read this first: two findings that set the timeline

### 1.1 The gate is Business Verification + App Review, not code

This is the long pole, and it is **not** something more engineering solves.

- In **Development Mode** the bot can only exchange messages with accounts holding a role on
  the app or Page (Admin / Developer / **Tester**). Every other customer's message lands in the
  Page inbox with **no bot reply**.
- To message **real customers** you need **Advanced Access** for `pages_messaging`, and
  **"Business Verification is required to get Advanced Access."**
- Business Verification means submitting your **legal business documents** to Meta. It is a
  manual review with a queue.
- Advanced Access is granted **per permission**, via App Review, and reviewers must be able to
  reach and exercise the app.
- Expect an **annual Data Use Checkup** afterwards.

**Practical consequence:** you can build and fully test this with 2–3 real Facebook accounts
holding the Tester role, starting today. But you cannot serve actual customers until
verification clears. Treat the Meta paperwork as a **parallel track started on day one**, not a
step at the end.

> **Uncertain but important:** Meta's own overview says App Review "isn't needed if you only
> message on your own Facebook Page," which *suggests* a first-party single-Page operator may
> get advanced `pages_messaging` without a full review. However **Business Verification is
> still required**. Third-party reports of a 2026 "Tech Provider" gate on `pages_messaging`
> Advanced Access are **[UNCERTAIN]** — forum-only, not in the official docs I fetched.
> Safest planning assumption: **Business Verification is the hard gate; budget for App Review too.**

### 1.2 The 30-second bot-response policy collides with your latency

Meta's Platform Policy requires that automated bots **answer any and all input and respond
within 30 seconds**. Your measured latency is **p50 ≈ 9 s, p90 ≈ 23–37 s** (AGENT.md §7).

That means a meaningful slice of replies would breach the policy as-is.

**Design consequence — and it's a good one:** the Messenger reply must be sent as
**two messages**:

1. An **immediate acknowledgement** (~1–2 s), e.g. "একটু দেখে নিচ্ছি…" — sent the moment the
   webhook arrives, plus a `typing_on` sender action.
2. The **real answer** when the brain finishes, as a normal reply.

This satisfies the 30-second expectation, makes a 30-second wait feel intentional rather than
broken, and is something the current WhatsApp path **cannot** do (your bridge has no typing
indicator at all — verified, no `sendPresenceUpdate` anywhere).

---

## 2. Why this is architecturally cheap

**You do not need a second bridge process.** `whatsapp_bridge/` exists only because Baileys
holds a persistent WhatsApp Web socket with a QR-paired session. Messenger is **webhook-in /
REST-out** — no socket, no pairing, no `auth_info` that can be wiped.

**You already have the public HTTPS endpoint.** The Cloudflare tunnel publishes
`agent.apigateway.live → :3000`, which is exactly what Meta requires for a callback URL. So:

| Piece | WhatsApp today | Messenger |
|---|---|---|
| Inbound transport | `whatsapp_bridge/` (PM2 app, Baileys socket) | `POST /api/webhook/messenger` on the **existing** agent |
| Outbound transport | `POST 127.0.0.1:3001/send` to the bridge | direct HTTPS call to the Graph API, **in-process** |
| New PM2 app | — | **none** |
| New port / tunnel change | — | **none** |

The queue seam is what makes this tractable: the bridge's whole job is to normalise a message
into a job. A Messenger webhook enqueues the **same payload shape**, and the brain, tools, RAG,
sessions and escalation then work unchanged.

---

## 3. The work, in phases

### Phase 0 — Meta paperwork (start immediately, blocks everything)

1. Create a **Business portfolio** in Business Manager.
2. Create the app (Business type, use case "Engage with customers on Messenger from Meta").
3. Connect the Page, generate the token, configure the webhook (§5, §6).
4. **Submit Business Verification.**
5. Collect the credentials in §4 and put them in `.env` (§7).

### Phase 1 — Receive (read-only, safe, fully testable in dev mode)

- `POST /api/webhook/messenger` — GET handshake + POST events, following the
  `/api/webhook/product-sync` pattern (`index.ts:48-81`).
- **Verify `X-Hub-Signature-256`** before anything else (§8).
- Parse `entry[].messaging[]`, map to `IncomingRawPayload`, enqueue, **return 200 immediately**.
- Log only at first — no replies. This proves the pipeline end to end without touching the
  customer-facing WhatsApp path.

### Phase 2 — Reply

- Add `channel` to `IncomingRawPayload` (`preprocessor/index.ts:5-20`).
- Replace the two hardcoded WhatsApp send sites with `sendMessage(channel, to, …)`:
  `worker.ts:117-130` (`/send`) and `tools.ts:281` (`/send-image`).
- Send the immediate acknowledgement + `typing_on`, then the real reply (§1.2).
- Inbound media: Messenger sends **URLs**, fetched with the Page token — simpler than Baileys'
  encrypted blobs, but it must produce the same `mediaBase64` / `mediaList` the preprocessor
  expects (`preprocessor/index.ts:41-100`).

### Phase 3 — Make the stack channel-aware

- **Identity** (§9) — the one real design decision.
- Dashboard: channel badge per conversation; the "WhatsApp Gateway" card is WhatsApp-specific
  (`dashboard/index.html:31-63, 78-101`).
- Prompt text: `prompt.ts:1,46` says "official WhatsApp customer support AI agent"; the vision
  prompts say "The customer sent this image on WhatsApp" (`gemini.ts:171`, `deepseek.ts:165`);
  escalation copy promises contact "on WhatsApp" (`agent.ts:121-125`). All become
  channel-neutral or channel-aware, or your bot will tell Messenger customers it's a WhatsApp
  assistant.
- `tools.ts:610` writes an order note naming "Hide Haven WhatsApp AI Assistant".

### Phase 4 — Instagram DMs (nearly free, same app)

Attach an **Instagram Professional account** to the same Page → same app, same webhooks, same
`graph.facebook.com`. Extra permissions: `instagram_basic`, `instagram_manage_messages`.
Users are identified by **IGSID** instead of PSID. You lose `message_deliveries`, one-time
notifications and sponsored messages on IG. If you're doing Messenger at all, decide on this
now — it's the same sitting.

---

## 4. Credentials — what I need from you

**Do not paste secrets into chat.** Put them straight into `agent/.env` (§7). Two of these are
genuinely secret; the rest are identifiers.

| # | Credential | Secret? | Where in Meta's dashboard |
|---|---|---|---|
| 1 | **App ID** | Identifier | App Dashboard → **Settings → Basic** |
| 2 | **App Secret** | **SECRET** | App Dashboard → **Settings → Basic** (click *Show*) |
| 3 | **Page ID** | Identifier | Numeric ID of the Facebook Page |
| 4 | **Page Access Token** | **SECRET** | Messenger → API Setup → **Token Generation** |
| 5 | **Webhook Verify Token** | You invent it | You type it into **Configure webhooks** |
| 6 | Business portfolio ID | Identifier | Business Settings (only needed for the system-user route) |

Also useful: the **Page's name / URL**, and confirmation of which Page.

For #5, generate a long random string — treat it as a secret, since anyone who knows it can fake
a subscription. I can generate one for you if you prefer.

### Token type — use a System User token if you can

Two options, and this matters for a server that runs unattended for months:

- **System User token** *(recommended)* — Business Settings → Users → System users. Long-lived /
  non-expiring, and the standard production choice for unattended servers. **Caveat
  [UNCERTAIN]:** widely used in practice for Page messaging, but I could not find an official
  Messenger doc explicitly naming it for `POST /{page-id}/messages`.
- **Page Access Token** — Meta's docs say Page tokens "do not have an expiration date" (unlike
  ~60-day *user* tokens), but they *are* invalidated by things like a password change, the
  granting user losing their Page role, or app removal. The exact invalidation list is on a page
  I could not retrieve **[UNCERTAIN]**.

**Either way, build a rotation path.** A dead token silently stops all Messenger replies — the
same class of failure as the Redis outage that already bit you. Whatever we use, the health
check should start watching it.

---

## 5. Getting the credentials — the click path

Meta's console is now **use-case driven**; pre-2026 tutorials will mislead you.

1. Register at `developers.facebook.com`; create a **Business portfolio** first (required for
   the system-user route and for Advanced Access).
2. **My Apps → Create app** → name + contact email → Next.
3. **App type = Business.** (Consumer apps "can't generate access tokens".)
4. **Use case = "Engage with customers on Messenger from Meta."** *(This replaces the old "add
   the Messenger product" step.)* Required permissions `business_management`,
   `page_manage_metadata`, `pages_messaging`, `pages_show_list`, `public_profile` are locked on.
5. **Connect the Page:** Messenger API Setup → *Generate access tokens* → **Connect** →
   **Continue** → tick your Page(s) → **Continue** → **Save** → **Got it**.
6. **Get the Page Access Token:** same area → **Token Generation** → pick the Page → copy the
   token. *(Not persisted in the UI; re-selecting mints a fresh one. Old ones keep working.)*
7. **Configure the webhook:** **Configure webhooks** → Callback URL **+** Verify token → save →
   **Add Subscriptions** → tick fields → **Confirm**.
   - Callback URL: `https://agent.apigateway.live/api/webhook/messenger`
   - Tick at minimum: `messages`, `messaging_postbacks`, `message_reactions`.
     Consider `message_deliveries`, `message_reads`, `message_echoes`, `messaging_referrals`,
     `messaging_optins`, `messaging_policy_enforcement`.
   - **The endpoint must already be live and answering the GET handshake, or the save fails** —
     so Phase 1 ships before this step.
8. **Test with real accounts holding the Tester role.** *(Widely claimed that Meta "test users"
   can't hold Messenger conversations — **[UNCERTAIN]**, third-party only.)*

**Watch for:** `business_management` is a **prerequisite** for `pages_messaging` and
`pages_show_list` — call this out in your App Review submission.

---

## 6. Policy constraints that shape the design

| Rule | Detail | Impact on us |
|---|---|---|
| **24-hour window** | You may send freely for 24h after the customer's last message; each new message resets it. Outside it, sends fail with error **1545041**. | Fine — customers initiate. Every bot reply resets nothing; only *their* messages do. |
| **30-second bot response** | Bots must respond within 30s. | **Drives the two-message design (§1.2).** |
| **`HUMAN_AGENT` tag = 7 days** | Lets a *human* reply up to 7 days out. Not for automated or promotional messages. Requires App Review **and** Business Verification. | Needed if your admin answers an escalated Messenger thread late. Your 30-min handoff timeout fits inside the 24h window, so this is an edge case — but a real one. |
| **Tags retired 2026-04-27** | `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` now error (code 100). | Don't build on them. Replacements: Utility templates, Marketing Messages API. |
| **No cold outreach** | The person must initiate. | Matches your model. |
| **Bot disclosure** | Where law requires (notably **California, Germany**), users must be told they're talking to a machine. | Consider a one-line disclosure on Messenger. Your WhatsApp bot doesn't do this today. |
| **Rate limits** | 300 calls/sec for text (10/sec for audio/video), capped at `200 × Engaged Users` per 24h. Above ~40 msg/sec, new messages stop appearing in the Page Inbox. | Nowhere near your volume. Not a concern. |

---

## 7. Where the credentials go

Add to `agent/.env`, and mirror the names into `agent/.env.example` with **blank values**:

```
MESSENGER_PAGE_ID=
MESSENGER_PAGE_ACCESS_TOKEN=
MESSENGER_APP_SECRET=
MESSENGER_VERIFY_TOKEN=
```

All four should be read through the existing `required()` helper in `agent/src/config.ts` —
no hardcoded fallbacks. That is exactly the class of bug that leaked three live credentials into
the repo's first push (see AGENT.md §6.2). Same rule as the Redis password: they live in `.env`,
never in source, never in chat.

---

## 8. Webhook security (exact requirements)

**GET verification handshake** — Meta sends
`?hub.mode=subscribe&hub.verify_token=<yours>&hub.challenge=<int>`.
Respond **200 with the raw challenge value** when mode is `subscribe` *and* the token matches;
otherwise **403**.

**POST signature** — verify the **`X-Hub-Signature-256`** header (prefixed `sha256=`):

- HMAC-**SHA256** over the **raw request body**, keyed with the **App Secret**
- **Constant-time compare**
- **Critical:** Meta signs an **escaped-unicode** rendering of the payload with lowercase hex.
  You must hash the **exact raw bytes** you received — if Express has already parsed the JSON,
  you've lost the bytes. This needs `express.raw()` on that route, *before* the global
  `express.json()` (`index.ts:16`).

**Respond fast:** docs say 5 seconds in one place, 20 in another (a real conflict). Failed
deliveries retry immediately a few times, then after ~1h of failures **the subscription is
disabled and removed**. Since your brain takes 9–37s, the webhook must **enqueue and return,
never process inline.** Your queue architecture already does exactly this — this is why it must
stay that way.

Events are **not ordered**; sort by the payload `timestamp`.

---

## 9. The one real design decision: identity

`sessions.phone` is the **PRIMARY KEY** (`setup-supabase.sql:23`) and `messages.phone`
foreign-keys to it (`:35-37`). The per-customer mutex keys on phone digits (`worker.ts:28`), the
dashboard is built on `currentPhone` (`dashboard/app.js:2, 473-483, 504`), and admin reply is
`{ phone, text }` (`:423`).

Messenger has **no phone number** — it has a **PSID**, a page-scoped opaque ID.

| | Approach | Cost | Risk |
|---|---|---|---|
| **A** | Namespace the existing column: `fb:<psid>` for Messenger, bare digits for WhatsApp | Small — no PK/FK change; dashboard and admin API keep working | `phone` becomes a misnomer; `VARCHAR(30)` may need widening |
| **B** | Add a `channel` column, key on `(channel, external_id)` | Large — PK/FK migration, every `manager.ts` method, both admin routes, the dashboard | Clean long-term, but touches the live customer path |

**Recommendation: A first, B later if it earns its keep.** A composite-PK migration on a table
serving live customers is the kind of change that goes wrong at 2am.

**A free win:** `place_order` already collects a **phone number** during checkout. So a Messenger
customer who orders hands you the link between their PSID and their phone — the path to a
unified customer view across channels, for almost no extra work.

---

## 10. Risks

1. **Business Verification is a hard external gate.** If it stalls, nothing ships to real
   customers. Start it day one.
2. **The 30-second policy vs 9–37s latency** — mitigated by the acknowledgement message, but
   worth measuring after launch.
3. **Token death silently kills the channel** — no error, no replies. Needs monitoring in
   `healthcheck.sh`, like Redis.
4. **Touching shared code risks the WhatsApp path.** Mitigation: `channel` defaults to WhatsApp,
   Phase 1 is additive and read-only, and every phase is verified with
   `scripts/healthcheck.sh` before moving on.
5. **`[UNCERTAIN]` items** in §1.1 and §4 could shift the plan — verify in the dashboard before
   committing to a timeline.

---

## 11. Open questions for the owner

1. **Identity: approach A or B?** (§9)
2. **Instagram DMs in the same pass, or Messenger only?** (§Phase 4)
3. **Which Page**, and is there already a Business portfolio?
4. **Who can act as a Tester** during development — you have 2–3 real Facebook accounts?
5. **Should the bot disclose it's automated** on Messenger? (§6)
