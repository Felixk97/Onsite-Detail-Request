LifeCare Onsite Screening - Netlify project

Folder layout (keep exactly as is, at the ROOT of your GitHub repo):
  netlify.toml
  package.json
  netlify/functions/api.mjs   <- backend (Netlify Function + Netlify Blobs)
  public/index.html           <- staff form (open with /?c=<company id>)
  public/admin.html           <- admin page (/admin.html, needs ADMIN_CODE)

Setup:
  1. Netlify > Site configuration > Environment variables > add ADMIN_CODE (long code).
  2. Deploys > Trigger deploy > Deploy site (needed after setting/changing the variable).
  3. Open /admin.html, log in, add a company, copy its link, give it to staff.

Notes:
  - Data is stored in Netlify Blobs and is not removed by redeploying.
  - Export a CSV from admin before big changes, as a backup.

Admins:
  - ADMIN_CODE (Netlify environment variable) is the MASTER admin code: full access.
  - The master can add sub-admins in the admin page (Admins panel). Each gets their own
    code, access to chosen companies only, and optional permissions. Codes are shown once.
