-- Schema ownership documents domain boundaries (§11.1).
create schema if not exists identity;
create schema if not exists compliance;
create schema if not exists funding;
create schema if not exists ledger;
create schema if not exists catalog;
create schema if not exists pricing;
-- doc §11.1 calls this `authorization`; that word is reserved in PostgreSQL,
-- so it would need double quotes in every query. Named `authz` instead.
create schema if not exists authz;
create schema if not exists usage;
create schema if not exists settlement;
create schema if not exists operations;
create schema if not exists jobs;
