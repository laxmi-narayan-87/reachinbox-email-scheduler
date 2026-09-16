# ReachInbox Email Scheduler

A production-oriented email scheduling platform built from scratch with TypeScript, Express, PostgreSQL, Prisma, Redis, BullMQ, and Next.js.

This implementation combines the useful ideas from multiple reference projects while fixing common scheduler problems such as non-staggered bulk jobs, worker-side `setTimeout`, weak idempotency, and incorrect rate-limit retries.

## Current architecture

```text
                    +----------------------+
                    |    Next.js Dashboard  |
                    | Compose / Batch / KPI |
                    +-----------+----------+
                                |
                              HTTP
                                |
                    +-----------v----------+
                    |     Express API      |
                    | REST / validation    |
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
                                       v
                                +--------------+
                                | SMTP/Provider|
                                +--------------+
```

## Reliability model

PostgreSQL stores business state. Redis is used for queue coordination and distributed rate limiting. BullMQ owns delivery timing; the worker never sleeps with `setTimeout` to enforce schedule spacing.

Email processing uses this state machine:

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

Only one worker should observe an affected-row count of `1`, which prevents concurrent workers from independently claiming the same email.

The system uses at-least-once job processing. External email providers can accept a message immediately before a worker crashes, so the database cannot honestly guarantee exactly-once external delivery. Provider message IDs and deterministic job IDs provide best-effort deduplication.

## Rate limiting

Every sender has an hourly quota. The worker uses an atomic Redis counter with a UTC-hour bucket:

```text
email-rate:{senderId}:{YYYYMMDDHH}
```

When the quota is exhausted, the current slot is released and the email is scheduled for the next hour instead of using generic exponential retry. This keeps rate limiting separate from ordinary transient-failure retries.

## Bulk scheduling

Bulk requests calculate the schedule for every email explicitly:

```text
baseTime + (index * delayBetweenEmailsMs)
```

Example with a five-second delay:

```text
10:00:00 -> recipient 1
10:00:05 -> recipient 2
10:00:10 -> recipient 3
10:00:15 -> recipient 4
```

Each email receives a deterministic BullMQ job ID:

```text
email:{emailId}
```

The queue payload contains only the email ID and attempt metadata. The worker loads the full email from PostgreSQL instead of copying large email bodies into Redis.

## Repository structure

```text
reachinbox-email-scheduler/
├── apps/
│   ├── api/
│   │   └── src/index.ts
│   ├── worker/
│   │   └── src/index.ts
│   └── web/
│       └── src/app/
├── packages/
│   ├── database/
│   │   ├── prisma/schema.prisma
│   │   └── src/client.ts
│   ├── queue/
│   │   └── src/index.ts
│   └── shared/
│       └── src/index.ts
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
| Mail transport | Nodemailer / SMTP |
| Local infra | Docker Compose |

## Local setup

### 1. Prerequisites

- Node.js 20+
- pnpm 10+
- Docker Desktop or Docker Engine
- An SMTP account for real delivery, or an Ethereal account for safe development testing

### 2. Install dependencies

```bash
pnpm install
```

### 3. Start infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL on `localhost:5432` and Redis on `localhost:6379`.

### 4. Configure environment

```bash
cp .env.example .env
```

Update `SMTP_USER` and `SMTP_PASSWORD` when using authenticated SMTP.

### 5. Generate Prisma client and run migrations

```bash
pnpm db:generate
pnpm db:migrate
```

### 6. Start the services

```bash
pnpm dev
```

API: `http://localhost:5000`

Dashboard: `http://localhost:3000`

## API

### Health

```http
GET /health/live
GET /health/ready
```

### Schedule one email

```http
POST /api/emails
Content-Type: application/json
```

```json
{
  "senderId": "sender_id",
  "recipientEmail": "alice@example.com",
  "subject": "Hello",
  "body": "Message body",
  "scheduledAt": "2030-01-01T10:00:00.000Z"
}
```

### Schedule a batch

```http
POST /api/batches
Content-Type: application/json
```

```json
{
  "senderId": "sender_id",
  "recipients": [
    "alice@example.com",
    "bob@example.com",
    "carol@example.com"
  ],
  "subject": "Campaign",
  "body": "Campaign body",
  "scheduledAt": "2030-01-01T10:00:00.000Z",
  "delayBetweenEmailsMs": 5000
}
```

### Dashboard metrics

```http
GET /api/dashboard/stats
```

### List emails

```http
GET /api/emails
GET /api/emails?status=SENT
```

### Cancel a scheduled email

```http
DELETE /api/emails/:id
```

## Database model

The Prisma schema currently contains:

- `User`
- `Sender`
- `Batch`
- `Email`
- `OutboxEvent`

The outbox table is included as the foundation for evolving DB-to-queue publication into a transactional outbox publisher rather than relying on an unsafe dual-write assumption.

## Security and production hardening roadmap

The current core scheduler is implemented. The next production hardening phase should add:

- Google OAuth with secure server-side sessions
- Sender credential encryption / secret management
- Streaming CSV ingestion with validation and duplicate reporting
- Transactional outbox publisher
- Gmail API and Microsoft Graph provider adapters
- Per-user and per-endpoint authentication/authorization
- CSRF protection where cookie-based auth requires it
- Structured audit events
- Metrics/tracing
- Dockerfiles for API, worker, and web
- GitHub Actions for lint, typecheck, tests, Prisma validation, and builds
- Integration tests using PostgreSQL and Redis
- Provider-specific idempotency support where available

## Development commands

```bash
pnpm dev
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm db:generate
pnpm db:migrate
pnpm db:studio
```

## Important implementation notes

The worker intentionally does not use `setTimeout` for email spacing. Delays belong to BullMQ jobs.

Rate-limit exhaustion is explicitly delayed until the next UTC hour.

Transient provider errors are retried. Permanent failures are recorded as `FAILED` rather than being silently swallowed.

The API currently assumes a trusted internal `senderId` for the first vertical slice. User authentication and authorization are part of the next hardening phase and should be added before exposing the API publicly.
