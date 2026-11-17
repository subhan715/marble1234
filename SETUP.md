# Diamond Marble & Granite – online version (GitHub + Supabase)

Your pages live on GitHub (free). Your DATA lives in a free online database (Supabase),
so every computer and phone sees the same stock, orders and invoices.
Nobody can see or change anything without the login you create in Step 4.

## Step 1 – Create the database project (5 minutes)
1. Go to https://supabase.com , click **Start your project**, sign in (GitHub or Google works).
2. Click **New project**. Name: `diamond`. Make up a **Database Password** and save it somewhere (you will not need it day to day).
3. Region: choose the closest one (e.g. **Mumbai / South Asia**). Plan: **Free**. Click **Create new project** and wait 1–2 minutes.

## Step 2 – Create the tables (2 minutes)
1. In Supabase click **SQL Editor** (left menu) → **New query**.
2. Open the file `setup.sql` from this folder with Notepad, press `Ctrl+A`, `Ctrl+C`.
3. Paste it into the Supabase query box and click **Run**. It must say **Success**.

## Step 3 – Create the login and close the doors (3 minutes)
1. Left menu **Authentication → Users → Add user → Create new user**.
   - Email: `dilawar@diamondmarble.app`  (this is just a name; no real email is needed)
   - Password: choose a strong password (this is the password you will type on the website)
   - Tick **Auto Confirm User**, click **Create user**.
   - For each extra staff member repeat with e.g. `ali@diamondmarble.app`. They type only `ali` on the login page.
2. **Important:** Authentication → **Sign In / Providers** (or "Providers" → Email) → turn **OFF "Allow new users to sign up"** and save. This stops strangers from creating their own login.

## Step 4 – Copy two values into config.js (3 minutes)
1. In Supabase open **Project Settings (gear) → API** (or "API Keys" / "Data API").
2. Copy the **Project URL** (looks like `https://abcdxyz.supabase.co`).
3. Copy the **anon public key** (a very long text; newer projects call it the **publishable key**).
   NEVER use the "service_role" or "secret" key.
4. Open `config.js` in Notepad and replace the two PASTE texts (keep the quotes), save.

## Step 5 – Upload to GitHub
1. In your GitHub repository click **Add file → Upload files**.
2. Select ALL files from this folder (there are no sub-folders) and drag them in. Same-named files are replaced.
3. Delete the old file `db.js` from the repository (open it → the ⋯ menu → Delete file → Commit).
4. Click **Commit changes**. Make sure Settings → Pages is "Deploy from a branch → main → / (root)".
5. After 1–2 minutes open `https://YOUR-NAME.github.io/YOUR-REPO/` and press `Ctrl+Shift+R`.

## Step 6 – First use
- Log in with `dilawar` and your password from Step 3.
- Moving your old data? Go to **Backup & Restore → Restore** and choose the `.db` backup file from the old Windows app
  (or from the first GitHub version). The "Backup Password" box asks for your login password.

## Good to know
- **Backup password = your login password.** Download a backup from the Backup page regularly (e.g. every month).
- Supabase's free plan **pauses a project that nobody used for 7 days**. If that happens open supabase.com → your project → **Restore project**. Using the app weekly avoids it.
- The `URL` and `anon key` in config.js are public by design. Your data is protected by the login and the rules created by `setup.sql`.
- Forgot the password? Supabase → Authentication → Users → ⋯ next to the user → **Send password recovery** or delete & recreate the user.
- If the page shows red text under "Loading…", it names the file that is missing or the error.
