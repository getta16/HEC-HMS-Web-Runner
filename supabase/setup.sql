-- Online projects for HEC-HMS Web Runner (web/cloud.js)
--
-- One-time setup:
-- 1. Create a free project at https://supabase.com
-- 2. SQL Editor → paste this file → Run
-- 3. Authentication → URL Configuration: set Site URL to the site address
--    (e.g. https://getta16.github.io/HEC-HMS-Web-Runner/) and add it to Redirect URLs
--    (also http://localhost:8000/ if you test locally)
-- 4. Project Settings → API: copy "Project URL" and the "anon public" key into web/cloud-config.js
--
-- Each user's files live under  hms-projects/<user id>/<project id>/ ; nobody else can read them.

insert into storage.buckets (id, name, public, file_size_limit)
values ('hms-projects', 'hms-projects', false, 52428800)   -- 50 MB per file (free plan limit)
on conflict (id) do nothing;

drop policy if exists "hms own read"   on storage.objects;
drop policy if exists "hms own insert" on storage.objects;
drop policy if exists "hms own update" on storage.objects;
drop policy if exists "hms own delete" on storage.objects;

create policy "hms own read" on storage.objects for select to authenticated
  using (bucket_id = 'hms-projects' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hms own insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'hms-projects' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hms own update" on storage.objects for update to authenticated
  using (bucket_id = 'hms-projects' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'hms-projects' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "hms own delete" on storage.objects for delete to authenticated
  using (bucket_id = 'hms-projects' and (storage.foldername(name))[1] = auth.uid()::text);
