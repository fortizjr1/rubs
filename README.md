# RUBS Utility Billing

Utility bill-back app for property management using **RUBS** (Ratio Utility Billing System).
It runs entirely on free tiers: **GitHub** (code) + **Cloudflare Pages** (hosting) + **Pages Functions** (API) + **Cloudflare D1** (database).

## Features

- **Properties, units, tenants, utilities and bills** can all be added, edited and deleted.
- **Tenants**: name, email, phone, address, unit, account number, move-in and move-out dates, and number of occupants.
- **CSV tenant import** with flexible column names and MM/DD/YYYY or YYYY-MM-DD dates. Missing units are created automatically. Re-importing updates tenants by account number instead of creating duplicates.
- **Per-property utility split rules ("set asides")**:
  - **Recovery %**: the share of the bill passed to residents. The rest is common area paid by the owner.
  - **Weighted split**: any mix of square footage, bedrooms, number of occupants and equal-per-unit (e.g. 50% sq ft + 50% occupants).
  - **Vacancy handling**: the owner absorbs vacant units, or the bill is split among occupied units only.
  - **Admin/billing fee**: a flat amount added to each resident's charge.
  - **Rent Manager charge code**.
- **Proration**: each resident is billed only for the days they occupied the unit during the service period. Move-in and move-out days both count as occupied.
- **Exact cents**: rounding always adds up to the billable amount.
- **Bill workflow**: enter the bill from the utility company → **Calculate** → review → **Post** (residents can then see it) → **Export**.
- **Rent Manager CSV export** of posted charges, with an option to export only charges not exported before. Properties, units, tenants, utilities and bills can also be exported to CSV.
- **Admin dashboard**: counts, upcoming move-ins and move-outs, bills not yet posted, charges not yet exported, and year-to-date recovery rate.
- **Resident dashboard**: account and unit info, charge history, and a plain-English "How was this calculated?" for each charge.

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
4. **Create the tables:**
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

1. **Properties → Add property.** Fill in the Rent Manager property code.
2. On the property's **Utilities & split rules** tab, add each utility (Water, Sewer, Trash…) with its recovery %, weights, fee and RM charge code.
3. **Tenants → Import CSV** (see `public/tenant-import-template.csv`), or add tenants one at a time. Fill in the unit square footage and bedrooms if you split by those.
4. When a bill arrives: **Utility Bills → Add utility bill** → enter the total and service period → **Calculate** → review → **Post**.
5. **Export to Rent Manager → Download CSV**, then import it into Rent Manager.
6. Moves: use **Move out** on a tenant, or add the new tenant with their move-in date. The next calculation prorates automatically.

### Rent Manager CSV columns

`PropertyCode, Unit, TenantAccount, TenantName, ChargeType, Amount, TransactionDate, Comment, PeriodStart, PeriodEnd, UtilityShare, AdminFee`

Map these in your Rent Manager import template. To rename or reorder the columns, edit `RM_CHARGE_COLUMNS` in `functions/api/[[path]].js`.

### Resident portal

Residents open the same URL and click **First time? Activate**. They enter their **account number** and the **email on file**, then choose a password. Residents only see charges from posted bills. Staff can reset a resident's login from the Tenants page.

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
public/            Front end (plain HTML/CSS/JS, no build step)
  js/admin.js      Admin dashboard
  js/resident.js   Resident dashboard
functions/api/     API, a single router: [[path]].js
lib/rubs.js        RUBS calculation engine
lib/auth.js        Password hashing and sessions
migrations/        Database schema (D1)
tests/             Calculation tests
```

## Database backups

```bash
npx wrangler d1 export rubs-billing-db --remote --output backup.sql
```

D1 also keeps 30 days of point-in-time recovery ("Time Travel") on the free plan.
