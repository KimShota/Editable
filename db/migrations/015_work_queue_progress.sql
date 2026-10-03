-- What a running job is doing right now, for the app's progress UI
-- (plan/ui-ux-full-flow.md, section 2.4): { stage, done, total, message }.
-- Written by the handler as it works; read by /api/tasks/<id>.
alter table work_queue add column if not exists progress jsonb;
