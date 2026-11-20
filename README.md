# RUBS Utility Billing

Utility bill-back app for property management using **RUBS** (Ratio Utility Billing System).
It runs entirely on free tiers: **GitHub** (code) + **Cloudflare Pages** (hosting) + **Pages Functions** (API) + **Cloudflare D1** (database).

## Features

- **Properties, units, tenants and utility split rules**: add, edit, delete. Tenants have name, email, phone, address, unit, account number, move-in and move-out dates, and number of occupants.
- **CSV unit import**: one row per unit (Property short name, Unit, Sq Ft, Bedrooms, Bathrooms, Notes). Unit numbers are matched ignoring case, so existing units are updated instead of duplicated.
- **CSV tenant import** (Property short name, Unit, Account Number, name and Move In required on every row) with flexible column names and MM/DD/YYYY or YYYY-MM-DD dates. Missing units are created automatically. Re-importing updates tenants by account number instead of duplicating them.
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
3. On the property's **Utilities & fixed charges** tab, set up two kinds of charges:
   - **Utility bill (split with RUBS)**: the utilities on the utility company's bill, usually Water and Sewer. The form mirrors Rent Manager's RUBS Template:
     - **Tenant contribution %**.
     - **Allocation**: divide evenly across all units, divide evenly across occupied units only, or choose allocation factors.
     - **Factors**: Occupancy, Square Feet, Bedrooms and Bathrooms, with percentages that must total 100%.
       - Square Feet, Bedrooms and Bathrooms each use either all units (the owner pays vacant units' share) or occupied units only.
       - Occupancy only counts occupied units, using the People field. **Count people as** sets the weighting: headcount, Conservice factored (1.0 / 1.6 / 1.9 / 2.2, +0.3 each additional), 1.0 + 0.5 per additional, or capped at 2.
     - **Test calculation** runs the rule on a sample bill with the current units and residents, so you can compare it with Rent Manager's Test Calculation.
     - If the bill includes a tax that should be split the same way (e.g. the City's public service tax on water), add it as its own utility with the same rule and 0% "Tax added".
   - **Fixed monthly charges**: Trash, Pest Control, Internet, Cable and so on, with an amount per resident (optionally prorated by days lived there). Every batch adds them automatically.
   - **Show on statement as** combines charges into one statement line and one Rent Manager row, e.g. Water + Sewer → "Water & Sewer", or Internet + Pest Control + Trash → "Amenity Fee". The combined line uses the RM charge code of its first charge.
4. On the property's **Units** tab, click **Import CSV** to load every unit, including vacant ones, with its square footage, bedrooms and bathrooms (see `public/unit-import-template.csv`). Re-importing updates existing units, and blank cells keep their current values.
5. **Tenants → Import CSV** (see `public/tenant-import-template.csv`).

**Every billing cycle**
1. **Billing → New billing batch**: pick the property, enter the service period and the amount for each utility from the bill, then **Save & calculate**. The property's fixed monthly charges are included automatically; untick one only if it's already billed in another batch for the same period.
2. Review the statements (click **PDF** to preview any one), then click **Finalize statements**.
3. Click **Email statements**. For residents without an email, use **Download all PDFs** and print theirs.
4. Click **Export CSV for Rent Manager** and import the file into Rent Manager.
5. Moves: set the move-out date or add the new tenant before calculating. Proration is automatic.

**Fixing an import**
- Every import requires the **Property** column with the property's short name (its Rent Manager code). Tenant imports also need an **Account Number** on every row.
- **Import history → Undo** (Tenants page or a property's Units tab) deletes the tenants and units an import created. Changes it made to existing records are not reversed.
- To remove many records at once, tick the checkboxes (or the header box to select all) and click **Delete selected**. Tenants with billing statements and units that have tenants are kept, and the reason is shown.

**Selling a property**
- Open the property and click **Mark inactive**, then enter the date and a reason such as "Sold".
- It is hidden from the Properties list (see the **Inactive** filter), the Dashboard counts, the Tenants page and the pickers for new tenants, units and imports.
- Billing history, statements and exports are kept. You can still create a final billing batch for it, and its residents can still see past statements.
- Click **Reactivate** to undo.

**Number of people per unit**
- On the Tenants page, type each tenant's number straight into the **People** column. It saves when you press Enter or Tab and shows a ✓. Esc undoes your typing. Re-importing from Rent Manager with an Occupants column also updates it.

**Move-outs and final bills**
- The app has no live link to Rent Manager. It knows about a move-out once the date is entered:
  - **Move out** on a tenant row,
  - **Edit selected** (mass edit: the same move-out date or number of people for many tenants), or
  - re-importing your tenant list from Rent Manager. Tenants are matched by account number, so Move Out and Occupants are updated. Doing this before each billing cycle is the easiest routine.
- A statement is the resident's **final bill** when their move-out date falls within the batch's service period. The PDF says "FINAL UTILITY STATEMENT", shows the move-out date and prints the **forwarding address** if one is entered. The email subject starts with "FINAL BILL -".
- **Final bills pending** (Dashboard tile, and the Tenants filter) lists residents who moved out in the last 90 days whose move-out isn't covered by a finalized batch yet.

**Fixing a mistake**
- **Wrong amount or dates:** if the batch is finalized, click **Reopen**. Then click **Edit bill** and recalculate.
- **Undo a whole batch:** click **Delete batch**. This removes the batch and every resident statement in it, including from the resident portal.
  - A finalized, emailed or exported batch asks you to type DELETE to confirm.
  - If the statements were already exported, download the **reversal CSV** first. It has the same charges with negative amounts. Import it into Rent Manager to cancel the charges there.
  - Emails that were already sent can't be recalled.

### Rent Manager CSV columns

`PropertyCode, Unit, TenantAccount, TenantName, ChargeType, Amount, TransactionDate, DueDate, Comment, PeriodStart, PeriodEnd`

Lines on the same statement that share a charge code are combined into one row. For example, Water, Sewer and Utility tax all coded UTIL become a single UTIL charge per resident. Each resident's share is rounded to the penny, and the owner's share absorbs any rounding difference. To rename or reorder the columns, edit `RM_CHARGE_COLUMNS` in `functions/api/[[path]].js`.

### Log in as a resident (staff preview)

Any staff member can see the portal exactly as a resident does. Click **Log in as a resident** in the sidebar and search for the resident, or click **View as resident** on a tenant row.
- An orange banner shows whose portal you're viewing. Click **Back to staff view** to return.
- The preview is read-only: residents' passwords and phone numbers can't be changed from it.
- It ends after 2 hours.
- It works even if the resident hasn't activated their portal.

### Resident portal security

- The **Signed up** column shows whether the resident created their own portal login (Yes + date, or No). Filter the Tenants list by "Signed up for portal" / "Not signed up" to see who still hasn't. **Reset login** sets it back to No.
- The Tenants list **Portal** column shows whether a resident has activated their account, plus their **last sign-in time and IP address**. Staff previews ("Log in as a resident") are not counted.
- **Lock** signs the resident out right away and blocks signing in and re-activating ("This account is locked. Please contact the office."). It takes an optional staff-only reason. **Unlock** restores access with the same password.
- Locking only affects portal access. Billing, statements and emails continue as normal. Staff can still preview a locked account.

### Resident portal

Residents open the same URL and click **First time? Activate**. They enter their **account number** and the **email on file**, then choose a password. Residents only see finalized statements and can download them as PDFs. If **Settings → Company & email → Online payment link** is filled in (your Rent Manager Tenant Web Access address), the portal shows a **Pay online** button that opens it in a new tab, and every statement email gets a **Pay online** button and link (or put {pay_link} in the message). The app itself does not take payments or know balances. Staff can reset a resident's login from the Tenants page.

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
