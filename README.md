# RUBS Utility Billing

Utility bill-back app for property management using **RUBS** (Ratio Utility Billing System).
It runs entirely on free tiers: **GitHub** (code) + **Cloudflare Pages** (hosting) + **Pages Functions** (API) + **Cloudflare D1** (database).

## Features

- **Properties, units, tenants and utility split rules**: add, edit, delete. Tenants have name, email, phone, address, unit, account number, move-in and move-out dates, and number of occupants.
- **CSV tenant import** with flexible column names and MM/DD/YYYY or YYYY-MM-DD dates. Missing units are created automatically. Re-importing updates tenants by account number instead of duplicating them.
- **Per-property utility split rules ("set asides")**:
  - **Recovery %**: the share passed to residents. The rest is common area paid by the owner.
  - **Weighted split**: any mix of square footage, bedrooms, occupants and equal-per-unit.
  - **Vacancy handling**: the owner pays for vacant units, or the bill is split among occupied units only.
  - **Tax %** added on top of the share (e.g. 10% utility tax on water).
  - **Rent Manager charge code**.
- **Batch billing**: one **billing batch** per bill from the utility company. Enter every amount on the bill (Water, Sewer…), and one click runs RUBS for all of them and builds **one statement per resident**.
- **Proration by days occupied**. By default days are counted like the city bill (end date minus start date, so Oct 6 – Nov 3 = 28 days). A move-out and move-in on the same day never overlap.
- **PDF statements** in the property's own layout: header, account box, amount due, current charges, payment text, questions box and footer. Download one, or download all as a single PDF for printing.
- **Email statements** with the PDF attached, through your SMTP provider (e.g. Maileroo), with a progress bar. Each statement records sent or failed. Includes a **Send test email** button.
- **Rent Manager CSV export**: one row per charge (Water, Sewer, tax, fee) with its charge code. Optionally export only statements not exported before.
- **Admin dashboard** and a **resident portal** where residents see and download their statements, with a plain-English "How was this calculated?".

## How the RUBS math works

For each bill:

1. `billable = bill total × recovery %`
2. The billable amount is split into pools by the weights (e.g. 50% sq ft pool + 50% occupants pool).
3. In each pool, a resident's share = `factor × days occupied ÷ sum of (factor × days) for all units`.
   The factor is the unit's sq ft, its bedrooms, the tenant's occupants, or 1 for an equal split.
4. With **Owner absorbs vacant units**, vacant unit-days are included in the total, so the owner pays that share.
   With **Occupied only**, residents split 100% of the billable amount.
5. The admin fee is added per resident.

The engine is in [`lib/rubs.js`](lib/rubs.js) and tested in [`tests/rubs.test.js`](tests/rubs.test.js).

## Deploy (one-time setup, about 15 minutes)

You need a free GitHub account, a free Cloudflare account, and [Node.js](https://nodejs.org) installed on your computer.

1. **Put the code on GitHub.** Create an empty **private** repository on github.com, then from this folder run:
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/rubs-billing.git
   git push -u origin main
   ```
2. **Install the tools and log in to Cloudflare:**
   ```bash
   npm install
   npx wrangler login
   ```
3. **Create the database:**
   ```bash
   npx wrangler d1 create rubs-billing-db
   ```
   Copy the `database_id` it prints into `wrangler.toml`, replacing the zeros.
4. **Create the tables** (run this again whenever a new file appears in `migrations/`):
   ```bash
   npm run db:migrate:remote
   ```
5. **Commit the database ID and push:**
   ```bash
   git commit -am "Set D1 database id" && git push
   ```
6. **Connect Cloudflare Pages to GitHub.** In the Cloudflare dashboard, go to **Workers & Pages → Create → Pages → Connect to Git**, pick the repository, and use:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: **public**

   Pages reads the D1 binding (`DB`) from `wrangler.toml`. If the site says the binding is missing, add it under **Settings → Bindings → D1 database** with variable name `DB`, then redeploy.
7. Open your `*.pages.dev` URL. The first visit asks you to **create the admin account**.

After this, every `git push` redeploys automatically. You can add a custom domain under **Pages → Custom domains**.

### Recommended: protect the login endpoints

In Cloudflare go to **Security → WAF → Rate limiting rules** (the free plan includes one rule). Add a rule for URI path starts with `/api/auth/`, allowing 10 requests per minute per IP.

## Day-to-day workflow

**One-time setup**
1. **Settings → Company & email**: enter the company name and your SMTP details, then click **Send test email**.
   For Maileroo, copy the SMTP credentials of your sending domain (server `smtp.maileroo.com`, port 465 with SSL, or 587 with STARTTLS). The From email must use that domain.
2. **Properties → Add property**: fill in the address, office phone and email (printed on statements), days until due, and the Rent Manager property code.
3. On the property's **Utilities & split rules** tab, add each utility (Water, Sewer…) with its recovery %, split weights, tax % and RM charge code.
4. **Tenants → Import CSV** (see `public/tenant-import-template.csv`).

**Every billing cycle**
1. **Billing → New billing batch**: pick the property, enter the service period and the amount for each utility from the bill, then **Save & calculate**.
2. Review the statements (click **PDF** to preview any one), then click **Finalize statements**.
3. Click **Email statements**. For residents without an email, use **Download all PDFs** and print theirs.
4. Click **Export CSV for Rent Manager** and import the file into Rent Manager.
5. Moves: set the move-out date or add the new tenant before calculating. Proration is automatic.

**Fixing a mistake**
- **Wrong amount or dates:** if the batch is finalized, click **Reopen**. Then click **Edit bill** and recalculate.
- **Undo a whole batch:** click **Delete batch**. This removes the batch and every resident statement in it, including from the resident portal.
  - A finalized, emailed or exported batch asks you to type DELETE to confirm.
  - If the statements were already exported, download the **reversal CSV** first. It has the same charges with negative amounts. Import it into Rent Manager to cancel the charges there.
  - Emails that were already sent can't be recalled.

### Rent Manager CSV columns

`PropertyCode, Unit, TenantAccount, TenantName, ChargeType, Amount, TransactionDate, DueDate, Comment, PeriodStart, PeriodEnd`

Each statement line is one row: each utility uses its RM charge code, tax uses the property's tax code, and the fee uses the fee code. To rename or reorder the columns, edit `RM_CHARGE_COLUMNS` in `functions/api/[[path]].js`.

### Resident portal

Residents open the same URL and click **First time? Activate**. They enter their **account number** and the **email on file**, then choose a password. Residents only see finalized statements and can download them as PDFs. Staff can reset a resident's login from the Tenants page.

## Run locally

```bash
npm install
npm run db:migrate:local
npm run dev
```

Then open http://localhost:8788. To run the calculation tests: `npm test`.

## Free tier limits (more than enough for typical portfolios)

| Service | Free allowance |
|---|---|
| Cloudflare Pages | Unlimited static requests, 500 builds/month |
| Pages Functions (API) | 100,000 requests/day |
| D1 database | 5 GB storage, 5M rows read/day, 100k rows written/day |
| GitHub | Unlimited private repositories |

## Project layout

```
public/                 Front end (plain HTML/CSS/JS, no build step)
  js/admin.js           Admin dashboard
  js/billing.js         Billing batches, statements, email and settings screens
  js/resident.js        Resident dashboard
  js/shared/            PDF statement layout (used by both the server and the browser)
functions/api/          API router: [[path]].js
lib/rubs.js             RUBS calculation engine
lib/billing.js          Billing batches, statements, PDFs and email
lib/smtp.js             SMTP client (Cloudflare TCP sockets)
lib/settings.js         Company, SMTP and email template settings
lib/auth.js             Password hashing and sessions
migrations/        Database schema (D1)
tests/             Calculation tests
```

## Database backups

```bash
npx wrangler d1 export rubs-billing-db --remote --output backup.sql
```

D1 also keeps 30 days of point-in-time recovery ("Time Travel") on the free plan.
