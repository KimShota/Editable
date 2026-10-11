-- Every account must confirm its email now, admins included (they used to be
-- exempt because they were made by tool and never verified). Mark the
-- existing admins as verified, or they would be held at "check your inbox"
-- for a mail they never asked for. The is_admin flag stays: it still decides
-- who reaches the Admin sections.
update users set email_verified_at = now() where is_admin and email_verified_at is null;
