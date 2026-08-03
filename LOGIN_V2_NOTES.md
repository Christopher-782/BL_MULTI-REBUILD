# BL Multi Concept — Premium Login V2

This version follows the supplied login upgrade brief and keeps the existing
Supabase/auth architecture.

## Background

The login panel is intentionally NOT white.

Current surfaces:
- Page background: cool blue-grey
- Login panel: soft blue-grey
- Inputs: muted blue-grey
- Trust strip: slightly darker neutral blue
- Left visual: deep navy / dark blue

## Preserved IDs

- loginForm
- email
- password
- togglePassword
- formMessage
- loginButton
- dynamicGreeting
- portalTime
- portalDate

## Preserved integration

- @supabase/supabase-js@2
- ./assets/js/auth/login.js
- existing Supabase client configuration
- profiles role/status check
- dashboard redirect

## Improvements

- One-second browser-local clock
- Dynamic morning/afternoon/evening/late-night greeting
- Premium operations dashboard preview
- Subtle chart line + bar motion
- Very light background particles
- Proper eye / eye-off SVG state
- Inline validation
- Loading state with "Signing in..."
- Success state with "Access granted"
- Duplicate-submission prevention
- Improved Supabase error messages
- Responsive 1440 / 1200 / 1024 / 768 / 480 / 375 layouts
- prefers-reduced-motion support

## Install

Replace only:

- login.html
- assets/css/auth.css
- assets/js/ui/login-ui.js
- assets/js/auth/login.js

No SQL migration is required.
