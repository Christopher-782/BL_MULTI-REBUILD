# BL Multi Concept UI Refresh

This patch is UI-only. It does not change Supabase migrations, database rules,
maker-checker logic, transactions, loans, overdrafts, expenses, or reports.

## Branding

Logo / login hero source:

https://res.cloudinary.com/deoqw88yb/image/upload/v1777630347/ChatGPT_Image_May_1_2026_11_09_15_AM_wrclwq.avif

## Theme

The rebuilt pages now use the original application's palette:

- Navy: #0f172a
- Slate: #1e293b
- Blue: #3b82f6
- Violet accent: #8b5cf6
- Light application background for readability

## Improvements

- Real brand image replaces the temporary "BL" text blocks.
- Login is now a responsive split-screen hero layout.
- Sidebar uses the original dark navy/slate visual language.
- Proper slide-out mobile navigation.
- Responsive topbar/actions.
- Search/filter bars reflow cleanly across desktop/tablet/mobile.
- Search fields submit automatically after a short typing delay.
- Select filters submit immediately.
- Press `/` to focus the visible page search field.
- Table containers are keyboard-focusable and horizontally scrollable.
- Sidebar staff avatar is generated dynamically from the signed-in staff name.

## Install

Copy this overlay into the current Step 6 project and replace matching files.

No SQL migration is required for this UI patch.
