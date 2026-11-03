-- Anti-abuse (§8): Turnstile on the first web refresh of each UTC day. `turnstile_day` is the last
-- UTC day ('YYYY-MM-DD') this account passed a Turnstile check (sign-up or a refresh). NULL means
-- never, so the next web refresh asks for one.
ALTER TABLE accounts ADD COLUMN turnstile_day TEXT;
