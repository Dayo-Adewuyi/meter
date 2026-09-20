import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';

export type UserStatus = 'active' | 'suspended' | 'deleted';
export type UserRole = 'customer' | 'operator' | 'admin';

type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

export interface IdentityUsersTable {
  id: ColumnType<string, string | undefined, never>;
  status: ColumnType<UserStatus, UserStatus | undefined, UserStatus>;
  roles: ColumnType<UserRole[], UserRole[] | undefined, UserRole[]>;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface IdentityExternalIdentitiesTable {
  provider: string;
  external_subject: string;
  user_id: string;
  provider_metadata: ColumnType<JsonValue, JsonValue | undefined, JsonValue>;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export type IdentityUser = Selectable<IdentityUsersTable>;
export type NewIdentityUser = Insertable<IdentityUsersTable>;
export type IdentityUserUpdate = Updateable<IdentityUsersTable>;
export type IdentityExternalIdentity = Selectable<IdentityExternalIdentitiesTable>;
export type NewIdentityExternalIdentity = Insertable<IdentityExternalIdentitiesTable>;
export type IdentityExternalIdentityUpdate = Updateable<IdentityExternalIdentitiesTable>;

// Generated-by-hand for now; swap to kysely-codegen once the schema settles.
// Money columns are NUMERIC(38,0) and arrive as strings — convert with @meter/contracts.
export interface DB {
  'identity.users': IdentityUsersTable;
  'identity.external_identities': IdentityExternalIdentitiesTable;
}
