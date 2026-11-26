# ClientFinder — Implementation Status

- **Date:** 2026-11-26
- **Branch:** `fix/doku-amount-verification` (from `main` @ `3de574f`)
- **Assignment:** "jalanin ClientFinder juga". No specific feature request was given, so this round is an audit plus QA, with fixes only
  where the code contradicts its own documentation or a test proves a defect. No speculative features were added.

## 1. What the application is (from README, docs/ARCHITECTURE.md and the code)

A B2B prospecting engine. It searches Google Places for local businesses, keeps a lead pipeline (New → Contacted → Interested →
Closed), runs WhatsApp outreach (1-click and timed broadcast from the browser), and tracks Places API usage per user.

- **Auth:** JWT in an httpOnly cookie, scrypt passwords, session revocation.
- **Roles:** SUPERADMIN / ADMIN / USER.
- **Database:** SQLite/libSQL or PostgreSQL through Drizzle.
- **Payments:** DOKU Checkout for paid plans.
- **Demo:** a read-only demo console.

## 2. Feature inventory

| Area | Status | Evidence |
|---|---|---|
| Login / session / logout revocation | Implemented, tested | `tests/e2e.mjs` (login, 403s, logout revokes session) |
| RBAC (SA / Admin / User), category isolation | Implemented, tested | E2E: RBAC 403s, category scoping |
| Places search (pagination, website filter, 100 cap, phone normalisation, dedupe) | Implemented, tested | E2E with `tests/fake-places.mjs` |
| Atomic API-hit tracking + usage metrics | Implemented, tested | E2E: counter = log rows |
| Lead pipeline, claim / release, status updates | Implemented, tested | E2E |
| Export CSV / XLSX | Implemented, tested | E2E |
| Broadcast (spintax, queue) | Implemented, client-side only | No automated test (browser queue) |
| Demo mode (read-only, no login) | Implemented, partly tested | E2E checks demo cookie paths; APIs never honour the demo cookie |
| DOKU checkout + webhook + order status | Implemented; **tested in this round** | New E2E section (see 4) |
| Admin orders list / revenue | Implemented, untested | — |
| Categories reset / user reset-password | Implemented, untested | — |

TODO / FIXME / HACK markers in the code: **none**.

## 3. Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium (data integrity) | `/api/doku/notification` marked an order PAID when the notification had **no amount**, amount `0` or a non-numeric amount. The amount was only compared when it was present and positive, contrary to the README ("Nominal notifikasi dibandingkan dengan `orders.amount` sebelum order ditandai lunas"). A valid DOKU signature was still required. | **Fixed:** the amount is mandatory and must equal `orders.amount`, otherwise the order stays PENDING (fail closed, DOKU still gets 200). |
| 2 | Low | The webhook computed the expected signature with the `Client-Id` taken from the request header, so a different merchant id in the header was accepted (it still needed the secret key). | **Fixed:** the signature always uses the configured client id; a different `Client-Id` header is rejected (401). |
| 2b | Medium | A validly signed notification with an odd JSON shape (`null`, numeric `invoice_number`, non-string status) could throw (500) and make DOKU retry. Pre-existing. | **Fixed:** shape and types are validated; such notifications get 200 and are ignored. |
| 3 | Low | `markOrderPaid` does a select followed by an update (not one conditional update). Concurrent duplicate notifications can both write `paid_at`; the status never goes back. | Documented, not changed. |
| 4 | Doc | README said demo/mock mode no longer exists; `lib/demo-*` and `proxy.ts` implement a read-only demo console. | **Fixed** (README). |
| 5 | Doc | README did not say that E2E needs `GOOGLE_PLACES_API_BASE_URL=http://127.0.0.1:4010/v1` (the fake server serves `/v1/...`); without it every search returns 502. | **Fixed** (README). |
| 6 | **Blocker (dependency)** | `next build` (Next.js 16.4.3, pinned in `package.json`) compiles, then sometimes aborts with `SecurityFatalError: Your version of Next.js is affected by a known security vulnerability` (exit 1). In this session: one failure, then success, then failure, then success. CI runs `npm run build`, so it can fail for reasons unrelated to code changes. | **Not changed.** Upgrading `next` changes `package.json` / `package-lock.json` and needs approval. |
| 7 | Info | CI (`.github/workflows/ci.yml`) runs automatically on push to `main` and on pull requests (and on manual dispatch), so pushing a feature branch alone triggers no workflow. `pages.yml` deploys automatically on `main` only (also manually dispatchable). | — |

## 4. Tests run in this round

| Check | Result |
|---|---|
| `npm ci` | OK (lockfile unchanged) |
| `npm run typecheck` | Pass |
| `npm run build` | Pass (exit 0 on the final run; see finding 6) |
| `tests/e2e.mjs` (existing, fake Places, throw-away SQLite) | 62/62 assertions pass |
| `tests/e2e.mjs` with the new DOKU section | 76/76 pass. Before the fix the new assertions failed at "Client-Id lain" and "SUCCESS tanpa nominal". |

The DOKU section runs only against a local `BASE` with `E2E_DOKU_FAKE=1` and `E2E_DOKU_CLIENT_ID` / `E2E_DOKU_SECRET` set, asserts the fake payment URL, together with a server pointed at the fake DOKU
endpoint; see README → Verifikasi. Test values only, never real credentials.

## 5. Files changed

- `app/api/doku/notification/route.ts`: the amount is mandatory and must match.
- `lib/doku.ts`: the webhook signature is pinned to the configured client id.
- `tests/fake-places.mjs`: fake DOKU checkout endpoint.
- `tests/e2e.mjs`: optional DOKU payment E2E (signature, Client-Id, FAILED, missing / 0 / wrong amount, paid, idempotent).
- `README.md`: demo mode note; E2E base URL; how to run the DOKU E2E.
- `docs/implementation-status.md`: this file.

## 6. Pending clarification (ClientFinder)

1. What "jalanin ClientFinder" means in scope: deploy and operate it, or develop specific features? No feature list was given.
2. Approval to upgrade `next` (finding 6), and to which version.
3. Whether the payment amount rule (finding 1) matches how DOKU is actually configured for this merchant. It is documented in the
   README, but needs confirming against DOKU's real notification payloads.
4. Whether untested admin paths (orders list, category reset, password reset) should get E2E coverage next.

## 7. Next actions

- Decide on the `next` upgrade, then confirm that CI passes on a pull request.
- Push blocked (2026-11-26): the GitHub account in use has no write access to `Rextrim-Project/clientfinder`. Once access is granted, push the branch and open a pull request from `fix/doku-amount-verification` so `ci.yml` runs (pushing the branch alone does not trigger CI).
- Optional: make `markOrderPaid` a single conditional update (finding 3).
