-- Runs once, on the first start of a fresh volume, as the database owner. Core 6.0 refuses to start
-- outside Development as a superuser or a role with BYPASSRLS, so the API connects as this role. It
-- owns schema public, which is what the API needs on a new database. Test value only.
\getenv pw APP_DB_PASSWORD
CREATE ROLE barako_cli_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'pw';
ALTER SCHEMA public OWNER TO barako_cli_app;
