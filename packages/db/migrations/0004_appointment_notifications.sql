-- 0004: what the patient has been told about each appointment, so confirmations, reschedule and
-- cancellation notices are sent exactly once whoever made the change (staff, WhatsApp, voice, import).

alter table public.appointments
  add column notified_starts_at timestamptz,
  add column cancellation_notified_at timestamptz;

create index appointments_to_notify on public.appointments (clinic_id, starts_at)
  where status in ('booked', 'confirmed', 'cancelled');
