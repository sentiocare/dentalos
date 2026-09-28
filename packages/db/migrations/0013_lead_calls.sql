-- 0013: the assistant phones new leads (a first call within minutes, one more the next day), qualifies them
-- and books a consultation on the call. Outbound calls now say which lead they were for.
alter table public.calls drop constraint calls_purpose_check;
alter table public.calls add constraint calls_purpose_check check (purpose in ('confirm_appointment', 'lead_call'));
