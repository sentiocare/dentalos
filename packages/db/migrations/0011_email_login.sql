-- 0011: staff sign in with a code sent to their email instead of an SMS code. Email codes need no SMS
-- provider or DLT registration. Staff are invited by email; the phone number stays on the membership as
-- a contact number only (WhatsApp alerts, test mode).

alter table public.clinic_memberships add column invited_email text
  check (invited_email is null or invited_email = lower(invited_email));
alter table public.clinic_memberships add constraint clinic_memberships_invited_email_key unique (clinic_id, invited_email);
alter table public.clinic_memberships drop constraint clinic_memberships_check;
alter table public.clinic_memberships add constraint clinic_memberships_check
  check (user_id is not null or invited_phone is not null or invited_email is not null);

-- Creates the user row on first sign-in and claims the memberships created for this email (or phone).
create or replace function app.ensure_user(p_phone text, p_email text, p_name text) returns void
language plpgsql security definer set search_path = public, app
as $$
declare
  uid uuid := app.current_user_id();
  mail text := lower(p_email);
begin
  if uid is null then
    raise exception 'app.user_id is not set';
  end if;
  insert into public.users (id, phone, email, name)
  values (uid, p_phone, mail, p_name)
  on conflict (id) do update
    set phone = coalesce(excluded.phone, public.users.phone),
        email = coalesce(excluded.email, public.users.email);
  if mail is not null then
    update public.clinic_memberships set user_id = uid
    where invited_email = mail and user_id is null
      and not exists (select 1 from public.clinic_memberships x
                      where x.clinic_id = clinic_memberships.clinic_id and x.user_id = uid);
  end if;
  if p_phone is not null then
    update public.clinic_memberships set user_id = uid
    where invited_phone = p_phone and user_id is null
      and not exists (select 1 from public.clinic_memberships x
                      where x.clinic_id = clinic_memberships.clinic_id and x.user_id = uid);
  end if;
end
$$;
