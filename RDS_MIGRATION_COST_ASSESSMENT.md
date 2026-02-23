# Amazon RDS (PostgreSQL) Migration — Cost Assessment

## Current Architecture

| Component | Current | Cost |
|-----------|---------|------|
| Frontend | Vanilla JS (static HTML/CSS/JS) | **Free** (static hosting) |
| Backend/API | Google Apps Script (10 endpoints) | **Free** |
| Database | Google Sheets (4 sheets) | **Free** |
| Data size | ~700 rows, 35 KB CSV | Negligible |
| Auth | None (public access) | N/A |
| Total monthly cost | | **$0/mo** |

---

## Proposed Architecture

```
[Static Frontend]  →  [Backend Server (Node.js/Express)]  →  [Amazon RDS PostgreSQL]
   (S3/Vercel)              (EC2 / ECS / Lambda)                 (managed DB)
```

---

## 1. Amazon RDS PostgreSQL Costs

Your data is very small (~700 rows across 4 tables, <1 MB total). You don't need a large instance. Here are the realistic options:

### Option A: RDS db.t4g.micro (Smallest Production Instance)

| Resource | Spec | Monthly Cost (us-east-1) |
|----------|------|--------------------------|
| Instance | db.t4g.micro (2 vCPU, 1 GB RAM) | **~$12.10/mo** |
| Storage | 20 GB gp3 (minimum) | **~$2.30/mo** |
| Backup | 7-day retention (included) | **$0** |
| Data transfer | <1 GB/mo (internal VPC) | **$0** |
| **Subtotal** | | **~$14.40/mo** |

### Option B: RDS db.t4g.small (Recommended for Multi-User)

| Resource | Spec | Monthly Cost (us-east-1) |
|----------|------|--------------------------|
| Instance | db.t4g.small (2 vCPU, 2 GB RAM) | **~$24.82/mo** |
| Storage | 20 GB gp3 | **~$2.30/mo** |
| Backup | 7-day retention | **$0** |
| **Subtotal** | | **~$27.12/mo** |

### Option C: Aurora Serverless v2 (Pay-per-Use)

| Resource | Spec | Monthly Cost |
|----------|------|--------------|
| Compute | 0.5 ACU minimum (scales to demand) | **~$43.80/mo** minimum |
| Storage | Pay per GB-month | **~$0.10/mo** |
| I/O | Per-request pricing | **~$0.20/mo** |
| **Subtotal** | | **~$44.10/mo** |

> Aurora Serverless is overkill for this workload. Not recommended.

### Option D: RDS Free Tier (First 12 Months Only)

| Resource | Spec | Monthly Cost |
|----------|------|--------------|
| Instance | db.t3.micro or db.t4g.micro | **$0** (750 hrs/mo free) |
| Storage | 20 GB gp2 | **$0** (20 GB free) |
| Backup | 20 GB | **$0** |
| **Subtotal** | | **$0/mo for 12 months** |

> If this is a new AWS account, you get 12 months free. After that, it reverts to Option A pricing.

---

## 2. Backend Server Costs

You need a server to wrap the PostgreSQL connection and expose a REST API. Options:

### Option A: EC2 t4g.micro (Always-On Server)

| Resource | Spec | Monthly Cost |
|----------|------|--------------|
| Instance | t4g.micro (2 vCPU, 1 GB RAM, ARM) | **~$6.05/mo** |
| EBS storage | 8 GB gp3 | **~$0.64/mo** |
| Elastic IP | 1 (if instance running) | **$0** |
| **Subtotal** | | **~$6.69/mo** |

### Option B: AWS Lambda + API Gateway (Serverless)

| Resource | Spec | Monthly Cost |
|----------|------|--------------|
| Lambda | 128 MB, ~100ms avg per request | **$0** (free tier: 1M req/mo) |
| API Gateway | HTTP API | **~$1.00/mo** (at 100K req/mo) |
| **Subtotal** | | **~$1.00/mo** |

> Lambda is the cheapest option for your scale. Your calendar app will likely make <50K requests/month even with multiple users. Lambda + API Gateway stays within or near free tier.

### Option C: ECS Fargate (Container-Based)

| Resource | Spec | Monthly Cost |
|----------|------|--------------|
| Task | 0.25 vCPU, 0.5 GB RAM (always-on) | **~$9.47/mo** |
| **Subtotal** | | **~$9.47/mo** |

### Option D: Free/Cheap Alternatives (Non-AWS)

| Platform | Monthly Cost | Notes |
|----------|-------------|-------|
| Railway.app | **$5/mo** (Hobby) | Node.js + PostgreSQL included |
| Render.com | **$0-7/mo** | Free tier available (spins down) |
| Fly.io | **$0-5/mo** | Generous free tier |
| Supabase | **$0/mo** (free tier) | Managed PostgreSQL + REST API auto-generated |

---

## 3. Additional Infrastructure Costs

| Component | Cost | Notes |
|-----------|------|-------|
| VPC / Security Groups | $0 | Free |
| Route 53 (DNS) | ~$0.50/mo | Per hosted zone |
| ACM (SSL cert) | $0 | Free for AWS resources |
| CloudWatch (basic) | $0 | Basic monitoring included |
| ALB (if needed) | ~$16.20/mo | Only if you need load balancing |
| NAT Gateway | ~$32.40/mo | Only if Lambda/private subnet needs internet |
| Secrets Manager | ~$0.40/mo | For DB credentials |

> **Warning**: A NAT Gateway alone costs ~$32/mo. Keep your Lambda/backend in a public subnet or use VPC endpoints to avoid this.

---

## 4. Recommended Architecture Tiers

### Tier 1: Minimum Viable (Cheapest)
**Best for: 1-20 concurrent users, testing/MVP**

| Component | Choice | Cost |
|-----------|--------|------|
| Database | RDS db.t4g.micro | $14.40 |
| Backend | Lambda + API Gateway | $1.00 |
| Frontend | S3 + CloudFront | $0.50 |
| DNS | Route 53 | $0.50 |
| **Total** | | **~$16.40/mo** |

### Tier 2: Comfortable Production
**Best for: 20-100 concurrent users**

| Component | Choice | Cost |
|-----------|--------|------|
| Database | RDS db.t4g.small | $27.12 |
| Backend | EC2 t4g.micro | $6.69 |
| Frontend | S3 + CloudFront | $1.00 |
| DNS + SSL | Route 53 + ACM | $0.50 |
| **Total** | | **~$35.31/mo** |

### Tier 3: Fully Managed / Non-AWS Alternative
**Best for: Simplicity, minimal ops**

| Component | Choice | Cost |
|-----------|--------|------|
| Full stack | Supabase (free tier) | $0 |
| Frontend | Vercel / Netlify (free) | $0 |
| **Total** | | **$0/mo** (within free limits) |

| Component | Choice | Cost |
|-----------|--------|------|
| Full stack | Supabase Pro | $25/mo |
| Frontend | Vercel Pro | $20/mo |
| **Total** | | **$45/mo** |

---

## 5. PostgreSQL Schema (What You'd Migrate To)

Based on your current Google Sheets structure:

```sql
-- Calendar entries (currently ~700 rows, main 'data' sheet)
CREATE TABLE calendar_entries (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    date        DATE NOT NULL,
    status      VARCHAR(20) NOT NULL CHECK (status IN ('activity','home','switch-home','switch-base')),
    note        TEXT DEFAULT '',
    association VARCHAR(100) DEFAULT '',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(name, date)
);

-- Roster configuration (key-value, currently 'roster_config' sheet)
CREATE TABLE roster_config (
    key   VARCHAR(100) PRIMARY KEY,
    value TEXT NOT NULL
);

-- Roster shifts (currently 'roster_shifts' sheet)
CREATE TABLE roster_shifts (
    id           VARCHAR(50) PRIMARY KEY,
    date         DATE NOT NULL,
    mission_type VARCHAR(100),
    start_time   TIME,
    end_time     TIME,
    note         TEXT DEFAULT ''
);

-- Roster assignments (currently 'roster_assignments' sheet)
CREATE TABLE roster_assignments (
    id          SERIAL PRIMARY KEY,
    shift_id    VARCHAR(50) REFERENCES roster_shifts(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    role        VARCHAR(50) DEFAULT 'member',
    is_manual   BOOLEAN DEFAULT FALSE,
    assigned_at TIMESTAMPTZ DEFAULT NOW()
);

-- Optional: Users table (for multi-user auth)
CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    email         VARCHAR(255) UNIQUE NOT NULL,
    display_name  VARCHAR(100),
    role          VARCHAR(20) DEFAULT 'viewer' CHECK (role IN ('admin','editor','viewer')),
    password_hash VARCHAR(255),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

**Storage estimate**: Even with 100 users x 365 days x 4 tables, you'd use <50 MB. This is a tiny database.

---

## 6. Development Work Required

To migrate, you'd need to build:

| Task | Description |
|------|-------------|
| **PostgreSQL schema** | Create tables, indexes, constraints (shown above) |
| **Data migration script** | One-time CSV/Sheets → PostgreSQL import |
| **Backend API server** | Node.js/Express (or Python/FastAPI) with ~10 REST endpoints matching current Apps Script actions |
| **Database connection pool** | pg library with connection pooling (or pgBouncer for Lambda) |
| **Authentication** | JWT or session-based auth (currently none exists) |
| **Frontend API refactor** | Update fetch calls to point to new backend URL instead of Apps Script URL |
| **Environment config** | .env files, secrets management |
| **CORS setup** | Backend CORS configuration |
| **Deployment pipeline** | CI/CD for backend + frontend |

---

## 7. Cost Comparison Summary

| Scenario | Monthly Cost | Annual Cost |
|----------|-------------|-------------|
| **Current (Google Sheets + Apps Script)** | $0 | $0 |
| **AWS Minimum (Lambda + RDS micro)** | ~$16 | ~$192 |
| **AWS Comfortable (EC2 + RDS small)** | ~$35 | ~$420 |
| **AWS with ALB + NAT** | ~$85 | ~$1,020 |
| **Supabase Free Tier** | $0 | $0 |
| **Supabase Pro** | $25 | $300 |
| **Railway Hobby** | $5 | $60 |
| **AWS Free Tier (first year only)** | $0-7 | ~$42 |

---

## 8. Recommendation

Given your current scale (~700 rows, <20 users anticipated):

**If you want AWS specifically:**
- Start with **RDS Free Tier** (db.t4g.micro) + **Lambda** = ~$0-7/mo for the first year
- After free tier expires: ~$16/mo

**If you want the easiest path:**
- **Supabase** gives you PostgreSQL + auto-generated REST API + auth + realtime — for **$0/mo** on free tier
- You wouldn't even need to write a backend server; Supabase generates the API from your schema
- Your frontend would call Supabase's JS client directly

**If you want full control + cheapest long-term:**
- **Railway** or **Render** at **$5-7/mo** with PostgreSQL included
- Write a simple Express/Fastify backend (translating your 10 Apps Script endpoints)

### Do you actually need RDS?

For your data volume (~700 rows, 35 KB), RDS is overprovisioned. The minimum RDS instance gives you 20 GB storage and can handle thousands of connections — you'll use <0.1% of its capacity. The cost floor of ~$14/mo is the price of *having a managed PostgreSQL instance running 24/7*, regardless of whether anyone uses it.

Consider whether **Supabase** (free PostgreSQL + API + auth) or a **$5/mo PaaS** would serve you better before committing to AWS infrastructure.
