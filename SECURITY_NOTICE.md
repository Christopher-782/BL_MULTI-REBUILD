# Security notice

A credential was present in an earlier project file and Git history. The file and local Supabase metadata are excluded from this release.

Before deployment, rotate the Supabase database password and remove the historical secret from any remote repository and existing clones. Do not place database passwords, service-role keys, or provider tokens in browser code.

The configured Supabase publishable key is designed to be visible in a browser. Its effective security boundary is the database privileges, row-level security policies, and controlled RPCs supplied by the migrations.
