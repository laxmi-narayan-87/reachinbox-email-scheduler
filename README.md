# ReachInbox Email Scheduler

A production-oriented email scheduling platform built from scratch with TypeScript, Express, PostgreSQL, Prisma, Redis, BullMQ, and Next.js.

This implementation combines useful ideas from multiple reference projects while fixing common scheduler problems such as non-staggered bulk jobs, worker-side `setTimeout`, weak idempotency, and incorrect rate-limit retries.

## Current architecture

```text
                    +----------------------+
                    |    Next.js Dashboard |
                    | Compose / Batch / KPI|
                    +-----------+----------+
                                |
                              HTTP
                                |
                    +-----------v----------+
                    |     Express API      |
                    | Auth / REST / Upload |
                    +----+------------+----+
                         |            |
                         v            v
                 +-------------+  +---------+
                 | PostgreSQL  |  |  Redis  |
                 | source of   |  | BullMQ  |
                 | truth       |  | limits  |
                 +------+------+  +----+----+
                        |              |
                        |              v
                        |       +-------------+
                        +------>| Email Worker|
                                | claim/retry |
                                +------+------+ 
                                       |
                         +-------------+-------------+
                         |             |             |
                         v             v             v
                       SMTP          Gmail       Outlook/Graph
```

## Reliability model

PostgreSQL stores business state. Redis is used for queue coordination and distributed rate limiting. BullMQ owns delivery timing; the worker does not use `setTimeout` for schedule spacing.

Email processing uses:

```text
SCHEDULED -> PROCESSING -> SENT
        \-> PROCESSING -> FAILED
        \-> CANCELLED
```

The worker atomically claims a scheduled email before sending:

```sql
UPDATE Email
SET status = 'PROCESSING', processingAt = NOW()
WHERE id = ? AND status = 'SCHEDULED';
```

Only one worker should observe an affected-row count of `1`, preventing concurrent workers from independently claiming the same email.

The system uses at-least-once job processing. External providers can accept a message immediately before a worker crashes, so exactly-once external delivery cannot be guaranteed by the application alone.

## Outbox pattern

Scheduling writes the email and its `EMAIL_SCHEDULED` outbox event in the same PostgreSQL transaction:

```text
API request
   |
   +--> Email = SCHEDULED
   |
   +--> OutboxEvent = PENDING
          |
          v
      publisher
          |
          v
       BullMQ
          |
          v
        worker
```

This avoids a silent DB-success/queue-failure gap.

## Rate limiting

Every sender has an hourly quota. The worker uses an atomic Redis counter with a UTC-hour bucket:

```text
email-rate:{senderId}:{YYYYMMDDHH}
```

When the quota is exhausted, the current slot is released and the email is scheduled for the next UTC hour instead of using ordinary exponential retry. Ordinary transient failures use BullMQ retry/backoff separately.

## Bulk scheduling and CSV upload

Bulk scheduling calculates every delivery time explicitly:

```text
baseTime + (index * delayBetweenEmailsMs)
```

The API also accepts multipart CSV uploads at:

```text
POST /api/batches/upload
```

The CSV parser validates the `email` column, counts invalid rows and duplicates, and schedules only unique valid recipients.

Example response summary:

```text
Total rows: 10,000
Valid:       9,721
Invalid:       181
Duplicates:     98
```

## Authentication

Development can use `/api/bootstrap`, but that endpoint is disabled when `NODE_ENV=production`.

Production authentication is Google OAuth:

```text
GET /auth/google
    |
    v
Google consent
    |
    v
GET /auth/google/callback
    |
    +--> verify state
    +--> exchange code
    +--> fetch identity
    +--> create/update User
    +--> store Gmail token material encrypted
    +--> create HttpOnly session cookie
```

You must create the Google OAuth application yourself in Google Cloud Console and provide:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL
```

For local development the callback is:

```text
http://localhost:5000/auth/google/callback
```

The application requests Gmail send scope so the connected Gmail sender can use the Gmail API.

## Provider credentials

Provider secrets are not returned by sender API responses. SMTP passwords should be sent through `providerConfig.password` and are encrypted before storage when configured through the API.

The repository also supports Gmail and Outlook provider adapters. Their OAuth applications/credentials must be created outside the repository and supplied through environment variables or encrypted sender configuration.

Required encryption key:

```text
CREDENTIAL_ENCRYPTION_KEY=<base64-encoded 32-byte AES key>
```

Generate one locally with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Repository structure

```text
reachinbox-email-scheduler/
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── auth.ts
│   │       ├── oauth.ts
│   │       ├── csv.ts
│   │       ├── google-routes.ts
│   │       └── index.ts
│   ├── worker/
│   │   └── src/
│   │       ├── provider.ts
│   │       └── index.ts
│   └── web/
│       └── src/app/
├── packages/
│   ├── database/
│   │   └── prisma/schema.prisma
│   ├── queue/
│   │   └── src/index.ts
│   └── shared/
│       └── src/index.ts
├── .github/workflows/ci.yml
├── docker-compose.yml
├── .env.example
├── package.json
└── pnpm-workspace.yaml
```

## Stack

| Layer | Technology |
|---|---|
| Web | Next.js + React + TypeScript |
| API | Node.js + Express + TypeScript |
| Worker | Node.js + BullMQ + TypeScript |
| Database | PostgreSQL |
| ORM | Prisma |
| Queue | BullMQ |
| Distributed coordination | Redis |
| Validation | Zod |
| Mail transport | Nodemailer / SMTP / Gmail API / Microsoft Graph |
| Local infra | Docker Compose |

## Local setup

### 1. Prerequisites

- Node.js 20+
- pnpm 10+
- Docker Desktop or Docker Engine
- SMTP account for real delivery, or Ethereal for safe development testing

### 2. Install dependencies

```bash
pnpm install
```

### 3. Start infrastructure

```bash
docker compose up -d
```

### 4. Configure environment

```bash
cp .env.example .env
```

Set at minimum:

```text
DATABASE_URL
REDIS_URL
WEB_ORIGIN
CREDENTIAL_ENCRYPTION_KEY
```

Add Google credentials before testing Google login/Gmail sending.

### 5. Generate Prisma client and run migrations

```bash
pnpm db:generate
pnpm db:migrate
```

### 6. Run services

```bash
pnpm dev
```

API: `http://localhost:5000`

Web: `http://localhost:3000`

### 7. Run quality checks

```bash
pnpm typecheck
pnpm build
pnpm test
```

## User-only setup still required

The repository cannot create third-party credentials on your behalf. Before real OAuth/provider testing, you need to:

1. Create a Google Cloud OAuth client and add `http://localhost:5000/auth/google/callback` as an authorized redirect URI.
2. Put the Google client ID/secret in your local `.env` or deployment secret store.
3. Generate `CREDENTIAL_ENCRYPTION_KEY` and keep it secret.
4. Create Microsoft Entra credentials if you want to activate Outlook/Graph OAuth.
5. Configure your actual SMTP credentials if you want SMTP delivery instead of Ethereal.

Never commit `.env` or provider secrets to GitHub.

## Tests included

- CSV validation and duplicate handling
- Provider factory selection

The next testing layer should run end-to-end with disposable PostgreSQL/Redis services in CI and a mocked mail provider.
