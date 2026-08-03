# BL Multi Concept - Render Deployment

This package is deployment-safe for Render.

## What is published

Only the `public/` directory is served to website visitors. It contains the HTML, CSS, and browser JavaScript required by the application.

The original Supabase SQL migrations, internal markdown notes, `.vscode` settings, and local project notes are intentionally excluded from the public site.

## Render settings

This repository already contains `render.yaml`:

- Runtime: Static
- Publish path: `./public`
- Build command: no build required
- Auto deploy: enabled

## Deployment

1. Create a GitHub repository.
2. Upload everything in this deployment package to the repository root.
3. In Render choose **New > Static Site** or create a Blueprint from the repository.
4. Connect the GitHub repository.
5. If Render reads `render.yaml`, approve the configuration.
6. If configuring manually, use:
   - Build Command: `echo "BL Multi Concept static site - no build required"`
   - Publish Directory: `public`
7. Deploy.

## Supabase after deployment

After Render gives you your production URL, update Supabase Authentication URL Configuration:

- Site URL: `https://YOUR-SITE.onrender.com`
- Redirect URL: `https://YOUR-SITE.onrender.com/accept-invite.html`

If you use any other email/password-reset redirect paths, add those exact production URLs too.

## Security

The Supabase browser publishable key is expected to be present in the frontend. Do not place a Supabase secret/service-role key anywhere in `public/`.

## Known route

The current application still links to `reconciliation.html`, but that page is not present in the current project. That route will return 404 until the reconciliation feature is added.
