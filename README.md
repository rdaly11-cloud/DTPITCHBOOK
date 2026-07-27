# Pitch Book

A shared pitch-booking schedule for the club, so any coach can see who's got which
pitch, when, before they book on top of someone.

This is a normal website (React + Vite), backed by a free Supabase database so every
coach sees the same live schedule from their own phone.

## 1. Create the database (Supabase — free)

1. Go to https://supabase.com, sign up, and create a new project (pick any name/region).
2. Wait for it to finish provisioning (~1–2 minutes).
3. In the left sidebar, open **SQL Editor** → **New query**.
4. Paste in the entire contents of `supabase.sql` from this folder, and click **Run**.
   This creates the `pitches` and `bookings` tables and two starter pitches.
5. In the left sidebar, open **Project Settings** → **API**. You'll need two values
   from this page in step 3 below:
   - **Project URL**
   - **anon public** key

## 2. Run it locally to check it works (optional but recommended)

You'll need Node.js installed (https://nodejs.org, the LTS version).

```
npm install
cp .env.example .env
```

Open `.env` and paste in your Project URL and anon key from step 1.5. Then:

```
npm run dev
```

Open the URL it prints (usually `http://localhost:5173`) and confirm you can book a
pitch and see it appear.

## 3. Put the code on GitHub

1. Create a free GitHub account if you don't have one: https://github.com
2. Create a new empty repository (e.g. `pitch-book`).
3. Upload this whole folder to it — either via GitHub's "upload files" button in the
   browser, or with git:

```
git init
git add .
git commit -m "Pitch Book"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/pitch-book.git
git push -u origin main
```

Your `.env` file is deliberately **not** uploaded (see `.gitignore`) — the keys go
into Vercel directly instead, in the next step.

## 4. Deploy it (Vercel — free)

1. Go to https://vercel.com and sign up using your GitHub account.
2. Click **Add New → Project**, and pick the `pitch-book` repo you just pushed.
3. Vercel auto-detects it's a Vite app — leave the build settings as default.
4. Before clicking Deploy, open **Environment Variables** and add:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon public key
5. Click **Deploy**. After a minute you'll get a live URL like
   `pitch-book-yourname.vercel.app` — share that with the other coaches.

## 5. Optional: use your own domain

In the Vercel project, go to **Settings → Domains** and add a domain you've bought
(e.g. from Namecheap or similar, ~£10–15/year), then follow Vercel's instructions to
point its DNS at Vercel. No code changes needed.

## Good to know

- There's no login. Anyone with the link can view and book pitches — like a shared
  noticeboard. Don't put anything sensitive in the notes field.
- If you ever want proper coach accounts (so only signed-in coaches can book, or you
  can see who edited what), that's a bigger change — Supabase Auth handles it and
  Claude can help wire it up when you're ready.
- Whenever you want to change how the app looks or behaves, come back here with this
  code and describe the change.
